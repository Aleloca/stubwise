import { createReadStream } from "node:fs";
import { open, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { driveContentKindOf, type DriveContentOcr, type DriveContentReason } from "@stubwise/shared";
import type { Exec, ExecResult } from "./exec.js";
import { imageSize } from "./image.js";
import { EXTRACT_LIMITS as L } from "./limits.js";
import { extractOffice } from "./office.js";
import { withJobTmp } from "./tmp.js";

/**
 * Il testo di un file del Drive (area 5, fetta 3; piano
 * `docs/plans/2026-11-11-integrazione-area5-fetta3-plan.md`). Il file è input
 * NON fidato:
 * - sta in una tmp del job col nome dato da NOI (`input.<ext>`), mai col suo:
 *   la sorgente (lo scaricamento dallo storage) lo scrive lì, e il worker non
 *   lo tiene mai tutto in memoria;
 * - ogni processo figlio passa da `exec` (execFile, argomenti fissi, prlimit,
 *   SIGKILL al timeout) con la cwd nella tmp; la tmp si toglie sempre;
 * - i tetti: 60 s per pagina OCR, 30 s per pdfinfo/pdftotext, 5 minuti per il
 *   job; OCR sulle prime 30 pagine; 300 dpi al più, meno se la pagina
 *   supererebbe i 40 megapixel; un'immagine oltre i 40 megapixel non si legge;
 *   il testo si ferma a 1.000.000 di caratteri.
 * - FAIL-OPEN: un motore assente, un timeout, un file che non si apre, un
 *   tetto superato danno `no_text` col motivo, mai un'eccezione. Lancia solo un
 *   guasto NOSTRO (il filesystem), che il job ritenta.
 */
export type ExtractResult =
  | { status: "ready"; ocr: DriveContentOcr; text: string; truncated: boolean }
  | { status: "no_text"; reason: DriveContentReason; ocr: DriveContentOcr };

type Deps = { exec: Exec; now?: () => number; tmpRoot?: string };

/** L'estensione del file nella tmp, dal MIME: un elenco chiuso, mai dal nome del file. */
const EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/heic": "heic",
  "application/pdf": "pdf",
  "text/plain": "txt",
  "text/csv": "txt",
  "text/markdown": "txt",
};
const TESSERACT_ARGS = ["stdout", "-l", "ita+eng"] as const;

const noText = (reason: DriveContentReason, ocr: DriveContentOcr = "none"): ExtractResult => ({ status: "no_text", reason, ocr });
/** Un esito di un figlio che non è andato, come motivo del `no_text`. */
const reasonOf = (r: Exclude<ExecResult, { ok: true }>): DriveContentReason =>
  r.kind === "missing" ? "ocr_unavailable" : r.kind === "timeout" ? "ocr_timeout" : r.kind === "output_limit" ? "limits" : "unreadable";

function finish(raw: string, ocr: DriveContentOcr): ExtractResult {
  const text = raw.replace(/\r\n?/g, "\n").trim();
  if (text.replace(/\s/g, "").length === 0) return noText("no_text_found", ocr);
  const truncated = text.length > L.textMaxChars;
  return { status: "ready", ocr, text: truncated ? text.slice(0, L.textMaxChars) : text, truncated };
}

/** I primi `max` byte di un file, senza leggerlo tutto. */
async function head(path: string, max: number): Promise<Buffer> {
  const handle = await open(path, "r");
  try {
    const buf = Buffer.alloc(max);
    const { bytesRead } = await handle.read(buf, 0, max, 0);
    return buf.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

const decode = (b: Uint8Array) => new TextDecoder("utf-8", { fatal: false }).decode(b).replace(/^﻿/, "");

export async function extractContent(
  input: { jobId: string; mime: string; source: (dest: string) => Promise<void> },
  deps: Deps,
): Promise<ExtractResult> {
  const kind = driveContentKindOf(input.mime);
  if (kind === null) return noText("unreadable");
  const now = deps.now ?? Date.now;
  const deadline = now() + L.jobMs;
  /** Il tempo di un passo: il suo tetto, ma mai oltre la fine del job. */
  const budget = (stepMs: number) => Math.min(stepMs, deadline - now());
  return withJobTmp(
    input.jobId,
    async (dir) => {
      const inputName = `input.${EXT[input.mime.toLowerCase()] ?? "bin"}`;
      const inputPath = join(dir, inputName);
      await input.source(inputPath);
      const run = (cmd: string, args: readonly string[], stepMs: number, maxBuffer: number = L.childStdoutBytes) =>
        deps.exec(cmd, args, { cwd: dir, timeoutMs: budget(stepMs), maxBuffer });

      if (kind === "text") return finish(decode(await head(inputPath, L.textMaxChars * 4 + 4)), "none");
      if (kind === "office") {
        const { size } = await stat(inputPath);
        const r = await extractOffice(createReadStream(inputPath, { highWaterMark: 64 * 1024 }), size, input.mime);
        return r.kind === "ok" ? finish(r.text, "none") : noText(r.kind);
      }

      if (kind === "image" || kind === "heic") {
        let file = inputName;
        if (kind === "heic") {
          const conv = await run("heif-convert", [inputName, "converted.png"], L.ocrPageMs, 64 * 1024);
          if (!conv.ok) return noText(reasonOf(conv));
          file = "converted.png";
        }
        const size = imageSize(await head(join(dir, file), 64 * 1024).catch(() => Buffer.alloc(0)));
        if (!size) return noText("unreadable");
        if (size.width * size.height > L.maxPixels) return noText("too_large");
        const ocr = await run("tesseract", [file, ...TESSERACT_ARGS], L.ocrPageMs);
        if (!ocr.ok) return noText(reasonOf(ocr));
        return finish(decode(ocr.stdout), "full");
      }

      // PDF: prima il testo, poi l'OCR se il testo non basta.
      const infoRun = await run("pdfinfo", ["-f", "1", "-l", String(L.ocrMaxPages), "input.pdf"], L.pdfTextMs, 1024 * 1024);
      if (!infoRun.ok) return noText(reasonOf(infoRun));
      const infoText = infoRun.stdout.toString("utf8");
      const pages = Number(/^Pages:\s+(\d+)/m.exec(infoText)?.[1] ?? "0");
      const textRun = await run("pdftotext", ["-enc", "UTF-8", "-eol", "unix", "input.pdf", "out.txt"], L.pdfTextMs);
      if (textRun.ok) {
        const text = decode(await head(join(dir, "out.txt"), L.textMaxChars * 4).catch(() => Buffer.alloc(0)));
        if (text.replace(/\s/g, "").length >= L.pdfTextMinChars) return finish(text, "none");
      } else if (textRun.kind !== "failed") {
        return noText(reasonOf(textRun));
      }

      // OCR: le prime 30 pagine, ai dpi che tengono la pagina più grande sotto i 40 megapixel.
      const last = Math.max(1, Math.min(pages || 1, L.ocrMaxPages));
      let partial = pages > L.ocrMaxPages;
      let maxArea = 0;
      for (const m of infoText.matchAll(/^Page\s+\d+\s+size:\s+([\d.]+)\s+x\s+([\d.]+)\s+pts/gm)) maxArea = Math.max(maxArea, Number(m[1]) * Number(m[2]));
      const fit = maxArea > 0 ? Math.floor(72 * Math.sqrt(L.maxPixels / maxArea)) : L.maxDpi;
      const dpi = Math.max(36, Math.min(L.maxDpi, fit));
      const ocrOf = () => (partial ? "partial" : "full") as DriveContentOcr;
      const render = await run("pdftoppm", ["-r", String(dpi), "-f", "1", "-l", String(last), "-png", "input.pdf", "page"], L.ocrPageMs * last);
      if (!render.ok) return noText(reasonOf(render), ocrOf());
      const files = (await readdir(dir))
        .filter((f) => /^page-\d+\.png$/.test(f))
        .sort((a, b) => Number(/\d+/.exec(a)![0]) - Number(/\d+/.exec(b)![0]));
      const texts: string[] = [];
      let timedOut = false;
      let tooLarge = false;
      for (const page of files) {
        if (deadline - now() <= 0) {
          partial = true;
          timedOut = true;
          break;
        }
        const size = imageSize(await head(join(dir, page), 64));
        if (!size || size.width * size.height > L.maxPixels) {
          partial = true;
          tooLarge = true;
          continue;
        }
        const ocr = await run("tesseract", [page, ...TESSERACT_ARGS], L.ocrPageMs);
        if (ocr.ok) texts.push(decode(ocr.stdout).trim());
        else if (ocr.kind === "missing") return noText("ocr_unavailable", ocrOf());
        else {
          partial = true;
          if (ocr.kind === "timeout") timedOut = true;
        }
      }
      const result = finish(texts.filter((t) => t.length > 0).join("\n"), ocrOf());
      if (result.status === "no_text" && timedOut) return noText("ocr_timeout", ocrOf());
      if (result.status === "no_text" && tooLarge) return noText("too_large", ocrOf());
      return result;
    },
    deps.tmpRoot,
  );
}
