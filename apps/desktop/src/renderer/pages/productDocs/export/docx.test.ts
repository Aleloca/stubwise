import { describe, expect, it } from "vitest";
import { PRODUCT_PAGES } from "../../../data/seed/productDocs";
import { exportModelOf, exportRunsOf, type ExportDoc } from "../../../domain/productDocs/exportModel";
import { buildDocx, docxImageOf, docxRunsOf, imageSizeOf, wordLeftOutImages, wordLeftOutReasons } from "./docx";

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
