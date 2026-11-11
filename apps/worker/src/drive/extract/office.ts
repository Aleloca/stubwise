import { Unzip, UnzipInflate, type UnzipFile } from "fflate";

/**
 * Office e ODF moderni in JS (area 5, fetta 3, decisione Office/ODF = a):
 * docx, xlsx, pptx, odt, ods, odp sono zip di XML. Nessun binario in più,
 * nessun parser XML che risolva DTD o entità esterne: si leggono SOLO le voci
 * note del testo, si tolgono i tag con un'espressione regolare e si
 * decodificano le sole entità predefinite e numeriche.
 *
 * Contro le zip-bomb, contando i byte VERI (lo streaming di fflate, non le
 * dimensioni dichiarate nell'archivio, che possono mentire): al più 200 voci,
 * 50 MB decompressi in tutto fra le voci lette, un rapporto di compressione
 * al più 100. Oltre è `limits`; un archivio che non si apre `unreadable`.
 */
export const OFFICE_LIMITS = { entries: 200, totalBytes: 50 * 1024 * 1024, ratio: 100 } as const;

export type OfficeResult = { kind: "ok"; text: string } | { kind: "limits" } | { kind: "unreadable" };

type Format = "docx" | "xlsx" | "pptx" | "odf";
const FORMATS: Record<string, Format> = {
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
  "application/vnd.oasis.opendocument.text": "odf",
  "application/vnd.oasis.opendocument.spreadsheet": "odf",
  "application/vnd.oasis.opendocument.presentation": "odf",
};

/** Le voci da leggere, e l'ordine: un numero più basso viene prima. */
function wanted(format: Format, name: string): number | null {
  const num = (re: RegExp) => {
    const m = re.exec(name);
    return m ? Number(m[1]) : null;
  };
  switch (format) {
    case "docx":
      return name === "word/document.xml" ? 0 : null;
    case "xlsx": {
      if (name === "xl/sharedStrings.xml") return 0;
      const n = num(/^xl\/worksheets\/sheet(\d{1,5})\.xml$/);
      return n === null ? null : 1 + n;
    }
    case "pptx":
      return num(/^ppt\/slides\/slide(\d{1,5})\.xml$/);
    case "odf":
      return name === "content.xml" ? 0 : null;
  }
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-fA-F]{1,6}|#\d{1,7}|amp|lt|gt|quot|apos);/g, (whole, ent: string) => {
    if (!ent.startsWith("#")) return ENTITIES[ent]!;
    const cp = ent[1] === "x" ? parseInt(ent.slice(2), 16) : parseInt(ent.slice(1), 10);
    const valid = cp > 0 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff);
    return valid ? String.fromCodePoint(cp) : "";
  });
}

function xmlToText(format: Format, xml: string): string {
  let s = xml.replace(/<!DOCTYPE[^[>]*(\[[\s\S]*?\])?\s*>/gi, "").replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, (_, c: string) => c.replace(/[<&]/g, (ch) => (ch === "<" ? "&lt;" : "&amp;")));
  // Nei fogli di calcolo solo le stringhe in linea: i <v> sono numeri o indici.
  if (format === "xlsx" && !xml.includes("<sst")) s = (s.match(/<is>[\s\S]*?<\/is>/g) ?? []).map((x) => `${x}\n`).join("");
  s = s
    .replace(/<\/(w:p|a:p|text:p|text:h|si)>/g, "\n")
    .replace(/<(w:br|text:line-break|a:br)\b[^>]*\/?>/g, "\n")
    .replace(/<(w:tab|text:tab)\b[^>]*\/?>/g, "\t")
    .replace(/<[^>]*>/g, "");
  return decodeEntities(s);
}

/**
 * Legge l'archivio A PEZZI (dal file della tmp del job: mai tutto in memoria);
 * `size` sono i byte dell'archivio, per il rapporto di compressione.
 */
export async function extractOffice(chunks: AsyncIterable<Uint8Array>, size: number, mime: string): Promise<OfficeResult> {
  const format = FORMATS[mime.toLowerCase()];
  if (!format) return { kind: "unreadable" };

  const parts: { order: number; chunks: Uint8Array[] }[] = [];
  let entries = 0;
  let total = 0;
  let over = false;
  const maxTotal = Math.min(OFFICE_LIMITS.totalBytes, size * OFFICE_LIMITS.ratio);
  const open: UnzipFile[] = [];
  const unzip = new Unzip((file) => {
    entries += 1;
    if (entries > OFFICE_LIMITS.entries) over = true;
    const order = over ? null : wanted(format, file.name);
    if (order === null) return;
    const part = { order, chunks: [] as Uint8Array[] };
    parts.push(part);
    open.push(file);
    file.ondata = (error, data) => {
      if (error || over) return;
      total += data.length;
      if (total > maxTotal) {
        over = true;
        for (const f of open) f.terminate();
        return;
      }
      part.chunks.push(data);
    };
    file.start();
  });
  unzip.register(UnzipInflate);
  let first = true;
  try {
    for await (const chunk of chunks) {
      if (first) {
        // Un archivio zip comincia con l'intestazione locale «PK\x03\x04».
        if (chunk.length < 4 || chunk[0] !== 0x50 || chunk[1] !== 0x4b || chunk[2] !== 0x03 || chunk[3] !== 0x04) return { kind: "unreadable" };
        first = false;
      }
      unzip.push(chunk, false);
      if (over) break;
    }
    if (first) return { kind: "unreadable" };
    if (!over) unzip.push(new Uint8Array(0), true);
  } catch {
    return over ? { kind: "limits" } : { kind: "unreadable" };
  }
  if (over) return { kind: "limits" };

  const decoder = new TextDecoder("utf-8", { fatal: false });
  const text = parts
    .sort((a, b) => a.order - b.order)
    .map((p) => xmlToText(format, decoder.decode(concat(p.chunks))))
    .join("\n")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .join("\n");
  return { kind: "ok", text };
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}
