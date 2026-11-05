import { describe, expect, it } from "vitest";
import type { ProductPageRef } from "../../data/model";
import { buildProductTree } from "./tree";
import { moveAnnouncement, movedPages, projectDrop, type FlatRow } from "./treeMoves";

// Gli spostamenti dell'albero Prodotto (area 11a, Task 7, fix round 1): dove
// cade una pagina trascinata (genitore, livello, posto, anche di lato), la
// posizione ottimistica e la frase che lo annuncia.

const ref = (id: string, parentId: string | null, order: number): ProductPageRef => ({
  id,
  code: `ACQ-D${id.length}${order}`,
  projectId: "prj-acq",
  parentId,
  order,
  title: id,
  excerpt: "",
  updatedAt: "2026-11-01T09:00:00.000Z",
  updatedById: "p-laura",
});

// Overview · Features (Sign-in, Bills) · Screens
const PAGES = [
  ref("Overview", null, 0),
  ref("Features", null, 1),
  ref("Sign-in", "Features", 0),
  ref("Bills", "Features", 1),
  ref("Screens", null, 2),
];

/** Le righe visibili, con livello e figli, come le disegna l'albero. */
function rows(pages: readonly ProductPageRef[]): FlatRow[] {
  const out: FlatRow[] = [];
  const walk = (nodes: ReturnType<typeof buildProductTree>, depth: number) => {
    for (const n of nodes) {
      out.push({ page: n.page, depth, hasChildren: n.children.length > 0 });
      walk(n.children, depth + 1);
    }
  };
  walk(buildProductTree(pages), 0);
  return out;
}

describe("projectDrop", () => {
  it("Bills sopra Sign-in, senza movimento di lato: sotto Features, al posto 0", () => {
    expect(projectDrop(rows(PAGES), "Bills", "Sign-in", 0)).toEqual({
      parentId: "Features",
      depth: 1,
      index: 0,
    });
  });

  it("Screens trascinata a destra di un livello resta al suo posto ma va sotto Features, in fondo", () => {
    expect(projectDrop(rows(PAGES), "Screens", "Screens", 24)).toEqual({
      parentId: "Features",
      depth: 1,
      index: 2,
    });
  });

  it("Bills trascinata a sinistra di un livello esce da Features, subito dopo", () => {
    expect(projectDrop(rows(PAGES), "Bills", "Bills", -24)).toEqual({
      parentId: null,
      depth: 0,
      index: 2,
    });
  });

  it("il livello resta fra quello della riga sotto e quello sopra più uno", () => {
    // Molto a destra: al più un livello sotto Sign-in.
    expect(projectDrop(rows(PAGES), "Bills", "Bills", 240)).toEqual({
      parentId: "Sign-in",
      depth: 2,
      index: 0,
    });
    // Molto a sinistra sopra la prima riga: radice, posto 0.
    expect(projectDrop(rows(PAGES), "Screens", "Overview", -240)).toEqual({
      parentId: null,
      depth: 0,
      index: 0,
    });
  });

  it("un id che non c'è: nessuna destinazione", () => {
    expect(projectDrop(rows(PAGES), "Bills", "Nope", 0)).toBeNull();
  });
});

describe("movedPages", () => {
  it("riordina i fratelli di arrivo e quelli di partenza", () => {
    const next = movedPages(PAGES, "Bills", null, 0);
    const by = new Map(next.map((p) => [p.id, p]));
    expect(by.get("Bills")).toMatchObject({ parentId: null, order: 0 });
    expect(by.get("Overview")!.order).toBe(1);
    expect(by.get("Features")!.order).toBe(2);
    expect(by.get("Screens")!.order).toBe(3);
    expect(by.get("Sign-in")).toMatchObject({ parentId: "Features", order: 0 });
  });

  it("un posto oltre la fine va in fondo; gli altri dati non cambiano", () => {
    const next = movedPages(PAGES, "Overview", "Features", 99);
    expect(next.find((p) => p.id === "Overview")).toMatchObject({ parentId: "Features", order: 2 });
    expect(next.find((p) => p.id === "Overview")!.title).toBe("Overview");
    // Il vecchio genitore (la radice) si rinumera: Features 0, Screens 1.
    expect(next.find((p) => p.id === "Features")!.order).toBe(0);
    expect(next.find((p) => p.id === "Screens")!.order).toBe(1);
  });
});

describe("moveAnnouncement", () => {
  it("prima del successivo, poi dopo il precedente, poi dentro il genitore", () => {
    expect(moveAnnouncement(PAGES, "Sign-in")).toEqual({ kind: "before", other: "Bills" });
    expect(moveAnnouncement(PAGES, "Screens")).toEqual({ kind: "after", other: "Features" });
    const alone = [ref("Features", null, 0), ref("Bills", "Features", 0)];
    expect(moveAnnouncement(alone, "Bills")).toEqual({ kind: "inside", other: "Features" });
  });

  it("una pagina sola alla radice: nessun nome vuoto", () => {
    expect(moveAnnouncement([ref("Overview", null, 0)], "Overview")).toEqual({
      kind: "alone",
      other: null,
    });
  });
});
