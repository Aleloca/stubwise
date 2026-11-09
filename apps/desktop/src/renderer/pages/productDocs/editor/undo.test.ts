import { describe, expect, it } from "vitest";
import type { ProductBlock, ProductBlockOp } from "../../../data/model";
import { applyBlockOps } from "../../../domain/productDocs/blocks";
import { plain } from "../../../domain/productDocs/richText";
import { pushEntry, stillAsLeft, undoEntryOf, type UndoEntry } from "./undo";

// La pila di ⌘Z / ⇧⌘Z dell'editor (shape [PE 21], maintainer 5 nov 2026;
// ruling del controller: un blocco eliminato torna con lo STESSO id).

const para = (id: string, text: string): ProductBlock => ({ id, type: "paragraph", content: plain(text) });
const PAGE: ProductBlock[] = [para("a", "Alpha"), para("b", "Beta"), para("c", "Gamma")];

/** Applica le operazioni di un verso e restituisce la pagina. */
const run = (blocks: ProductBlock[], ops: readonly ProductBlockOp[]) => applyBlockOps(blocks, ops).blocks;

describe("undoEntryOf", () => {
  it("un set: backward è il set del blocco di prima; before/after i due blocchi", () => {
    const ops: ProductBlockOp[] = [{ op: "set", block: para("b", "Beta!") }];
    const entry = undoEntryOf(PAGE, ops)!;
    expect(entry.forward).toEqual(ops);
    expect(entry.backward).toEqual([{ op: "set", block: para("b", "Beta") }]);
    expect(entry.before).toEqual({ b: para("b", "Beta") });
    expect(entry.after).toEqual({ b: para("b", "Beta!") });
    expect(run(run(PAGE, entry.forward), entry.backward)).toEqual(PAGE);
  });

  it("un delete: un insert con lo STESSO id, al suo posto (i commenti tornano)", () => {
    const entry = undoEntryOf(PAGE, [{ op: "delete", blockId: "b" }])!;
    expect(entry.backward).toEqual([{ op: "insert", afterId: "a", block: para("b", "Beta") }]);
    expect(entry.before).toEqual({ b: para("b", "Beta") });
    expect(entry.after).toEqual({ b: null });
    expect(run(run(PAGE, entry.forward), entry.backward)).toEqual(PAGE);
  });

  it("il primo blocco eliminato torna in testa (afterId null)", () => {
    const entry = undoEntryOf(PAGE, [{ op: "delete", blockId: "a" }])!;
    expect(entry.backward).toEqual([{ op: "insert", afterId: null, block: para("a", "Alpha") }]);
  });

  it("una divisione: backward toglie il secondo e rimette il primo", () => {
    const ops: ProductBlockOp[] = [
      { op: "set", block: para("b", "Be") },
      { op: "insert", afterId: "b", block: para("n", "ta") },
    ];
    const entry = undoEntryOf(PAGE, ops)!;
    expect(entry.after).toEqual({ b: para("b", "Be"), n: para("n", "ta") });
    expect(entry.before).toEqual({ b: para("b", "Beta"), n: null });
    expect(run(run(PAGE, entry.forward), entry.backward)).toEqual(PAGE);
  });

  it("un merge: backward rimette i due blocchi, il secondo con il suo id", () => {
    const entry = undoEntryOf(PAGE, [{ op: "merge", firstId: "a", secondId: "b" }])!;
    const back = run(run(PAGE, entry.forward), entry.backward);
    expect(back).toEqual(PAGE);
    expect(entry.after).toEqual({ a: para("a", "AlphaBeta"), b: null });
  });

  it("uno spostamento: backward lo rimette dov'era", () => {
    const entry = undoEntryOf(PAGE, [{ op: "move", blockId: "c", afterId: null }])!;
    expect(run(run(PAGE, entry.forward), entry.backward)).toEqual(PAGE);
    expect(entry.after).toEqual({ c: para("c", "Gamma") });
  });

  it("una scrittura che non cambia niente → null", () => {
    expect(undoEntryOf(PAGE, [{ op: "set", block: para("b", "Beta") }])).toBeNull();
    expect(undoEntryOf(PAGE, [])).toBeNull();
  });
});

describe("stillAsLeft", () => {
  const entry = undoEntryOf(PAGE, [{ op: "set", block: para("b", "Beta!") }])!;
  const after = run(PAGE, entry.forward);

  it("vero se i blocchi toccati sono com'erano", () => {
    expect(stillAsLeft(after, entry.after)).toBe(true);
    // Un altro blocco cambiato da altri non conta.
    expect(stillAsLeft(run(after, [{ op: "set", block: para("a", "A!") }]), entry.after)).toBe(true);
  });

  it("falso se il blocco è cambiato o sparito", () => {
    expect(stillAsLeft(run(after, [{ op: "set", block: para("b", "Marco") }]), entry.after)).toBe(false);
    expect(stillAsLeft(run(after, [{ op: "delete", blockId: "b" }]), entry.after)).toBe(false);
  });

  it("un blocco atteso assente (null) è falso se qualcuno lo ha rimesso", () => {
    expect(stillAsLeft(PAGE, { z: null })).toBe(true);
    expect(stillAsLeft(PAGE, { b: null })).toBe(false);
  });

  it("l'ordine delle chiavi non conta", () => {
    const b = { content: { marks: [], text: "Beta!" }, type: "paragraph", id: "b" } as ProductBlock;
    expect(stillAsLeft([b], entry.after)).toBe(true);
  });
});

describe("pushEntry", () => {
  const e = (n: number): UndoEntry => ({
    forward: [{ op: "set", block: para("a", String(n)) }],
    backward: [],
    before: {},
    after: {},
  });

  it("aggiunge in cima e svuota redo", () => {
    const stack = pushEntry({ undo: [e(1)], redo: [e(2)] }, e(3));
    expect(stack.undo).toEqual([e(1), e(3)]);
    expect(stack.redo).toEqual([]);
  });

  it("al più 100 voci: la più vecchia esce", () => {
    let stack = { undo: [] as UndoEntry[], redo: [] as UndoEntry[] };
    for (let i = 0; i < 105; i++) stack = pushEntry(stack, e(i));
    expect(stack.undo).toHaveLength(100);
    expect(stack.undo[0]).toEqual(e(5));
    expect(stack.undo.at(-1)).toEqual(e(104));
  });
});
