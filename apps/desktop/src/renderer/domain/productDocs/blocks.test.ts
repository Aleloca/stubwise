import { describe, expect, it } from "vitest";
import type { ProductBlock, RichText } from "../../data/model";
import {
  anchorIdsOf,
  anchorText,
  applyBlockOps,
  blockChanges,
  CODE_TOKEN_RE,
  excerptOfBlocks,
  makeBlockId,
  mergeBlocks,
  plainTextOf,
  splitBlock,
} from "./blocks";
import { CODE_IN_TEXT } from "../../pages/claude/conversation/flow";
import { plain, setLink, toggleMark } from "./richText";

const para = (id: string, content: RichText | string): ProductBlock => ({
  id,
  type: "paragraph",
  content: typeof content === "string" ? plain(content) : content,
});

const table = (id: string, rows: [string, string[]][]): ProductBlock => ({
  id,
  type: "table",
  rows: rows.map(([rowId, cells]) => ({
    id: rowId,
    cells: cells.map((c, i) => ({ id: `${rowId}-c${i}`, content: plain(c) })),
  })),
});

const ids = (blocks: readonly ProductBlock[]) => blocks.map((b) => b.id);

describe("makeBlockId", () => {
  it("dà id nuovi col prefisso blk-", () => {
    const a = makeBlockId();
    expect(a).toMatch(/^blk-[0-9a-f-]{36}$/);
    expect(makeBlockId()).not.toBe(a);
  });
});

describe("CODE_TOKEN_RE", () => {
  it("è la stessa regex dei codici della Chat e di Claude, non una copia", () => {
    expect(CODE_IN_TEXT).toBe(CODE_TOKEN_RE);
    expect("ACQ-14 ACQ-D31 ACQ-F2 ACQ-R5 ACQ-S2".match(new RegExp(CODE_TOKEN_RE.source, "g"))).toEqual([
      "ACQ-14",
      "ACQ-D31",
      "ACQ-F2",
      "ACQ-R5",
      "ACQ-S2",
    ]);
  });
});

describe("applyBlockOps", () => {
  const start = [para("a", "A"), para("b", "B"), para("c", "C")];

  it("insert dopo null mette in testa, move dopo un id sposta", () => {
    const ins = applyBlockOps(start, [{ op: "insert", afterId: null, block: para("z", "Z") }]);
    expect(ids(ins.blocks)).toEqual(["z", "a", "b", "c"]);
    const mv = applyBlockOps(start, [{ op: "move", blockId: "a", afterId: "c" }]);
    expect(ids(mv.blocks)).toEqual(["b", "c", "a"]);
    expect(ids(applyBlockOps(start, [{ op: "move", blockId: "c", afterId: null }]).blocks)).toEqual(["c", "a", "b"]);
  });

  it("un id che manca, o un insert di un id già presente, lancia `invalid: op`", () => {
    expect(() => applyBlockOps(start, [{ op: "delete", blockId: "nope" }])).toThrow("invalid: op");
    expect(() => applyBlockOps(start, [{ op: "insert", afterId: "a", block: para("b", "dup") }])).toThrow(
      "invalid: op",
    );
    expect(() => applyBlockOps(start, [{ op: "insert", afterId: "nope", block: para("z", "Z") }])).toThrow(
      "invalid: op",
    );
    expect(() => applyBlockOps(start, [{ op: "set", block: para("nope", "x") }])).toThrow("invalid: op");
    expect(() => applyBlockOps(start, [{ op: "move", blockId: "a", afterId: "a" }])).toThrow("invalid: op");
  });

  it("una cella con l'id di un'ancora già presente lancia `invalid: op`", () => {
    const withTable = [...start, table("t", [["r1", ["x"]]])];
    const clash: ProductBlock = { id: "t2", type: "table", rows: [{ id: "r9", cells: [{ id: "a", content: plain("") }] }] };
    expect(() => applyBlockOps(withTable, [{ op: "insert", afterId: "t", block: clash }])).toThrow("invalid: op");
  });

  it("merge: id e tipo del primo, i segni del secondo scalati, mergedFrom sul primo", () => {
    const second = para("s", toggleMark(plain("with Google"), 0, 11, "bold"));
    const blocks = [para("f", "Login only"), second];
    const frozen = JSON.stringify(blocks);
    const { blocks: out, changes } = applyBlockOps(blocks, [{ op: "merge", firstId: "f", secondId: "s" }]);
    expect(out).toEqual([
      { id: "f", type: "paragraph", content: { text: "Login onlywith Google", marks: [{ type: "bold", start: 10, end: 21 }] } },
    ]);
    expect(JSON.stringify(blocks)).toBe(frozen);
    expect(changes).toEqual([
      {
        blockId: "f",
        before: blocks[0],
        after: out[0],
        anchors: ["f"],
        mergedFrom: { anchorId: "s", offset: 10 },
      },
      { blockId: "s", before: second, after: null, anchors: ["s"] },
    ]);
  });

  it("merge di un blocco senza testo, o di un blocco già unito nella stessa scrittura, lancia `invalid: op`", () => {
    const blocks = [para("a", "A"), { id: "d", type: "divider" } as ProductBlock, para("b", "B"), para("c", "C")];
    expect(() => applyBlockOps(blocks, [{ op: "merge", firstId: "a", secondId: "d" }])).toThrow("invalid: op");
    expect(() => applyBlockOps(blocks, [{ op: "merge", firstId: "a", secondId: "a" }])).toThrow("invalid: op");
    expect(() =>
      applyBlockOps(blocks, [
        { op: "merge", firstId: "b", secondId: "c" },
        { op: "merge", firstId: "a", secondId: "b" },
      ]),
    ).toThrow("invalid: op");
  });

  it("un insert dell'id che un merge ha assorbito nella stessa scrittura lancia `invalid: op`", () => {
    const blocks = [para("a", "A"), para("b", "B")];
    expect(() =>
      applyBlockOps(blocks, [
        { op: "merge", firstId: "a", secondId: "b" },
        { op: "insert", afterId: "a", block: para("b", "B again") },
      ]),
    ).toThrow("invalid: op");
  });

  it("delete e poi insert scritti a mano non sono un merge: nessun mergedFrom", () => {
    const blocks = [para("f", "Login only"), para("s", "with Google")];
    const { changes } = applyBlockOps(blocks, [
      { op: "delete", blockId: "s" },
      { op: "set", block: para("f", "Login onlywith Google") },
    ]);
    expect(changes.some((c) => c.mergedFrom !== undefined)).toBe(false);
  });

  it("l'array in ingresso non cambia", () => {
    const frozen = JSON.stringify(start);
    applyBlockOps(start, [
      { op: "set", block: para("a", "A2") },
      { op: "delete", blockId: "b" },
      { op: "move", blockId: "c", afterId: null },
    ]);
    expect(JSON.stringify(start)).toBe(frozen);
  });
});

describe("blockChanges", () => {
  it("un paragrafo cambiato: before, after e la sua ancora", () => {
    const before = [para("a", "A"), para("b", "B")];
    const after = [para("a", "A"), para("b", "B2")];
    expect(blockChanges(before, after)).toEqual([
      { blockId: "b", before: before[1], after: after[1], anchors: ["b"] },
    ]);
  });

  it("un grassetto in più e nient'altro è un cambio", () => {
    const before = [para("a", "Login only")];
    const after = [para("a", toggleMark(plain("Login only"), 0, 5, "bold"))];
    expect(blockChanges(before, after).map((c) => c.anchors)).toEqual([["a"]]);
  });

  it("un link con un altro indirizzo è un cambio dell'ancora", () => {
    const one = setLink(plain("site"), 0, 4, "https://a.example");
    const two = setLink(plain("site"), 0, 4, "https://b.example");
    expect(blockChanges([para("a", one)], [para("a", two)]).map((c) => c.anchors)).toEqual([["a"]]);
  });

  it("una tabella: la cella cambiata, o le celle di una riga tolta", () => {
    const before = [table("t", [["r1", ["a", "b"]], ["r2", ["c", "d"]]])];
    const cellChanged = [table("t", [["r1", ["a", "B!"]], ["r2", ["c", "d"]]])];
    expect(blockChanges(before, cellChanged).map((c) => c.anchors)).toEqual([["r1-c1"]]);
    const rowGone = [table("t", [["r1", ["a", "b"]]])];
    expect(blockChanges(before, rowGone).map((c) => c.anchors)).toEqual([["r2-c0", "r2-c1"]]);
  });

  it("un blocco spostato e non cambiato non è un cambio", () => {
    const before = [para("a", "A"), para("b", "B")];
    expect(blockChanges(before, [para("b", "B"), para("a", "A")])).toEqual([]);
  });

  it("un blocco nuovo e uno tolto: presenza cambiata", () => {
    const before = [para("a", "A")];
    const after = [para("n", "N")];
    expect(blockChanges(before, after)).toEqual([
      { blockId: "n", before: null, after: after[0], anchors: ["n"] },
      { blockId: "a", before: before[0], after: null, anchors: ["a"] },
    ]);
  });

  it("un titolo diventato paragrafo con lo stesso testo: cambio senza ancore", () => {
    const h: ProductBlock = { id: "a", type: "heading", level: 2, content: plain("Rules") };
    expect(blockChanges([h], [para("a", "Rules")]).map((c) => c.anchors)).toEqual([[]]);
  });
});

describe("splitBlock e mergeBlocks", () => {
  it("il primo tiene id e testo di testa, il secondo ha l'id nuovo e lo stesso tipo", () => {
    const [a, b] = splitBlock(para("p", "Login only with Google"), 10, "p2");
    expect(a).toEqual(para("p", "Login only"));
    expect(b).toEqual(para("p2", " with Google"));
  });

  it("un titolo diviso dà un paragrafo; una voce resta voce con lo stesso rientro", () => {
    const h: ProductBlock = { id: "h", type: "heading", level: 1, content: plain("Login only with Google") };
    expect(splitBlock(h, 10, "h2")[1]).toEqual(para("h2", " with Google"));
    const li: ProductBlock = { id: "l", type: "bullet", indent: 1, content: plain("ab") };
    expect(splitBlock(li, 1, "l2")).toEqual([
      { id: "l", type: "bullet", indent: 1, content: plain("a") },
      { id: "l2", type: "bullet", indent: 1, content: plain("b") },
    ]);
    const todo: ProductBlock = { id: "t", type: "todo", checked: true, content: plain("ab") };
    expect(splitBlock(todo, 1, "t2")[1]).toEqual({ id: "t2", type: "todo", checked: false, content: plain("b") });
  });

  it("mergeBlocks in un blocco di codice: i segni della frase unita non entrano", () => {
    const code: ProductBlock = { id: "c", type: "code", content: plain("x = 1") };
    expect(mergeBlocks(code, para("p", toggleMark(plain(" nota"), 1, 5, "bold")))).toEqual({
      id: "c",
      type: "code",
      content: plain("x = 1 nota"),
    });
  });

  it("mergeBlocks tiene id e tipo del primo", () => {
    const h: ProductBlock = { id: "h", type: "heading", level: 3, content: plain("Login only") };
    expect(mergeBlocks(h, para("p", "with Google"))).toEqual({
      id: "h",
      type: "heading",
      level: 3,
      content: plain("Login onlywith Google"),
    });
  });
});

describe("ancore e testo", () => {
  const img: ProductBlock = { id: "i", type: "image", src: "data:image/png;base64,AA", caption: "The sign-in screen", alt: "" };
  const blocks: ProductBlock[] = [
    para("p1", setLink(plain("Same words"), 0, 4, "https://secret.example/path")),
    para("p2", "Same words"),
    table("t", [["r1", ["Plan", "Price"]]]),
    img,
    { id: "d", type: "divider" },
  ];

  it("anchorIdsOf: il blocco, o le celle della tabella", () => {
    expect(anchorIdsOf(blocks[0]!)).toEqual(["p1"]);
    expect(anchorIdsOf(blocks[2]!)).toEqual(["r1-c0", "r1-c1"]);
    expect(anchorIdsOf(img)).toEqual(["i"]);
    expect(anchorIdsOf(blocks[4]!)).toEqual(["d"]);
  });

  it("anchorText: per id, anche con testi uguali; null per un'ancora che non c'è più", () => {
    expect(anchorText(blocks, "p1")).toBe("Same words");
    expect(anchorText(blocks, "p2")).toBe("Same words");
    expect(anchorText(blocks, "r1-c1")).toBe("Price");
    expect(anchorText(blocks, "i")).toBe("The sign-in screen");
    expect(anchorText(blocks, "r2-c0")).toBeNull();
    expect(anchorText(blocks, "t")).toBeNull();
  });

  it("plainTextOf: una riga per ancora, didascalie comprese, mai un href", () => {
    const text = plainTextOf(blocks);
    expect(text).toBe(["Same words", "Same words", "Plan", "Price", "The sign-in screen"].join("\n"));
    expect(text).not.toContain("secret.example");
  });

  it("excerptOfBlocks: il primo paragrafo non vuoto, al più 200", () => {
    const h: ProductBlock = { id: "h", type: "heading", level: 1, content: plain("Title") };
    expect(excerptOfBlocks([h, para("e", ""), para("x", "x".repeat(300))])).toBe("x".repeat(200));
    expect(excerptOfBlocks([h])).toBe("");
  });
});
