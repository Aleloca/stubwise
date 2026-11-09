import { describe, expect, it, vi } from "vitest";
import { PRODUCT_PAGES } from "../../../data/seed/productDocs";
import { exportModelOf, exportRunsOf, type ExportDoc } from "../../../domain/productDocs/exportModel";
import { buildDocx, docxImageOf, docxRunsOf, imageSizeOf, svgToPng, wordLeftOutImages, wordLeftOutReasons } from "./docx";

// Il Word dell'esportazione (area 11a, Task 12; ruling P36): nel renderer
// senza Node, quindi niente `Buffer` (le uscite sono `ArrayBuffer`), le
// misure delle immagini lette dai byte d'intestazione, `docx` importato solo
// quando si costruisce. Le funzioni pure si provano senza `docx`.

const page = (title: string) => PRODUCT_PAGES.find((p) => p.title === title)!;
const resolve = { driveLine: () => "File: x", decisionLine: () => "Decision: x", wireframe: () => null };
const modelOf = (title: string): ExportDoc =>
  exportModelOf({ title, pages: [{ page: page(title), depth: 0 }] }, resolve);
const bytesOf = (src: string) => Uint8Array.from(atob(src.slice(src.indexOf(",") + 1)), (c) => c.charCodeAt(0));
const imageSrcs = () =>
  page("Screens").blocks.flatMap((b) => (b.type === "image" ? [b.src] : []));

describe("docxRunsOf", () => {
  it("la frase di Overview: grassetto, corsivo e il link https del seme", () => {
    const first = page("Overview").blocks[0]!;
    if (first.type !== "paragraph") throw new Error("seme cambiato");
    const runs = docxRunsOf(exportRunsOf(first.content));
    expect(runs.find((r) => r.bold)).toEqual({ text: "pay their bills", bold: true, italics: false, link: null });
    expect(runs.find((r) => r.italics)).toEqual({ text: "service charter", bold: false, italics: true, link: null });
    expect(runs.find((r) => r.link)).toEqual({
      text: "the utility's website",
      bold: false,
      italics: false,
      link: "https://www.acquedottocolline.example/carta-dei-servizi",
    });
  });
});

describe("le immagini nel Word", () => {
  it("le misure dalle intestazioni: le due PNG del seme, una JPEG e una GIF", () => {
    for (const src of imageSrcs()) expect(imageSizeOf(bytesOf(src))).toEqual({ width: 480, height: 300 });
    // GIF89a 3×2.
    const gif = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 3, 0, 2, 0, 0, 0, 0]);
    expect(imageSizeOf(gif)).toEqual({ width: 3, height: 2 });
    // JPEG: SOI, un APP0 di 4 byte, poi SOF0 con altezza 5 e larghezza 7.
    const jpeg = new Uint8Array([
      0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x05, 0x00, 0x07, 0x01,
    ]);
    expect(imageSizeOf(jpeg)).toEqual({ width: 7, height: 5 });
    expect(imageSizeOf(new Uint8Array([1, 2, 3]))).toBeNull();
  });

  it("PNG, JPEG e GIF entrano coi loro byte; WebP, SVG o altro no (la sola didascalia)", () => {
    const png = docxImageOf(imageSrcs()[0]!);
    expect(png).toMatchObject({ type: "png", width: 480, height: 300 });
    expect(png?.data[0]).toBe(0x89);
    expect(docxImageOf("data:image/webp;base64,UklGRhYAAABXRUJQVlA4IAoAAAAwAQCdASoBAAEAAA==")).toBeNull();
    expect(docxImageOf("data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=")).toBeNull();
    expect(docxImageOf("https://example.com/a.png")).toBeNull();
    const doc: ExportDoc = {
      title: "x",
      pages: [
        {
          code: "ACQ-D1",
          title: "x",
          depth: 0,
          blocks: [
            { kind: "image", src: imageSrcs()[0]!, caption: "a" },
            { kind: "image", src: "data:image/webp;base64,UklGRg==", caption: "b" },
          ],
        },
      ],
    };
    expect(wordLeftOutImages(doc)).toBe(1);
  });

  it("il motivo di ogni immagine lasciata fuori: il suo formato, o «non è un'immagine data:»", () => {
    const image = (src: string) => ({ kind: "image" as const, src, caption: "" });
    const doc: ExportDoc = {
      title: "x",
      pages: [
        {
          code: "ACQ-D1",
          title: "x",
          depth: 0,
          blocks: [
            image(imageSrcs()[0]!),
            image("data:image/webp;base64,UklGRg=="),
            image("data:image/svg+xml;base64,PHN2Zz48L3N2Zz4="),
            image("data:image/webp;base64,UklGRg=="),
            image("https://example.com/a.png"),
            image("data:image/avif;base64,AAAA"),
          ],
        },
      ],
    };
    expect(wordLeftOutReasons(doc)).toEqual([
      { format: "WebP" },
      { format: "SVG" },
      { format: "WebP" },
      { notData: true },
      { format: "AVIF" },
    ]);
    expect(wordLeftOutImages(doc)).toBe(5);
  });
});

describe("buildDocx", () => {
  it("il modello di Sign-in: byte che cominciano con PK, non vuoti", async () => {
    const bytes = await buildDocx(modelOf("Sign-in"));
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(bytes.byteLength).toBeGreaterThan(1000);
    expect([bytes[0], bytes[1]]).toEqual([0x50, 0x4b]);
  });

  it("ogni forma di blocco si costruisce: tabella, immagini (una WebP lasciata fuori), voci, cose da fare, righe", async () => {
    const doc = exportModelOf(
      {
        title: "ACQ Product",
        pages: ["Overview", "Meter reading", "Screens", "Client decisions", "Phases"].map((t, i) => ({
          page: page(t),
          depth: i % 2,
        })),
      },
      resolve,
    );
    doc.pages[2]!.blocks.push(
      { kind: "image", src: "data:image/webp;base64,UklGRg==", caption: "WebP" },
      { kind: "divider" },
      { kind: "quote", runs: [{ text: "q", bold: false, italic: false, href: null }] },
      { kind: "list", ordered: true, indent: 1, runs: [{ text: "n", bold: false, italic: false, href: null }] },
    );
    const bytes = await buildDocx(doc);
    expect([bytes[0], bytes[1]]).toEqual([0x50, 0x4b]);
  });
});

// --- 11b, Task 12: la bozza di schermata nel Word ---------------------------

/** I file di uno zip (il .docx), dalla directory centrale: nome → byte decompressi. */
async function unzip(bytes: Uint8Array): Promise<Map<string, Uint8Array>> {
  const { inflateRawSync } = await import("node:zlib");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = bytes.length - 22;
  while (end >= 0 && view.getUint32(end, true) !== 0x06054b50) end--;
  const count = view.getUint16(end + 10, true);
  let at = view.getUint32(end + 16, true);
  const out = new Map<string, Uint8Array>();
  for (let i = 0; i < count; i++) {
    const method = view.getUint16(at + 10, true);
    const size = view.getUint32(at + 20, true);
    const nameLength = view.getUint16(at + 28, true);
    const extra = view.getUint16(at + 30, true);
    const comment = view.getUint16(at + 32, true);
    const local = view.getUint32(at + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(at + 46, at + 46 + nameLength));
    const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    const raw = bytes.subarray(start, start + size);
    out.set(name, method === 8 ? new Uint8Array(inflateRawSync(raw)) : raw);
    at += 46 + nameLength + extra + comment;
  }
  return out;
}

describe("la bozza di schermata nel Word (11b)", () => {
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 360 240" stroke="currentColor"><rect x="1" y="1" width="10" height="10"/></svg>';
  const png = () => ({ data: bytesOf(imageSrcs()[0]!), width: 480, height: 300 });
  const sketchDoc = (svgOrNull: string | null, label: boolean): ExportDoc => ({
    title: "Booking",
    pages: [{ code: "VRD-D3", title: "Booking", depth: 0, blocks: [{ kind: "sketch", svg: svgOrNull, label }] }],
  });
  // Senza apostrofi: nel Word un apostrofo è `&apos;`.
  const LABEL = "Bozza di Claude · Bozza di schermata";
  const MISSING = "Bozza di schermata: non è stato possibile disegnarla nel file Word";
  const documentXml = async (bytes: Uint8Array) =>
    new TextDecoder().decode((await unzip(bytes)).get("word/document.xml")!);
  const hasMedia = async (bytes: Uint8Array) =>
    [...(await unzip(bytes)).keys()].some((k) => k.startsWith("word/media/") && k.endsWith(".png"));

  it("mai tenuta: la PNG dello schizzo e, sotto, «Claude's draft · Screen sketch» in corsivo 10 pt", async () => {
    const toPng = vi.fn(async () => png());
    const bytes = await buildDocx(sketchDoc(svg, true), { label: LABEL, name: "Bozza di schermata", gone: "gone", missing: MISSING, toPng });
    expect(toPng).toHaveBeenCalledWith(svg);
    expect(await hasMedia(bytes)).toBe(true);
    expect(await documentXml(bytes)).toMatch(/<w:i\/>.*<w:sz w:val="20"\/>.*Bozza di Claude · Bozza di schermata/s);
  });

  it("tenuta: la PNG, senza l'etichetta", async () => {
    const bytes = await buildDocx(sketchDoc(svg, false), { label: LABEL, name: "Bozza di schermata", gone: "gone", missing: MISSING, toPng: async () => png() });
    expect(await hasMedia(bytes)).toBe(true);
    expect(await documentXml(bytes)).not.toContain("Bozza di Claude");
  });

  it("un disegno che il seme non ha più: la sua riga, e l'etichetta se mai tenuta", async () => {
    const bytes = await buildDocx(sketchDoc(null, true), {
      label: LABEL,
      name: "Bozza di schermata",
      missing: MISSING,
      gone: "This sketch is no longer available",
      toPng: async () => null,
    });
    const xml = await documentXml(bytes);
    expect(xml).toContain("This sketch is no longer available");
    expect(xml).toContain(LABEL);
  });

  it("svgToPng senza una tela (happy-dom): `null`; al posto dello schizzo la riga che lo dice, poi l'etichetta", async () => {
    expect(await svgToPng(svg)).toBeNull();
    const bytes = await buildDocx(sketchDoc(svg, true), { label: LABEL, name: "Bozza di schermata", gone: "gone", missing: MISSING, toPng: svgToPng });
    expect(await hasMedia(bytes)).toBe(false);
    expect(await documentXml(bytes)).toMatch(new RegExp(`${MISSING}.*${LABEL}`, "s"));
  });

  it("fix round 1 (M4): una bozza TENUTA che non diventa PNG non sparisce in silenzio: la riga c'è, l'etichetta no", async () => {
    const bytes = await buildDocx(sketchDoc(svg, false), {
      label: LABEL,
      name: "Bozza di schermata",
      gone: "gone",
      missing: MISSING,
      toPng: async () => null,
    });
    const xml = await documentXml(bytes);
    expect(await hasMedia(bytes)).toBe(false);
    expect(xml).toContain(MISSING);
    expect(xml).not.toContain("Bozza di Claude");
  });
});
