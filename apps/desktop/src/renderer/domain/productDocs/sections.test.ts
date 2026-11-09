import { describe, expect, it } from "vitest";
import type { ProductBlock } from "../../data/model";
import { plain } from "./richText";
import { inSectionOf, sectionOf, sectionRange } from "./sections";

const h = (id: string, level: 1 | 2 | 3, text: string): ProductBlock => ({ id, type: "heading", level, content: plain(text) });
const p = (id: string): ProductBlock => ({ id, type: "paragraph", content: plain(id) });

// [P0, H2 «Rules», P1, H3 «Edge cases», T (tabella in Edge cases), P2, H2 «Screens», P3]
const blocks: ProductBlock[] = [
  p("p0"),
  h("rules", 2, "Rules"),
  p("p1"),
  h("edge", 3, "Edge cases"),
  { id: "t", type: "table", rows: [{ id: "r1", cells: [{ id: "c1", content: plain("x") }] }] },
  p("p2"),
  h("screens", 2, "Screens"),
  p("p3"),
];

describe("sectionOf", () => {
  it("il titolo sopra l'ancora, di qualunque livello", () => {
    expect(sectionOf(blocks, "p2")).toBe("edge");
    expect(sectionOf(blocks, "p1")).toBe("rules");
    expect(sectionOf(blocks, "p3")).toBe("screens");
  });

  it("una cella risale al suo blocco; un titolo è la sua sezione", () => {
    expect(sectionOf(blocks, "c1")).toBe("edge");
    expect(sectionOf(blocks, "rules")).toBe("rules");
  });

  it("prima del primo titolo, o un'ancora che non c'è: null", () => {
    expect(sectionOf(blocks, "p0")).toBeNull();
    expect(sectionOf(blocks, "nope")).toBeNull();
  });
});

describe("sectionRange", () => {
  it("dal titolo fino al prossimo titolo di livello uguale o più alto", () => {
    expect(sectionRange(blocks, "rules")).toEqual(["rules", "p1", "edge", "c1", "p2"]);
    expect(sectionRange(blocks, "edge")).toEqual(["edge", "c1", "p2"]);
    expect(sectionRange(blocks, "screens")).toEqual(["screens", "p3"]);
  });

  it("null = prima del primo titolo; un titolo che non c'è: niente", () => {
    expect(sectionRange(blocks, null)).toEqual(["p0"]);
    expect(sectionRange(blocks, "nope")).toEqual([]);
  });
});

describe("inSectionOf", () => {
  it("b sta nella sezione di a", () => {
    expect(inSectionOf(blocks, "p1", "p2")).toBe(true);
    expect(inSectionOf(blocks, "p2", "p1")).toBe(false);
    expect(inSectionOf(blocks, "p1", "p3")).toBe(false);
    expect(inSectionOf(blocks, "nope", "p0")).toBe(false);
  });
});
