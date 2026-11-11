import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { extractOffice as fromStream, OFFICE_LIMITS } from "./office.js";

/** Il lettore legge a pezzi (come dal file della tmp): qui i pezzi vengono da un array. */
const extractOffice = (bytes: Uint8Array, mime: string) =>
  fromStream((async function* () {
    for (let i = 0; i < bytes.length; i += 4096) yield bytes.subarray(i, i + 4096);
  })(), bytes.length, mime);

// Office e ODF in JS (D Office/ODF = a): solo le voci note del testo, i tag
// tolti, le entità decodificate senza DTD, e i limiti contro le zip-bomb.
const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const PPTX = "application/vnd.openxmlformats-officedocument.presentationml.presentation";
const ODT = "application/vnd.oasis.opendocument.text";
const zip = (entries: Record<string, string | Uint8Array>) =>
  zipSync(Object.fromEntries(Object.entries(entries).map(([k, v]) => [k, typeof v === "string" ? strToU8(v) : v])));

describe("extractOffice", () => {
  it("docx: i paragrafi e le entità; niente DTD né entità esterne", async () => {
    const doc = `<?xml version="1.0"?><!DOCTYPE x [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><w:document><w:body><w:p><w:r><w:t>Clausola &amp; penale &lt;30&gt; &#232; &#x41;</w:t></w:r></w:p><w:p><w:r><w:t>&xxe;Seconda</w:t></w:r></w:p></w:body></w:document>`;
    const r = await extractOffice(zip({ "word/document.xml": doc, "word/other.xml": "<w:t>NON LETTO</w:t>" }), DOCX);
    expect(r).toEqual({ kind: "ok", text: "Clausola & penale <30> è A\n&xxe;Seconda" });
  });

  it("xlsx: le stringhe condivise e quelle in linea; pptx: le slide in ordine; ODF: content.xml", async () => {
    expect(
      await extractOffice(zip({ "xl/sharedStrings.xml": "<sst><si><t>Cliente</t></si><si><t>Importo</t></si></sst>", "xl/worksheets/sheet1.xml": '<row><c t="inlineStr"><is><t>Nota</t></is></c></row>' }), XLSX),
    ).toEqual({ kind: "ok", text: "Cliente\nImporto\nNota" });
    expect(await extractOffice(zip({ "ppt/slides/slide10.xml": "<a:p><a:t>Dieci</a:t></a:p>", "ppt/slides/slide2.xml": "<a:p><a:t>Due</a:t></a:p>" }), PPTX)).toEqual({ kind: "ok", text: "Due\nDieci" });
    expect(await extractOffice(zip({ "content.xml": "<office:text><text:p>Riga uno</text:p><text:p>Riga due</text:p></office:text>" }), ODT)).toEqual({ kind: "ok", text: "Riga uno\nRiga due" });
  });

  it("un archivio rotto è `unreadable`; uno senza le voci di testo dà testo vuoto", async () => {
    expect(await extractOffice(strToU8("non è uno zip"), DOCX)).toEqual({ kind: "unreadable" });
    expect(await extractOffice(zip({ "word/styles.xml": "<x/>" }), DOCX)).toEqual({ kind: "ok", text: "" });
  });

  it("zip-bomb: troppe voci, troppi byte decompressi, un rapporto di compressione oltre il tetto: `limits`", async () => {
    const many = Object.fromEntries(Array.from({ length: OFFICE_LIMITS.entries + 1 }, (_, i) => [`x/${i}.xml`, "a"]));
    expect(await extractOffice(zip({ ...many, "word/document.xml": "<w:t>a</w:t>" }), DOCX)).toEqual({ kind: "limits" });
    // Molto testo uguale: compresso pochissimo, decompresso oltre il rapporto 100.
    const bomb = `<w:t>${"a".repeat(2_000_000)}</w:t>`;
    expect(await extractOffice(zip({ "word/document.xml": bomb }), DOCX)).toEqual({ kind: "limits" });
  });

  it("i byte decompressi si contano DAVVERO, non dal valore dichiarato", async () => {
    // Un archivio con dimensioni dichiarate false (0) per la voce: il conteggio è sui byte veri.
    const real = zip({ "word/document.xml": `<w:t>${"b".repeat(OFFICE_LIMITS.totalBytes + 10)}</w:t>` });
    const lied = new Uint8Array(real);
    // Azzera l'«uncompressed size» nell'header locale (offset 22) e nella directory centrale.
    const view = new DataView(lied.buffer);
    view.setUint32(22, 0, true);
    for (let i = lied.length - 22; i >= 0; i--) {
      if (view.getUint32(i, true) === 0x02014b50) {
        view.setUint32(i + 24, 0, true);
        break;
      }
    }
    expect((await extractOffice(lied, DOCX)).kind).not.toBe("ok");
  });
});
