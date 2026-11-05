import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { plain, toggleMark } from "../../domain/productDocs/richText";
import { productDocs, resetApi, setLatency } from "../api";
import type { ProductBlock, ProductPage } from "../model";
import { setSessionPersonId } from "../session";
import { state } from "../store";

// Le revisioni della doc di prodotto (area 11a, Task 2): l'unione per
// sessione, l'ordine col `lastSeq` (ruling P12) e `touchedAfter`. Laura e
// Marco hanno `docs.edit` in ACQ. Le due ancore dei test hanno testi
// DIVERSI e le sessioni sono scritte a mano: nessun helper toglie la
// condizione che il test prova (lezione (c)).

const LAURA = "p-laura";
const MARCO = "p-marco";
const ACQ = "prj-acq";

const as = (personId: string) => setSessionPersonId(personId);
const para = (id: string, text: string): ProductBlock => ({
  id,
  type: "paragraph",
  content: plain(text),
});
const editsOf = (pageId: string) =>
  state.productRevisions.filter((r) => r.pageId === pageId && r.kind === "edit");

/** Una pagina di Laura con due paragrafi: `A` («Alpha») e `B` («Beta»). */
async function page(): Promise<{ page: ProductPage; a: string; b: string }> {
  as(LAURA);
  const created = await productDocs.createProductPage(ACQ, { title: "Payments" });
  const a = created.blocks[0]!.id;
  const written = await productDocs.saveProductBlocks(
    created.id,
    [
      { op: "set", block: para(a, "Alpha") },
      { op: "insert", afterId: a, block: para("b-beta", "Beta") },
    ],
    { sessionId: "setup" },
  );
  return { page: written, a, b: "b-beta" };
}

beforeEach(() => {
  resetApi();
  setLatency(0);
});
afterEach(() => resetApi());

describe("l'unione per sessione", () => {
  it("due scritture della stessa sessione: una revisione, col primo before e l'ultimo after", async () => {
    const { page: p, a } = await page();
    await productDocs.saveProductBlocks(p.id, [{ op: "set", block: para(a, "Alpha 1") }], {
      sessionId: "s-laura",
    });
    await productDocs.saveProductBlocks(p.id, [{ op: "set", block: para(a, "Alpha 2") }], {
      sessionId: "s-laura",
    });
    const laura = editsOf(p.id).filter((r) => r.sessionId === "s-laura");
    expect(laura).toHaveLength(1);
    const change = laura[0]!.changes.find((c) => c.blockId === a)!;
    expect(change.before).toEqual(para(a, "Alpha"));
    expect(change.after).toEqual(para(a, "Alpha 2"));
    expect(change.anchors).toEqual([a]);
    expect(laura[0]!.lastSeq).toBeGreaterThan(laura[0]!.seq);
  });

  it("una scrittura di Marco in mezzo: tre revisioni, in ordine di seq", async () => {
    const { page: p, a, b } = await page();
    await productDocs.saveProductBlocks(p.id, [{ op: "set", block: para(a, "Alpha 1") }], {
      sessionId: "s-laura",
    });
    as(MARCO);
    await productDocs.saveProductBlocks(p.id, [{ op: "set", block: para(b, "Beta M") }], {
      sessionId: "s-marco",
    });
    as(LAURA);
    await productDocs.saveProductBlocks(p.id, [{ op: "set", block: para(a, "Alpha 2") }], {
      sessionId: "s-laura",
    });
    const edits = editsOf(p.id).filter((r) => r.sessionId !== "setup");
    expect(edits.map((r) => [r.actorId, r.sessionId])).toEqual([
      [LAURA, "s-laura"],
      [MARCO, "s-marco"],
      [LAURA, "s-laura"],
    ]);
    const seqs = edits.map((r) => r.seq);
    expect([...seqs].sort((x, y) => x - y)).toEqual(seqs);
    // La cronologia: dalla più recente.
    const listed = await productDocs.listProductRevisions(p.id);
    expect(listed.slice(0, 3).map((r) => r.actorName)).toEqual([
      "Laura Costa",
      "Marco Bellini",
      "Laura Costa",
    ]);
  });

  it("una scrittura che lascia tutto com'era non scrive revisioni; un'ancora tornata com'era esce dai cambi", async () => {
    const { page: p, a, b } = await page();
    const before = state.productRevisions.length;
    await productDocs.saveProductBlocks(p.id, [{ op: "set", block: para(a, "Alpha") }], {
      sessionId: "s-laura",
    });
    expect(state.productRevisions.length).toBe(before);
    await productDocs.saveProductBlocks(
      p.id,
      [
        { op: "set", block: para(a, "Alpha!") },
        { op: "set", block: para(b, "Beta!") },
      ],
      { sessionId: "s-laura" },
    );
    await productDocs.saveProductBlocks(p.id, [{ op: "set", block: para(a, "Alpha") }], {
      sessionId: "s-laura",
    });
    const [rev] = editsOf(p.id).filter((r) => r.sessionId === "s-laura");
    expect(rev!.changes.map((c) => c.blockId)).toEqual([b]);
  });

  it("un set che mette solo un grassetto: una revisione col blocco senza segno in before", async () => {
    const { page: p, a } = await page();
    const bold: ProductBlock = { id: a, type: "paragraph", content: toggleMark(plain("Alpha"), 0, 5, "bold") };
    await productDocs.saveProductBlocks(p.id, [{ op: "set", block: bold }], { sessionId: "s-laura" });
    const [rev] = editsOf(p.id).filter((r) => r.sessionId === "s-laura");
    expect(rev!.changes).toEqual([
      { blockId: a, before: para(a, "Alpha"), after: bold, anchors: [a] },
    ]);
  });

  it("senza sessione, con un altro tipo o dopo una revisione d'altro tipo non si unisce", async () => {
    const { page: p, a } = await page();
    await productDocs.saveProductBlocks(p.id, [{ op: "set", block: para(a, "One") }], {
      sessionId: "s-laura",
    });
    await productDocs.renameProductPage(p.id, "Payments 2");
    await productDocs.saveProductBlocks(p.id, [{ op: "set", block: para(a, "Two") }], {
      sessionId: "s-laura",
    });
    productDocs.writeProductBlocksAs(LAURA, p.id, [{ op: "set", block: para(a, "Three") }], {});
    productDocs.writeProductBlocksAs(LAURA, p.id, [{ op: "set", block: para(a, "Four") }], {});
    const laura = editsOf(p.id).filter((r) => r.sessionId !== "setup");
    expect(laura).toHaveLength(4);
    expect(laura.every((r) => r.via === undefined && r.source === undefined)).toBe(true);
  });
});

describe("una scrittura con source, groupId o undoOf non si unisce", () => {
  it("nella stessa sessione nasce una revisione nuova, che tiene i suoi campi", async () => {
    const { page: p, a } = await page();
    await productDocs.saveProductBlocks(p.id, [{ op: "set", block: para(a, "One") }], {
      sessionId: "s-laura",
    });
    const metas = [
      { source: { kind: "email" as const, id: "mail-1" } },
      { groupId: "grp-1" },
      { undoOf: "prev-1" },
    ];
    metas.forEach((meta, i) =>
      productDocs.writeProductBlocksAs(LAURA, p.id, [{ op: "set", block: para(a, `Two ${i}`) }], {
        sessionId: "s-laura",
        ...meta,
      }),
    );
    const laura = editsOf(p.id).filter((r) => r.sessionId === "s-laura");
    expect(laura).toHaveLength(4);
    expect(laura[1]).toMatchObject(metas[0]!);
    expect(laura[2]).toMatchObject(metas[1]!);
    expect(laura[3]).toMatchObject(metas[2]!);
  });
});

describe("touchedAfter", () => {
  it("la revisione di Marco dopo seq su quell'ancora; null se dopo hanno toccato solo altre ancore", async () => {
    const { page: p, a, b } = await page();
    const seq = state.alertSeq;
    as(MARCO);
    await productDocs.saveProductBlocks(p.id, [{ op: "set", block: para(b, "Beta M") }], {
      sessionId: "s-marco",
    });
    expect(productDocs.touchedAfter(p.id, a, seq)).toBeNull();
    await productDocs.saveProductBlocks(p.id, [{ op: "set", block: para(a, "Alpha M") }], {
      sessionId: "s-marco-2",
    });
    expect(productDocs.touchedAfter(p.id, a, seq)).toMatchObject({ actorId: MARCO, sessionId: "s-marco-2" });
    expect(productDocs.touchedAfter(p.id, a, state.alertSeq)).toBeNull();
  });

  it("P12: una scrittura unita a una revisione nata PRIMA di seq la rende «dopo»", async () => {
    const { page: p, a, b } = await page();
    await productDocs.saveProductBlocks(p.id, [{ op: "set", block: para(b, "Beta 1") }], {
      sessionId: "s-laura",
    });
    const seq = state.alertSeq;
    // La stessa sessione torna a scrivere, su A, dopo `seq`: si unisce.
    await productDocs.saveProductBlocks(p.id, [{ op: "set", block: para(a, "Alpha 1") }], {
      sessionId: "s-laura",
    });
    const rev = productDocs.touchedAfter(p.id, a, seq);
    expect(rev).not.toBeNull();
    expect(rev!.seq).toBeLessThanOrEqual(seq);
    expect(rev!.lastSeq).toBeGreaterThan(seq);
  });
});
