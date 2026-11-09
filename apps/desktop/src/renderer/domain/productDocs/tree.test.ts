import { describe, expect, it } from "vitest";
import type { ProductPageRef } from "../../data/model";
import { buildProductTree, canMoveUnder, flattenTree } from "./tree";

const page = (id: string, parentId: string | null, order: number, code: string): ProductPageRef => ({
  id,
  code,
  projectId: "prj-acq",
  parentId,
  order,
  title: id,
  excerpt: "",
  updatedAt: "2026-11-05T09:00:00.000Z",
  updatedById: "p-laura",
});

// overview (radice) ← features ← signin ← signin-edge; bills (radice) prima di overview per `order`.
const pages = [
  page("overview", null, 1, "ACQ-D1"),
  page("features", "overview", 0, "ACQ-D3"),
  page("signin", "features", 0, "ACQ-D10"),
  page("signup", "features", 0, "ACQ-D9"),
  page("signin-edge", "signin", 0, "ACQ-D12"),
  page("bills", null, 0, "ACQ-D2"),
];

describe("buildProductTree e flattenTree", () => {
  it("fratelli per order, poi per codice (D9 prima di D10)", () => {
    expect(flattenTree(buildProductTree(pages)).map(({ page: p, depth }) => [p.id, depth])).toEqual([
      ["bills", 0],
      ["overview", 0],
      ["features", 1],
      ["signup", 2],
      ["signin", 2],
      ["signin-edge", 3],
    ]);
  });

  it("una pagina il cui genitore non c'è sta fra le radici", () => {
    const tree = buildProductTree([page("orphan", "gone", 0, "ACQ-D5")]);
    expect(tree.map((n) => n.page.id)).toEqual(["orphan"]);
  });
});

describe("canMoveUnder", () => {
  it("rifiuta sé stesso e un discendente (anche un nipote)", () => {
    expect(canMoveUnder(pages, "features", "features")).toBe(false);
    expect(canMoveUnder(pages, "features", "signin")).toBe(false);
    expect(canMoveUnder(pages, "features", "signin-edge")).toBe(false);
  });

  it("accetta la radice e un ramo diverso; rifiuta pagine che non ci sono", () => {
    expect(canMoveUnder(pages, "signin", null)).toBe(true);
    expect(canMoveUnder(pages, "signin", "bills")).toBe(true);
    expect(canMoveUnder(pages, "signin", "gone")).toBe(false);
    expect(canMoveUnder(pages, "gone", null)).toBe(false);
  });
});
