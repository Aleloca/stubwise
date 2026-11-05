import { describe, expect, it } from "vitest";
import type { ProductBlock } from "../../../data/types";
import { plain } from "../../../domain/productDocs/richText";
import { SLASH_MAX, dropAfter, floatingPlacement, insertCode, tableAdd, tableRemove } from "./blockOps";

// Dove cade un blocco trascinato per ⋮⋮ (shape [PE 4]): il blocco prima di
// cui va (`afterId`), o `null` se torna dov'era (nessuna scrittura).

const IDS = ["a", "b", "c", "d"];

describe("dropAfter", () => {
  it("salendo va prima del blocco su cui cade", () => {
    expect(dropAfter(IDS, "d", "b")).toEqual({ afterId: "a", edge: "top" });
    expect(dropAfter(IDS, "c", "a")).toEqual({ afterId: null, edge: "top" });
  });

  it("scendendo va dopo il blocco su cui cade", () => {
    expect(dropAfter(IDS, "a", "c")).toEqual({ afterId: "c", edge: "bottom" });
    expect(dropAfter(IDS, "b", "d")).toEqual({ afterId: "d", edge: "bottom" });
  });

  it("su sé stesso, o un id che non c'è: null (resta dov'era)", () => {
    expect(dropAfter(IDS, "b", "b")).toBeNull();
    expect(dropAfter(IDS, "b", "z")).toBeNull();
    expect(dropAfter(IDS, "z", "b")).toBeNull();
  });
});

// La tabella (shape §3.10, [PE 13]): righe e colonne, ogni cella nuova col
// suo id; una tabella tiene almeno una riga e una colonna.

type Table = Extract<ProductBlock, { type: "table" }>;
const table: Table = {
  id: "t",
  type: "table",
  rows: [
    { id: "r1", cells: [{ id: "c1a", content: plain("A") }, { id: "c1b", content: plain("B") }] },
    { id: "r2", cells: [{ id: "c2a", content: plain("C") }, { id: "c2b", content: plain("D") }] },
  ],
};
const idsOf = (t: Table) => t.rows.flatMap((r) => [r.id, ...r.cells.map((c) => c.id)]);
const texts = (t: Table) => t.rows.map((r) => r.cells.map((c) => c.content.text));

describe("tableAdd / tableRemove", () => {
  it("una riga dopo quella della cella, vuota, con id nuovi e diversi", () => {
    const out = tableAdd(table, "row", 0);
    expect(texts(out)).toEqual([["A", "B"], ["", ""], ["C", "D"]]);
    const ids = idsOf(out);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.filter((id) => !idsOf(table).includes(id))).toHaveLength(3);
  });

  it("una colonna dopo quella della cella, in ogni riga", () => {
    const out = tableAdd(table, "column", 0);
    expect(texts(out)).toEqual([["A", "", "B"], ["C", "", "D"]]);
    const ids = idsOf(out);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("togliere una riga o una colonna; l'ultima resta (null)", () => {
    expect(texts(tableRemove(table, "row", 1)!)).toEqual([["A", "B"]]);
    expect(texts(tableRemove(table, "column", 0)!)).toEqual([["B"], ["D"]]);
    expect(tableRemove(tableRemove(table, "row", 0)!, "row", 0)).toBeNull();
    expect(tableRemove(tableRemove(table, "column", 0)!, "column", 0)).toBeNull();
  });

  it("non cambia la tabella di partenza", () => {
    tableAdd(table, "row", 1);
    tableRemove(table, "column", 1);
    expect(texts(table)).toEqual([["A", "B"], ["C", "D"]]);
  });
});

// «Link to…» ([PE 12]): il codice entra al cursore come parola a sé, così il
// testo lo riconosce come codice.
describe("insertCode", () => {
  it("in un blocco vuoto: il solo codice, cursore dopo", () => {
    expect(insertCode(plain(""), 0, "ACQ-1")).toEqual({ content: plain("ACQ-1"), caret: 5 });
  });
  it("attaccato a una parola: uno spazio prima e dopo", () => {
    const out = insertCode(plain("seeACQ"), 3, "ACQ-1");
    expect(out.content.text).toBe("see ACQ-1 ACQ");
    expect(out.caret).toBe(9);
  });
  it("dopo uno spazio: niente spazi in più", () => {
    expect(insertCode(plain("see "), 4, "ACQ-7").content.text).toBe("see ACQ-7");
  });
});

// Fix round 1 (punto 11): il menu «/» e i selettori stanno sotto il blocco
// (sopra se sotto non c'è posto) e tengono 16 px dal fondo visibile — della
// colonna o della finestra, quello più in alto.
describe("floatingPlacement", () => {
  it("sotto, con l'altezza che lascia 16 px dal fondo della finestra", () => {
    const out = floatingPlacement({ blockTop: 330, blockBottom: 356, viewTop: 40, viewBottom: 700, windowHeight: 680 });
    expect(out).toEqual({ placement: "below", maxHeight: 680 - 356 - 16 });
  });
  it("sotto ci sta tutto: 320", () => {
    expect(
      floatingPlacement({ blockTop: 100, blockBottom: 120, viewTop: 40, viewBottom: 900, windowHeight: 900 }),
    ).toEqual({ placement: "below", maxHeight: 320 });
  });
  it("sotto poco, sopra di più: sopra, coi 16 px dalla cima della colonna", () => {
    expect(
      floatingPlacement({ blockTop: 600, blockBottom: 622, viewTop: 40, viewBottom: 680, windowHeight: 680 }),
    ).toEqual({ placement: "above", maxHeight: 320 });
    expect(
      floatingPlacement({ blockTop: 300, blockBottom: 600, viewTop: 40, viewBottom: 680, windowHeight: 680 }),
    ).toEqual({ placement: "above", maxHeight: 300 - 40 - 16 });
  });
  // Impeccable 5: il menu «/» mostra tutte le sue voci quando c'è posto (14
  // righe a 900 di altezza), e scorre solo se la finestra è davvero bassa.
  it("col tetto del menu «/» (560): tutto il posto che c'è fino a 560", () => {
    expect(
      floatingPlacement({ blockTop: 100, blockBottom: 120, viewTop: 40, viewBottom: 900, windowHeight: 900 }, SLASH_MAX),
    ).toEqual({ placement: "below", maxHeight: 560 });
    expect(
      floatingPlacement({ blockTop: 300, blockBottom: 320, viewTop: 40, viewBottom: 680, windowHeight: 680 }, SLASH_MAX),
    ).toEqual({ placement: "below", maxHeight: 680 - 320 - 16 });
  });
});
