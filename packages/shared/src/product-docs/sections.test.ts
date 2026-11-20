import { describe, expect, it } from "vitest";
import type { ProductBlock } from "../schemas/product-docs.js";
import { PRODUCT_TOP_SECTION, inSectionOf, sectionKeyOf, sectionOf, sectionRange } from "./sections.js";

const rich = (text: string) => ({ text, marks: [] });
const h = (id: string, level: 1 | 2 | 3): ProductBlock => ({ id, type: "heading", level, content: rich(id) });
const p = (id: string): ProductBlock => ({ id, type: "paragraph", content: rich(id) });
const BLOCKS: ProductBlock[] = [
  p("intro"),
  h("h2a", 2),
  p("a1"),
  h("h3", 3),
  p("a2"),
  { id: "tb", type: "table", rows: [{ id: "r", cells: [{ id: "cell", content: rich("x") }] }] },
  h("h2b", 2),
  p("b1"),
];

describe("le sezioni (area 11, F4)", () => {
  it("il titolo sopra l'ancora, qualunque livello; un titolo è la sua sezione; una cella sta nella sezione della tabella", () => {
    expect(sectionOf(BLOCKS, "a1")).toBe("h2a");
    expect(sectionOf(BLOCKS, "a2")).toBe("h3");
    expect(sectionOf(BLOCKS, "h2b")).toBe("h2b");
    expect(sectionOf(BLOCKS, "cell")).toBe("h3");
  });

  it("prima del primo titolo la sezione in cima (null, e la chiave `top` per le prese); un'ancora che non c'è null", () => {
    expect(sectionOf(BLOCKS, "intro")).toBeNull();
    expect(sectionKeyOf(BLOCKS, "intro")).toBe(PRODUCT_TOP_SECTION);
    expect(sectionOf(BLOCKS, "nessuna")).toBeNull();
  });

  it("le ancore di una sezione: un H3 dentro un H2 sta nell'H2; la sezione in cima finisce al primo titolo", () => {
    expect(sectionRange(BLOCKS, "h2a")).toEqual(["h2a", "a1", "h3", "a2", "cell"]);
    expect(sectionRange(BLOCKS, "h3")).toEqual(["h3", "a2", "cell"]);
    expect(sectionRange(BLOCKS, null)).toEqual(["intro"]);
    expect(sectionRange(BLOCKS, "a1")).toEqual([]);
  });

  it("un titolo tolto: i suoi blocchi passano alla sezione di sopra", () => {
    const without = BLOCKS.filter((b) => b.id !== "h3");
    expect(sectionOf(without, "a2")).toBe("h2a");
    expect(inSectionOf(without, "a1", "a2")).toBe(true);
    expect(inSectionOf(BLOCKS, "a1", "b1")).toBe(false);
  });
});
