import { describe, expect, it } from "vitest";
import type { ProductBlock } from "../schemas/product-docs.js";
import { productBlockSchema, productBlockWriteSchema } from "../schemas/product-docs.js";
import { blockIdsOf, validProductBlock } from "./validate.js";

const para = (marks: unknown[]): ProductBlock => ({ id: "b1", type: "paragraph", content: { text: "Login con Google", marks } }) as ProductBlock;

describe("area 11, F1: la validazione di un blocco scritto", () => {
  it("un link http(s) passa; javascript:, data: e un indirizzo relativo no", () => {
    expect(validProductBlock(para([{ type: "link", start: 0, end: 5, href: "https://stubwise.dev" }]))).toBe(true);
    for (const href of ["javascript:alert(1)", "data:text/html,x", "/relativo", " https://spazi.dev"]) {
      expect(validProductBlock(para([{ type: "link", start: 0, end: 5, href }]))).toBe(false);
    }
  });

  it("un segno fuori dal testo o vuoto no", () => {
    expect(validProductBlock(para([{ type: "bold", start: 0, end: 99 }]))).toBe(false);
    expect(validProductBlock(para([{ type: "italic", start: 3, end: 3 }]))).toBe(false);
  });

  it("gli id di una tabella sono il blocco, le righe e le celle", () => {
    const table = { id: "t", type: "table", rows: [{ id: "r", cells: [{ id: "c", content: { text: "", marks: [] } }] }] } as ProductBlock;
    expect(blockIdsOf(table)).toEqual(["t", "r", "c"]);
  });

  it("un'immagine è un riferimento a una riga nostra, mai un data URL", () => {
    const img = (src: string) => productBlockWriteSchema.safeParse({ id: "i", type: "image", src, caption: "", alt: "" }).success;
    expect(img("product-image:6f1c2a52-1d7b-4c3e-9a51-0b6a7f2e1a01")).toBe(true);
    expect(img("data:image/png;base64,AAAA")).toBe(false);
    expect(img("https://example.com/x.png")).toBe(false);
  });

  it("un tipo di blocco futuro si LEGGE col ripiego (id e tipo), ma non si scrive", () => {
    expect(productBlockSchema.parse({ id: "x", type: "kanban", columns: 3 })).toMatchObject({ id: "x", type: "kanban" });
    expect(productBlockWriteSchema.safeParse({ id: "x", type: "kanban" }).success).toBe(false);
  });
});
