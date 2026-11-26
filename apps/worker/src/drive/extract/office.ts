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

/** I tag che chiudono un paragrafo (un a capo), quelli di a capo e di tabulazione. */
const PARAGRAPH_END = new Set(["w:p", "a:p", "text:p", "text:h", "si"]);
const LINE_BREAK = new Set(["w:br", "text:line-break", "a:br"]);
const TAB = new Set(["w:tab", "text:tab"]);

/**
 * Il testo di un XML in UNA passata con `indexOf` (review della F3): niente
 * espressioni regolari sul documento, che su un input ostile («<» senza «>»)
 * diventavano quadratiche e bloccavano il worker. Ogni costrutto si cerca UNA
 * volta dalla posizione corrente in avanti; uno non chiuso termina il testo.
 * CDATA è testo; commenti, istruzioni e DOCTYPE si tolgono, senza risolvere
 * nulla. Nei fogli di calcolo (non le stringhe condivise) conta solo il testo
 * dentro `<is>`: i `<v>` sono numeri o indici.
 */
function xmlToText(format: Format, xml: string): string {
  const inlineOnly = format === "xlsx" && !xml.includes("<sst");
  let inInline = 0;
  const out: string[] = [];
  const emit = (text: string) => {
    if (!inlineOnly || inInline > 0) out.push(text);
  };
  let i = 0;
  while (i < xml.length) {
    const lt = xml.indexOf("<", i);
    if (lt === -1) {
      emit(decodeEntities(xml.slice(i)));
      break;
    }
    if (lt > i) emit(decodeEntities(xml.slice(i, lt)));
    if (xml.startsWith("<![CDATA[", lt)) {
      const close = xml.indexOf("]]>", lt + 9);
      if (close === -1) break;
      emit(xml.slice(lt + 9, close));
      i = close + 3;
      continue;
    }
    if (xml.startsWith("<!--", lt)) {
      const close = xml.indexOf("-->", lt + 4);
      if (close === -1) break;
      i = close + 3;
      continue;
    }
    if (xml.startsWith("<!DOCTYPE", lt) || xml.startsWith("<!doctype", lt)) {
      // Con un sottoinsieme interno («[ … ]») si chiude a «]>», altrimenti al primo «>».
      const gt = xml.indexOf(">", lt);
      const bracket = xml.indexOf("[", lt);
      const close = bracket !== -1 && (gt === -1 || bracket < gt) ? xml.indexOf("]>", bracket) : gt;
      if (close === -1) break;
      i = close + (bracket !== -1 && (gt === -1 || bracket < gt) ? 2 : 1);
      continue;
    }
    const gt = xml.indexOf(">", lt + 1);
    if (gt === -1) break;
    const tag = xml.slice(lt + 1, gt);
    i = gt + 1;
    if (tag.startsWith("?") || tag.startsWith("!")) continue;
    const closing = tag.startsWith("/");
    let end = closing ? 1 : 0;
    while (end < tag.length && tag[end] !== " " && tag[end] !== "/" && tag[end] !== "\t" && tag[end] !== "\n" && tag[end] !== "\r") end += 1;
    const name = tag.slice(closing ? 1 : 0, end);
    if (name === "is") {
      if (closing) {
        inInline = Math.max(0, inInline - 1);
        if (inlineOnly) out.push("\n");
      } else if (!tag.endsWith("/")) inInline += 1;
      continue;
    }
    if (closing && PARAGRAPH_END.has(name)) emit("\n");
    else if (!closing && LINE_BREAK.has(name)) emit("\n");
    else if (!closing && TAB.has(name)) emit("\t");
  }
  return out.join("");
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
