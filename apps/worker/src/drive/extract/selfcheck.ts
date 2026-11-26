import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { strToU8, zipSync } from "fflate";
import { createExec, type Exec } from "./exec.js";
import { extractContent, type ExtractResult } from "./extract.js";

/**
 * Il controllo dell'estrazione DENTRO l'immagine del worker (area 5, fetta 3):
 * con i poppler, tesseract e libheif veri, alle versioni apt fissate nel
 * Dockerfile. Si costruisce da sé le fixture (un PDF col testo, lo stesso
 * scansionato su 3 pagine, un PNG, un HEIC, un docx, un xlsx), misura i tempi e
 * controlla il testo atteso. Non gira in `pnpm -r test`: si lancia con
 *
 *   docker run --rm --entrypoint node <immagine> dist/drive/extract/selfcheck.js
 *
 * ed è il controllo da rifare quando si aggiorna una versione apt. Esce con 1
 * se un caso non torna.
 */

const PHRASE = "Stubwise contratto penale";

/** Un PDF A4 a mano, con la frase in Helvetica 40 pt (per l'OCR, grande e netta). */
function textPdf(): Buffer {
  const content = `BT /F1 40 Tf 60 700 Td (${PHRASE}) Tj ET`;
  return pdf([
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    { dict: "", stream: Buffer.from(content) },
  ]);
}

/** Un PDF di sole immagini (scansionato): `pages` pagine con la stessa immagine in scala di grigi. */
function imagePdf(width: number, height: number, gray: Buffer, pages: number): Buffer {
  const objs: (string | { dict: string; stream: Buffer })[] = ["<< /Type /Catalog /Pages 2 0 R >>"];
  const kids = Array.from({ length: pages }, (_, i) => `${3 + i * 2} 0 R`).join(" ");
  objs.push(`<< /Type /Pages /Kids [${kids}] /Count ${pages} >>`);
  const image = { dict: `/Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode`, stream: deflateSync(gray) };
  const contentRef = 3 + pages * 2;
  const imageRef = contentRef + 1;
  for (let i = 0; i < pages; i++) {
    objs.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /XObject << /Im1 ${imageRef} 0 R >> >> /Contents ${contentRef} 0 R >>`);
    objs.push("<< >>"); // segnaposto per tenere i numeri pari
  }
  objs.push({ dict: "", stream: Buffer.from("q 595 0 0 842 0 0 cm /Im1 Do Q") });
  objs.push(image);
  return pdf(objs);
}

function pdf(objects: (string | { dict: string; stream: Buffer })[]): Buffer {
  const parts: Buffer[] = [Buffer.from("%PDF-1.4\n")];
  const offsets: number[] = [];
  let at = parts[0]!.length;
  objects.forEach((o, i) => {
    offsets.push(at);
    const body =
      typeof o === "string"
        ? Buffer.from(`${i + 1} 0 obj\n${o}\nendobj\n`)
        : Buffer.concat([Buffer.from(`${i + 1} 0 obj\n<< ${o.dict} /Length ${o.stream.length} >>\nstream\n`), o.stream, Buffer.from("\nendstream\nendobj\n")]);
    parts.push(body);
    at += body.length;
  });
  const xref = [`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`, ...offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`)].join("");
  parts.push(Buffer.from(`${xref}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${at}\n%%EOF\n`));
  return Buffer.concat(parts);
}

async function render(exec: Exec, dir: string, pdfBytes: Buffer, format: "pgm" | "png"): Promise<string> {
  await writeFile(join(dir, "src.pdf"), pdfBytes);
  const r = await exec("pdftoppm", [format === "pgm" ? "-gray" : "-png", "-r", "150", "-f", "1", "-l", "1", "src.pdf", "out"], { cwd: dir, timeoutMs: 30_000, maxBuffer: 1024 });
  if (!r.ok) throw new Error(`pdftoppm per le fixture: ${r.detail}`);
  const file = (await readdir(dir)).find((f) => f.startsWith("out") && f.endsWith(`.${format}`));
  if (!file) throw new Error("pdftoppm non ha scritto la fixture");
  return join(dir, file);
}

/** Un PGM binario (P5): larghezza, altezza e i pixel. */
function parsePgm(b: Buffer): { width: number; height: number; pixels: Buffer } {
  const m = /^P5\s+(\d+)\s+(\d+)\s+(\d+)\s/.exec(b.subarray(0, 64).toString("latin1"));
  if (!m) throw new Error("PGM non valido");
  return { width: Number(m[1]), height: Number(m[2]), pixels: b.subarray(m[0].length) };
}

type Case = { name: string; mime: string; bytes: Uint8Array; expect: (r: ExtractResult) => boolean };

export async function runExtractSelfcheck(): Promise<{ ok: boolean; results: { name: string; ms: number; ok: boolean; result: unknown }[] }> {
  const exec = createExec({ prlimit: true });
  const plain = createExec({ prlimit: false });
  const dir = await mkdtemp(join(tmpdir(), "stubwise-selfcheck-"));
  try {
    const pdfText = textPdf();
    const pgm = parsePgm(await readFile(await render(plain, dir, pdfText, "pgm")));
    const scanned = imagePdf(pgm.width, pgm.height, pgm.pixels, 3);
    const png = await readFile(await render(plain, dir, pdfText, "png"));
    await writeFile(join(dir, "page.png"), png);
    const enc = await plain("heif-enc", ["-q", "90", "-o", "page.heic", "page.png"], { cwd: dir, timeoutMs: 60_000, maxBuffer: 1024 * 1024 });
    if (!enc.ok) throw new Error(`heif-enc per la fixture: ${enc.detail}`);
    const heic = await readFile(join(dir, "page.heic"));
    const docx = zipSync({ "word/document.xml": strToU8(`<w:document><w:body><w:p><w:r><w:t>${PHRASE}</w:t></w:r></w:p></w:body></w:document>`) });
    const xlsx = zipSync({ "xl/sharedStrings.xml": strToU8(`<sst><si><t>${PHRASE}</t></si></sst>`) });
    const has = (r: ExtractResult) => r.status === "ready" && /contratto/i.test(r.text) && /penale/i.test(r.text);
    const cases: Case[] = [
      { name: "pdf-testo", mime: "application/pdf", bytes: pdfText, expect: (r) => has(r) && r.status === "ready" && r.ocr === "none" },
      { name: "pdf-scansionato-3-pagine", mime: "application/pdf", bytes: scanned, expect: (r) => has(r) && r.status === "ready" && r.ocr === "full" },
      { name: "png", mime: "image/png", bytes: png, expect: has },
      { name: "heic", mime: "image/heic", bytes: heic, expect: has },
      { name: "docx", mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", bytes: docx, expect: has },
      { name: "xlsx", mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", bytes: xlsx, expect: has },
    ];
    const results = [];
    for (const c of cases) {
      const started = Date.now();
      const result = await extractContent({ jobId: `selfcheck-${c.name}`, mime: c.mime, source: (dest) => writeFile(dest, c.bytes) }, { exec });
      results.push({ name: c.name, ms: Date.now() - started, ok: c.expect(result), result: result.status === "ready" ? { ...result, text: result.text.slice(0, 120) } : result });
    }
    return { ok: results.every((r) => r.ok), results };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  runExtractSelfcheck().then(
    (out) => {
      process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
      process.exit(out.ok ? 0 : 1);
    },
    (error: unknown) => {
      process.stderr.write(`${String(error)}\n`);
      process.exit(1);
    },
  );
}
