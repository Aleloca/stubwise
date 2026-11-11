import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { strToU8, zipSync } from "fflate";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Exec, ExecResult } from "./exec.js";
import { extractContent } from "./extract.js";
import { EXTRACT_LIMITS } from "./limits.js";

// L'estrazione del contenuto (area 5, fetta 3): il file è input NON fidato.
// Un `exec` finto fa da poppler, tesseract e heif-convert, e registra OGNI
// chiamata: argomenti fissi, cwd nella tmp del job, i tetti di pagine e dpi, i
// motivi del fail-open, la tmp tolta sempre.

type Call = { cmd: string; args: readonly string[]; cwd: string; timeoutMs: number };
let calls: Call[];
let root: string;
const JOB = "22222222-2222-4222-8222-222222222222";

function png(w: number, h: number): Uint8Array {
  const b = new Uint8Array(33);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  new DataView(b.buffer).setUint32(16, w);
  new DataView(b.buffer).setUint32(20, h);
  return b;
}

type Behaviour = Partial<Record<"pdfinfo" | "pdftotext" | "pdftoppm" | "tesseract" | "heif-convert", (c: Call) => Promise<ExecResult> | ExecResult>>;
function fakeExec(b: Behaviour): Exec {
  return async (cmd, args, opts) => {
    const call = { cmd, args, cwd: opts.cwd, timeoutMs: opts.timeoutMs };
    calls.push(call);
    const f = b[cmd as keyof Behaviour];
    if (!f) return { ok: false, kind: "missing", detail: `${cmd} not found` };
    return f(call);
  };
}
const ok = (s = ""): ExecResult => ({ ok: true, stdout: Buffer.from(s) });
const info = (pages: number, w = 595, h = 842) =>
  ok([`Pages:          ${pages}`, ...Array.from({ length: Math.min(pages, 30) }, (_, i) => `Page ${String(i + 1).padStart(4)} size: ${w} x ${h} pts (A4)`)].join("\n"));
/** pdftoppm finto: scrive le pagine PNG richieste (`-f 1 -l N`) nella cwd. */
const renders = (w = 2480, h = 3508) => async (c: Call) => {
  const last = Number(c.args[c.args.indexOf("-l") + 1]);
  for (let i = 1; i <= last; i++) await writeFile(join(c.cwd, `page-${String(i).padStart(2, "0")}.png`), png(w, h));
  return ok();
};
/** pdftotext finto: scrive `out.txt`. */
const pdfText = (text: string) => async (c: Call) => (await writeFile(join(c.cwd, "out.txt"), text), ok());

/** La sorgente scrive il file nella tmp del job, come lo scaricamento dallo storage: mai tutto in memoria. */
const run = (mime: string, bytes: Uint8Array, b: Behaviour, now?: () => number) =>
  extractContent({ jobId: JOB, mime, source: (dest) => writeFile(dest, bytes) }, { exec: fakeExec(b), tmpRoot: root, ...(now ? { now } : {}) });

beforeEach(async () => {
  calls = [];
  root = await mkdtemp(join(tmpdir(), "stubwise-extract-test-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** Ogni argomento è una costante, un numero nostro o un percorso della tmp: mai un pezzo del file. */
function expectFixedArgs() {
  const FIXED = /^(-[a-zA-Z-]+|\d+|ita\+eng|stdout|UTF-8|unix|input\.(pdf|png|jpg|gif|webp|heic)|out\.txt|page|page-\d+\.png|converted\.png)$/;
  for (const c of calls) {
    expect(c.cwd.startsWith(join(root, "stubwise-drive-"))).toBe(true);
    for (const a of c.args) expect(a, `${c.cmd} ${a}`).toMatch(FIXED);
  }
}

describe("testo puro", () => {
  it("UTF-8 con i byte non validi sostituiti; oltre il milione di caratteri si tronca e lo dice", async () => {
    expect(await run("text/plain", new Uint8Array([0x63, 0x69, 0x61, 0x6f, 0xff, 0x21]), {})).toEqual({ status: "ready", ocr: "none", text: "ciao�!", truncated: false });
    const r = await run("text/markdown", strToU8("a".repeat(EXTRACT_LIMITS.textMaxChars + 5)), {});
    expect(r).toMatchObject({ status: "ready", truncated: true });
    expect(r.status === "ready" && r.text.length).toBe(EXTRACT_LIMITS.textMaxChars);
    expect(await run("text/csv", strToU8("  \n\t "), {})).toEqual({ status: "no_text", reason: "no_text_found", ocr: "none" });
    expect(calls).toEqual([]);
  });
});

describe("PDF", () => {
  it("con testo: pdftotext basta, niente OCR, argomenti fissi", async () => {
    const r = await run("application/pdf", strToU8("%PDF"), { pdfinfo: () => info(3), pdftotext: pdfText("Il contratto scade a marzo.") });
    expect(r).toEqual({ status: "ready", ocr: "none", text: "Il contratto scade a marzo.", truncated: false });
    expect(calls.map((c) => c.cmd)).toEqual(["pdfinfo", "pdftotext"]);
    expectFixedArgs();
  });

  it("scansionato: OCR pagina per pagina con tesseract (ita+eng), `full`", async () => {
    const r = await run("application/pdf", strToU8("%PDF"), {
      pdfinfo: () => info(3),
      pdftotext: pdfText(" \n "),
      pdftoppm: renders(),
      tesseract: (c) => ok(`testo di ${c.args[0]}`),
    });
    expect(r).toEqual({ status: "ready", ocr: "full", text: "testo di page-01.png\ntesto di page-02.png\ntesto di page-03.png", truncated: false });
    const ppm = calls.find((c) => c.cmd === "pdftoppm")!;
    expect(ppm.args).toEqual(["-r", "300", "-f", "1", "-l", "3", "-png", "input.pdf", "page"]);
    expect(calls.filter((c) => c.cmd === "tesseract").every((c) => c.timeoutMs <= EXTRACT_LIMITS.ocrPageMs)).toBe(true);
    expectFixedArgs();
  });

  it("oltre 30 pagine l'OCR si ferma alla 30ª: `partial`", async () => {
    const r = await run("application/pdf", strToU8("%PDF"), { pdfinfo: () => info(45), pdftotext: pdfText(""), pdftoppm: renders(), tesseract: () => ok("x") });
    expect(r).toMatchObject({ status: "ready", ocr: "partial" });
    expect(calls.find((c) => c.cmd === "pdftoppm")!.args).toContain("30");
    expect(calls.filter((c) => c.cmd === "tesseract")).toHaveLength(30);
  });

  it("una pagina enorme abbassa i dpi sotto i 40 megapixel; una pagina renderizzata oltre il tetto si salta", async () => {
    // A0, 2384 x 3370 pt: a 300 dpi sarebbero 139 megapixel.
    await run("application/pdf", strToU8("%PDF"), { pdfinfo: () => info(1, 2384, 3370), pdftotext: pdfText(""), pdftoppm: renders(), tesseract: () => ok("x") });
    const dpi = Number(calls.find((c) => c.cmd === "pdftoppm")!.args[1]);
    expect(dpi).toBeLessThan(300);
    expect(((2384 / 72) * dpi * (3370 / 72) * dpi) / 1e6).toBeLessThanOrEqual(40);
    calls = [];
    const r = await run("application/pdf", strToU8("%PDF"), { pdfinfo: () => info(1), pdftotext: pdfText(""), pdftoppm: renders(9000, 9000), tesseract: () => ok("x") });
    expect(calls.some((c) => c.cmd === "tesseract")).toBe(false);
    expect(r).toEqual({ status: "no_text", reason: "too_large", ocr: "partial" });
  });

  it("fail-open: poppler o tesseract assenti `ocr_unavailable`, un timeout `ocr_timeout`, un PDF rotto `unreadable`, niente testo `no_text_found`", async () => {
    expect(await run("application/pdf", strToU8("%PDF"), {})).toEqual({ status: "no_text", reason: "ocr_unavailable", ocr: "none" });
    expect(await run("application/pdf", strToU8("%PDF"), { pdfinfo: () => info(1), pdftotext: pdfText(""), pdftoppm: renders() })).toEqual({ status: "no_text", reason: "ocr_unavailable", ocr: "full" });
    expect(await run("application/pdf", strToU8("x"), { pdfinfo: () => ({ ok: false, kind: "failed", detail: "Syntax Error" }) })).toEqual({ status: "no_text", reason: "unreadable", ocr: "none" });
    expect(await run("application/pdf", strToU8("%PDF"), { pdfinfo: () => info(1), pdftotext: pdfText(""), pdftoppm: () => ({ ok: false, kind: "timeout", detail: "t" }) })).toEqual({ status: "no_text", reason: "ocr_timeout", ocr: "full" });
    expect(await run("application/pdf", strToU8("%PDF"), { pdfinfo: () => info(2), pdftotext: pdfText(""), pdftoppm: renders(), tesseract: () => ok("  ") })).toEqual({ status: "no_text", reason: "no_text_found", ocr: "full" });
  });

  it("una pagina in timeout con altre già lette: `ready` e `partial`", async () => {
    let n = 0;
    const r = await run("application/pdf", strToU8("%PDF"), {
      pdfinfo: () => info(3),
      pdftotext: pdfText(""),
      pdftoppm: renders(),
      tesseract: () => (++n === 2 ? { ok: false, kind: "timeout", detail: "t" } : ok(`p${n}`)),
    });
    expect(r).toEqual({ status: "ready", ocr: "partial", text: "p1\np3", truncated: false });
  });

  it("il tetto del job intero: finito il tempo, le pagine che restano non si leggono", async () => {
    let clock = 0;
    let n = 0;
    const r = await run(
      "application/pdf",
      strToU8("%PDF"),
      {
        pdfinfo: () => info(5),
        pdftotext: pdfText(""),
        pdftoppm: renders(),
        tesseract: () => {
          n += 1;
          clock += EXTRACT_LIMITS.jobMs; // la prima pagina consuma tutto il tempo
          return ok(`p${n}`);
        },
      },
      () => clock,
    );
    expect(r).toEqual({ status: "ready", ocr: "partial", text: "p1", truncated: false });
    expect(calls.filter((c) => c.cmd === "tesseract")).toHaveLength(1);
  });
});

describe("immagini", () => {
  it("una piccola: tesseract sul file della tmp, `full`; una oltre 40 megapixel non si legge affatto", async () => {
    expect(await run("image/png", png(1200, 800), { tesseract: () => ok("fattura 42") })).toEqual({ status: "ready", ocr: "full", text: "fattura 42", truncated: false });
    expect(calls[0]!.args).toEqual(["input.png", "stdout", "-l", "ita+eng"]);
    calls = [];
    expect(await run("image/png", png(8000, 6000), { tesseract: () => ok("x") })).toEqual({ status: "no_text", reason: "too_large", ocr: "none" });
    expect(calls).toEqual([]);
    expect(await run("image/jpeg", new Uint8Array([1, 2, 3]), { tesseract: () => ok("x") })).toEqual({ status: "no_text", reason: "unreadable", ocr: "none" });
  });

  it("HEIC: heif-convert a PNG nella tmp, poi i 40 megapixel e tesseract come ogni immagine", async () => {
    const r = await run("image/heic", strToU8("ftypheic"), {
      "heif-convert": async (c) => (await writeFile(join(c.cwd, "converted.png"), png(4032, 3024)), ok()),
      tesseract: (c) => ok(`letto ${c.args[0]}`),
    });
    expect(r).toEqual({ status: "ready", ocr: "full", text: "letto converted.png", truncated: false });
    expect(calls[0]).toMatchObject({ cmd: "heif-convert", args: ["input.heic", "converted.png"] });
    expect(calls[0]!.timeoutMs).toBeLessThanOrEqual(EXTRACT_LIMITS.ocrPageMs);
    expectFixedArgs();
    expect(await run("image/heic", strToU8("ftypheic"), {})).toEqual({ status: "no_text", reason: "ocr_unavailable", ocr: "none" });
    expect(await run("image/heic", strToU8("x"), { "heif-convert": () => ({ ok: false, kind: "failed", detail: "bad" }) })).toEqual({ status: "no_text", reason: "unreadable", ocr: "none" });
  });
});

describe("Office", () => {
  it("un docx si legge in JS, senza processi figli; i limiti dell'archivio sono `limits`", async () => {
    const docx = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    expect(await run(docx, zipSync({ "word/document.xml": strToU8("<w:p><w:t>Offerta</w:t></w:p>") }), {})).toEqual({ status: "ready", ocr: "none", text: "Offerta", truncated: false });
    expect(await run(docx, zipSync({ "word/document.xml": strToU8(`<w:t>${"a".repeat(2_000_000)}</w:t>`) }), {})).toEqual({ status: "no_text", reason: "limits", ocr: "none" });
    expect(await run(docx, strToU8("rotto"), {})).toEqual({ status: "no_text", reason: "unreadable", ocr: "none" });
    expect(calls).toEqual([]);
  });
});

describe("la tmp del job", () => {
  it("la sorgente scrive in `input.<ext>` dentro la tmp, mai col nome del file", async () => {
    let dest = "";
    await extractContent({ jobId: JOB, mime: "text/plain", source: async (d) => ((dest = d), writeFile(d, "ciao")) }, { exec: fakeExec({}), tmpRoot: root });
    expect(dest.startsWith(join(root, "stubwise-drive-"))).toBe(true);
    expect(dest.endsWith("/input.txt")).toBe(true);
  });

  it("si toglie sempre: dopo un timeout, dopo un'eccezione nostra e dopo uno scaricamento fallito", async () => {
    await expect(extractContent({ jobId: JOB, mime: "application/pdf", source: () => Promise.reject(new Error("storage giù")) }, { exec: fakeExec({}), tmpRoot: root })).rejects.toThrow("storage giù");
    await run("application/pdf", strToU8("%PDF"), { pdfinfo: () => ({ ok: false, kind: "timeout", detail: "t" }) });
    await expect(run("application/pdf", strToU8("%PDF"), { pdfinfo: () => Promise.reject(new Error("guasto nostro")) })).rejects.toThrow("guasto nostro");
    expect(await readdir(root)).toEqual([]);
  });
});
