import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { productDocs, resetApi, setLatency } from "../api";
import type { MailMessage, ProductBlock, ProductFact, ProductSourceRef, RichText } from "../model";
import { CLAUDE_ID } from "../seed/people";
import { done, ext, mail, person } from "../seed/mail/helpers";
import { setSessionPersonId } from "../session";
import { state } from "../store";
import { applyProductSource, askProductQuestion, whenProductClaudeIdle } from "./claude";
import { acceptProductMarkAs, undoProductChangeAs } from "./markGestures";
import { listProductMarks, listProductMarksAs } from "./marks";
import { sourceViewOf } from "./sources";
import { deleteProductPage, writeProductBlocksAs } from "./writes";

// Il segno di Claude, «Va bene» e «Annulla» (11b, Task 3). Il segno è una
// riga per ancora scritta quando Claude cambia l'ancora (P14); si vede se
// nessuno ha toccato l'ancora dopo e nessuno ha detto «Va bene». «Va bene»
// vale per UNA frase (maintainer, 6 nov 2026). «Annulla» torna al `before`
// intero con una revisione `kind: "undo"` e `undoOf`, una per gesto.
//
// Pagina: Sign-in di ACQ. Claude (per conto di Laura, da una sua email)
// riscrive tre blocchi: il titolo signin-1, il paragrafo signin-2 (col
// grassetto «Google account») e il paragrafo signin-4. Laura e Marco hanno
// `docs.edit`, Sara la sola lettura.

const LAURA = "p-laura";
const MARCO = "p-marco";
const SARA = "p-sara";
const ACQ = "prj-acq";
const PAGE = "pp-acq-sign-in";
const H1 = "blk-acq-signin-1";
const HOW = "blk-acq-signin-2";
const STORES_HEADING = "blk-acq-signin-3";
const STORES = "blk-acq-signin-4";
const METER = "pp-acq-meter-reading";
const CELL = "blk-acq-meter-cell-2b";
const EMAIL = "mm-laura-1";

const pageOf = (id = PAGE) => state.productPages.find((p) => p.id === id)!;
const blockOf = (id: string, pageId = PAGE): ProductBlock | undefined =>
  pageOf(pageId).blocks.find((b) => b.id === id);
const revisionCount = () => state.productRevisions.filter((r) => r.pageId === PAGE).length;
const marksOf = (me: string, pageId = PAGE) => listProductMarksAs(me, pageId);
const anchorsOf = (me: string, pageId = PAGE) => marksOf(me, pageId).map((m) => m.anchorId);

function email(id: string, mailbox: string[]): MailMessage {
  return mail({
    id,
    threadId: `th-${id}`,
    from: ext("Fabio Rossi", "fabio@cliente.example"),
    to: mailbox.map(person),
    subject: "Login: confirmation",
    at: "2026-11-04T09:30:00Z",
    text: "body",
    mailboxPersonIds: mailbox,
    classification: done([ACQ], "normal"),
  });
}

const ref: ProductSourceRef = { kind: "email", id: EMAIL };
const plain = (text: string): RichText => ({ text, marks: [] });

let n = 0;
const replace = (anchorId: string, text: RichText, pageId = PAGE): ProductFact => ({
  id: `fact-${++n}`,
  pageId,
  anchorId,
  clarity: "clear",
  change: { kind: "replace", text },
});

/** Claude riscrive tre blocchi in UNA revisione; ne dà l'id. */
function threeChanges(): string {
  const out = applyProductSource(ref, ACQ, [
    replace(H1, plain("How customers sign in, with Google only")),
    replace(HOW, plain("Customers sign in with Google only.")),
    replace(STORES, plain("Only the name and the email address.")),
  ]);
  expect(out.edits).toHaveLength(1);
  return out.edits[0]!;
}

/** Una persona riscrive un blocco di testo a mano (l'editor, una sessione). */
function editByHand(personId: string, blockId: string, text: string): string {
  const block = blockOf(blockId)!;
  const { revisionId } = writeProductBlocksAs(
    personId,
    PAGE,
    [{ op: "set", block: { ...block, content: plain(text) } as ProductBlock }],
    { sessionId: `s-${personId}` },
  );
  return revisionId!;
}

async function revisionView(me: string, id: string) {
  setSessionPersonId(me);
  const rows = await productDocs.listProductRevisions(PAGE);
  return rows.find((r) => r.id === id)!;
}

beforeEach(() => {
  resetApi();
  setLatency(0);
  state.mailMessages.push(email(EMAIL, [LAURA]));
});
afterEach(async () => {
  await whenProductClaudeIdle();
  resetApi();
});

describe("il segno", () => {
  it("una modifica di Claude su tre blocchi: tre segni, ognuno con la sua revisione e il gruppo", () => {
    const rev = threeChanges();
    const marks = marksOf(LAURA);
    expect(marks.map((m) => m.anchorId)).toEqual([H1, HOW, STORES]);
    const groupId = state.productRevisions.find((r) => r.id === rev)!.groupId;
    for (const m of marks)
      expect(m).toMatchObject({
        revisionId: rev,
        groupId,
        actorId: LAURA,
        onBehalfOfId: LAURA,
        groupAnchors: 3,
        canAccept: true,
        undo: { enabled: true },
      });
    expect(marks[0]!.blockId).toBe(H1);
    // Le righe stanno nello stato: una per ancora, scritte con la revisione (P14).
    expect(state.productMarks.filter((m) => m.revisionId === rev)).toHaveLength(3);
  });

  it("«Va bene» su una frase toglie il suo segno a tutti, lascia gli altri e «Annulla» acceso", async () => {
    const rev = threeChanges();
    acceptProductMarkAs(LAURA, PAGE, HOW);
    expect(anchorsOf(LAURA)).toEqual([H1, STORES]);
    expect(anchorsOf(MARCO)).toEqual([H1, STORES]);
    expect(anchorsOf(SARA)).toEqual([H1, STORES]);
    const row = await revisionView(LAURA, rev);
    expect(row.undo).toEqual({ enabled: true });
    expect(row.undoByAnchor![HOW]).toEqual({ enabled: true });
  });

  it("un doppio «Va bene» scrive una volta sola", () => {
    threeChanges();
    acceptProductMarkAs(LAURA, PAGE, HOW);
    const before = JSON.stringify(state.productMarks);
    acceptProductMarkAs(LAURA, PAGE, HOW);
    expect(JSON.stringify(state.productMarks)).toBe(before);
  });

  it("una modifica a mano del blocco toglie il segno senza «Va bene»", () => {
    threeChanges();
    editByHand(MARCO, HOW, "Customers sign in with Google. Apple later.");
    expect(anchorsOf(LAURA)).toEqual([H1, STORES]);
    expect(state.productMarks.every((m) => m.acceptedById === null)).toBe(true);
  });

  it("una tabella: un segno per cella, con riga e colonna (P45)", () => {
    const out = applyProductSource(ref, ACQ, [replace(CELL, plain("Litres"), METER)]);
    expect(out.edits).toHaveLength(1);
    expect(marksOf(LAURA, METER)).toEqual([
      expect.objectContaining({ anchorId: CELL, blockId: "blk-acq-meter-table", cell: { row: 2, col: 2 } }),
    ]);
  });

  it("le revisioni `first_version` e `answer`, e una bozza di schermata, non hanno segno (P16)", () => {
    const how = blockOf(HOW)!;
    writeProductBlocksAs(
      LAURA,
      PAGE,
      [{ op: "set", block: { ...how, content: plain("First version.") } as ProductBlock }],
      { kind: "first_version", via: "claude", source: { kind: "first_version", ids: [EMAIL] } },
    );
    const stores = blockOf(STORES)!;
    writeProductBlocksAs(
      LAURA,
      PAGE,
      [{ op: "set", block: { ...stores, content: plain("Answered.") } as ProductBlock }],
      { kind: "answer" },
    );
    // Il blocco `wireframe` arriva col Task 7: qui un blocco con quel tipo basta.
    const sketch = { id: "blk-sketch-1", type: "wireframe" } as unknown as ProductBlock;
    writeProductBlocksAs(LAURA, PAGE, [{ op: "insert", afterId: STORES, block: sketch }], {
      kind: "edit",
      via: "claude",
      source: ref,
      groupId: "pgrp-sketch",
    });
    expect(marksOf(LAURA)).toEqual([]);
    expect(state.productMarks).toEqual([]);
  });

  it("chi non legge i Docs del progetto non vede segni", () => {
    threeChanges();
    expect(marksOf("p-giulia")).toEqual([]);
  });

  it("la lettura dal cancello è quella di chi guarda", async () => {
    threeChanges();
    setSessionPersonId(SARA);
    expect((await listProductMarks(PAGE)).map((m) => m.anchorId)).toEqual([H1, HOW, STORES]);
  });

  it("eliminare la pagina toglie i suoi segni", async () => {
    threeChanges();
    setSessionPersonId(LAURA);
    await deleteProductPage(PAGE);
    expect(state.productMarks).toEqual([]);
  });
});

describe("«Annulla» (Review Focus 4)", () => {
  it("Marco tocca un blocco: il suo «Annulla» e «Annulla tutto» sono spenti col suo nome", async () => {
    const rev = threeChanges();
    editByHand(MARCO, H1, "How you sign in");
    const h1 = marksOf(LAURA).find((m) => m.anchorId === H1);
    expect(h1).toBeUndefined();
    const row = await revisionView(LAURA, rev);
    expect(row.undoByAnchor![H1]).toEqual({ enabled: false, reason: "changed_after", byId: MARCO });
    expect(row.undo).toEqual({ enabled: false, reason: "changed_after", byId: MARCO });
    const count = revisionCount();
    expect(() => undoProductChangeAs(LAURA, rev)).toThrow("refused: changed_after");
    expect(() => undoProductChangeAs(LAURA, rev, H1)).toThrow("refused: changed_after");
    expect(revisionCount()).toBe(count);
  });

  it("gli altri due si annullano uno per uno e tornano al `before` intero, segni compresi", async () => {
    const original = (id: string) => structuredClone(blockOf(id)!);
    const how = original(HOW);
    const stores = original(STORES);
    expect("content" in how && how.content.marks.length).toBeGreaterThan(0);
    const rev = threeChanges();
    editByHand(MARCO, H1, "How you sign in");

    const first = undoProductChangeAs(LAURA, rev, HOW);
    expect(blockOf(HOW)).toEqual(how);
    expect(anchorsOf(LAURA)).toEqual([STORES]);
    const second = undoProductChangeAs(LAURA, rev, STORES);
    expect(blockOf(STORES)).toEqual(stores);
    expect(anchorsOf(LAURA)).toEqual([]);

    const undos = state.productRevisions.filter((r) => r.kind === "undo");
    expect(undos.map((u) => u.id)).toEqual([first.revisionId, second.revisionId]);
    expect(undos.every((u) => u.undoOf === rev && u.actorId === LAURA && u.via === undefined)).toBe(true);

    const undoneRow = await revisionView(LAURA, first.revisionId);
    expect(undoneRow).toMatchObject({ kind: "undo", undoOf: rev });
    const row = await revisionView(LAURA, rev);
    expect(row.undoneCount).toEqual({ done: 2, count: 3 });
    expect(row.undoneById).toBe(LAURA);
    expect(row.undoByAnchor![HOW]).toEqual({ enabled: false, reason: "already_undone", byId: LAURA });
    // H1 resta di Marco: «Annulla tutto» resta spento col suo nome.
    expect(row.undo).toEqual({ enabled: false, reason: "changed_after", byId: MARCO });
  });

  it("«Annulla tutto» annulla le tre in UNA revisione, che la card conta come annullata", async () => {
    const rev = threeChanges();
    const count = revisionCount();
    const { revisionId } = undoProductChangeAs(MARCO, rev);
    expect(revisionCount()).toBe(count + 1);
    const undo = state.productRevisions.find((r) => r.id === revisionId)!;
    expect(undo).toMatchObject({ kind: "undo", undoOf: rev, actorId: MARCO });
    expect(new Set(undo.changes.flatMap((c) => c.anchors))).toEqual(new Set([H1, HOW, STORES]));
    expect(marksOf(LAURA)).toEqual([]);
    const row = await revisionView(LAURA, rev);
    expect(row.undo).toEqual({ enabled: false, reason: "already_undone", byId: MARCO });
    expect(row.undoneCount).toEqual({ done: 3, count: 3 });
  });

  it("un secondo «Annulla» della stessa cosa: `already_undone`, nessuna scrittura (doppio clic)", () => {
    const rev = threeChanges();
    undoProductChangeAs(LAURA, rev, HOW);
    const count = revisionCount();
    const page = JSON.stringify(pageOf().blocks);
    expect(() => undoProductChangeAs(LAURA, rev, HOW)).toThrow("refused: already_undone");
    expect(revisionCount()).toBe(count);
    expect(JSON.stringify(pageOf().blocks)).toBe(page);

    undoProductChangeAs(LAURA, rev);
    const all = revisionCount();
    expect(() => undoProductChangeAs(LAURA, rev)).toThrow("refused: already_undone");
    expect(revisionCount()).toBe(all);
  });

  it("annullare un blocco aggiunto da Claude lo toglie", () => {
    const added: ProductBlock = { id: "blk-x", type: "paragraph", content: plain("Apple is not offered.") };
    const out = applyProductSource(ref, ACQ, [
      { id: "fact-add", pageId: PAGE, anchorId: STORES, clarity: "clear", change: { kind: "insert_after", block: added } },
    ]);
    const [mark] = marksOf(LAURA);
    expect(mark).toBeDefined();
    const ids = pageOf().blocks.map((b) => b.id);
    undoProductChangeAs(LAURA, out.edits[0]!, mark!.anchorId);
    expect(pageOf().blocks.map((b) => b.id)).toEqual(ids.filter((id) => id !== mark!.anchorId));
  });

  it("una tabella aggiunta da Claude: Marco scrive in un'altra cella, «Annulla» della cella di Claude è spento", async () => {
    const cell = (id: string, text: string) => ({ id, content: plain(text) });
    const table: ProductBlock = {
      id: "blk-t",
      type: "table",
      rows: [
        { id: "blk-t-r1", cells: [cell("blk-t-a", "Meter"), cell("blk-t-b", "Reading")] },
        { id: "blk-t-r2", cells: [cell("blk-t-c", "Home"), cell("blk-t-d", "Cubic metres")] },
      ],
    };
    const out = applyProductSource(ref, ACQ, [
      { id: "fact-table", pageId: PAGE, anchorId: STORES, clarity: "clear", change: { kind: "insert_after", block: table } },
    ]);
    const rev = out.edits[0]!;
    const inserted = pageOf().blocks[pageOf().blocks.findIndex((b) => b.id === STORES) + 1]!;
    expect(inserted.type).toBe("table");
    if (inserted.type !== "table") return;
    const [first, second] = inserted.rows[0]!.cells;
    const edited = structuredClone(inserted);
    edited.rows[0]!.cells[1]!.content = plain("Marco's reading");
    writeProductBlocksAs(MARCO, PAGE, [{ op: "set", block: edited }], { sessionId: "s-m" });

    const mark = marksOf(LAURA).find((m) => m.anchorId === first!.id)!;
    expect(mark.undo).toEqual({ enabled: false, reason: "changed_after", byId: MARCO });
    const row = await revisionView(LAURA, rev);
    expect(row.undo).toEqual({ enabled: false, reason: "changed_after", byId: MARCO });
    expect(() => undoProductChangeAs(LAURA, rev, first!.id)).toThrow("refused: changed_after");
    expect(() => undoProductChangeAs(LAURA, rev)).toThrow("refused: changed_after");
    const now = pageOf().blocks.find((b) => b.id === inserted.id);
    expect(now?.type === "table" && now.rows[0]!.cells[1]!.content).toEqual(plain("Marco's reading"));
    expect(second).toBeDefined();
  });

  it("Sara senza `docs.edit`: `canAccept: false` e `no_permission` senza nome", async () => {
    const rev = threeChanges();
    const marks = marksOf(SARA);
    expect(marks).toHaveLength(3);
    for (const m of marks) {
      expect(m.canAccept).toBe(false);
      expect(m.undo).toEqual({ enabled: false, reason: "no_permission", byId: null });
    }
    const row = await revisionView(SARA, rev);
    expect(row.undo).toEqual({ enabled: false, reason: "no_permission", byId: null });
    expect(() => acceptProductMarkAs(SARA, PAGE, HOW)).toThrow("forbidden");
    expect(() => undoProductChangeAs(SARA, rev)).toThrow("refused: no_permission");
    expect(anchorsOf(LAURA)).toEqual([H1, HOW, STORES]);
  });

  it("una revisione che non è di Claude non si annulla da qui", () => {
    const mine = editByHand(MARCO, HOW, "By hand.");
    expect(() => undoProductChangeAs(LAURA, mine)).toThrow("invalid: revision");
    expect(() => undoProductChangeAs(LAURA, "prev-nope")).toThrow("not_found");
  });
});

describe("unione e cancellazione", () => {
  it("un'unione porta il segno sul blocco unito, e l'«Annulla» è spento con chi ha unito", () => {
    const out = applyProductSource(ref, ACQ, [replace(STORES, plain("Only the name."))]);
    const rev = out.edits[0]!;
    writeProductBlocksAs(MARCO, PAGE, [{ op: "merge", firstId: STORES_HEADING, secondId: STORES }], {
      sessionId: "s-marco",
    });
    const marks = marksOf(LAURA);
    expect(marks.map((m) => m.anchorId)).toEqual([STORES_HEADING]);
    expect(marks[0]).toMatchObject({
      revisionId: rev,
      undo: { enabled: false, reason: "changed_after", byId: MARCO },
    });
  });

  it("Marco riscrive la frase, poi (in un'altra sessione) la unisce al titolo: il segno non torna", () => {
    applyProductSource(ref, ACQ, [replace(STORES, plain("Only the name."))]);
    editByHand(MARCO, STORES, "Marco's own sentence.");
    expect(anchorsOf(LAURA)).toEqual([]);
    writeProductBlocksAs(MARCO, PAGE, [{ op: "merge", firstId: STORES_HEADING, secondId: STORES }], {
      sessionId: "s-marco-2",
    });
    expect(anchorsOf(LAURA)).toEqual([]);
  });

  it("una cancellazione toglie il segno; il ⌘Z della cancellazione lo rimette, con lo stesso id", () => {
    const rev = threeChanges();
    const how = structuredClone(blockOf(HOW)!);
    const del = writeProductBlocksAs(MARCO, PAGE, [{ op: "delete", blockId: HOW }], { sessionId: "s-m" });
    expect(anchorsOf(LAURA)).toEqual([H1, STORES]);
    writeProductBlocksAs(MARCO, PAGE, [{ op: "insert", afterId: H1, block: how }], {
      sessionId: "s-m",
      undoOf: del.revisionId!,
    });
    expect(anchorsOf(LAURA)).toEqual([H1, HOW, STORES]);
    expect(marksOf(LAURA).find((m) => m.anchorId === HOW)).toMatchObject({
      revisionId: rev,
      undo: { enabled: true },
    });
  });

  it("scritta, poi cancellata nella stessa sessione, poi rimessa col ⌘Z: la frase è di Marco, niente segno", () => {
    threeChanges();
    const how = blockOf(HOW)!;
    const typed = { ...how, content: plain("Marco's own sentence.") } as ProductBlock;
    writeProductBlocksAs(MARCO, PAGE, [{ op: "set", block: typed }], { sessionId: "s-m" });
    // La cancellazione si unisce alla scrittura di prima (stessa sessione): una revisione sola.
    const del = writeProductBlocksAs(MARCO, PAGE, [{ op: "delete", blockId: HOW }], { sessionId: "s-m" });
    writeProductBlocksAs(MARCO, PAGE, [{ op: "insert", afterId: H1, block: typed }], {
      sessionId: "s-m",
      undoOf: del.revisionId!,
    });
    expect(anchorsOf(LAURA)).toEqual([H1, STORES]);
    // E «Annulla» non cancella la frase di Marco.
    const rev = state.productRevisions.find((r) => r.via === "claude")!.id;
    expect(() => undoProductChangeAs(LAURA, rev, HOW)).toThrow("refused: changed_after");
    expect(blockOf(HOW)).toEqual(typed);
  });
});

describe("la riga di cronologia", () => {
  it("una modifica di Claude per conto di Laura: `onBehalfOfId` e la fonte vista da chi guarda", async () => {
    const rev = threeChanges();
    const laura = await revisionView(LAURA, rev);
    expect(laura.onBehalfOfId).toBe(LAURA);
    expect(laura.sourceView).toEqual(sourceViewOf(LAURA, ref, ACQ));
    expect(laura.sourceView!.link).not.toBeNull();
    const sara = await revisionView(SARA, rev);
    expect(sara.sourceView).toEqual(sourceViewOf(SARA, ref, ACQ));
    expect(sara.sourceView!.link).toBeNull();
    expect(JSON.stringify(sara).toLowerCase()).not.toContain("login: confirmation");
  });

  it("il Claude collega (una task chiusa): niente `onBehalfOfId`", async () => {
    const out = applyProductSource({ kind: "task", id: "t-acq-7" }, ACQ, [
      { id: "fact-task", pageId: PAGE, anchorId: STORES, clarity: "clear", change: { kind: "link_task", taskCode: "ACQ-7" } },
    ]);
    const row = await revisionView(LAURA, out.edits[0]!);
    expect(row.actorId).toBe(CLAUDE_ID);
    expect(row.onBehalfOfId).toBeUndefined();
    expect(row.sourceView?.kind).toBe("task");
    expect(row.undo).toEqual({ enabled: true });
  });

  it("le righe delle persone non hanno campi di Claude", async () => {
    const mine = editByHand(MARCO, HOW, "By hand.");
    const row = await revisionView(LAURA, mine);
    expect(row.undo).toBeUndefined();
    expect(row.onBehalfOfId).toBeUndefined();
    expect(row.sourceView).toBeUndefined();
    expect(row.answerOf).toBeUndefined();
  });

  it("la risposta «Aggiorna così» porta il filo della domanda (`answerOf`, P19)", async () => {
    const commentId = askProductQuestion(
      PAGE,
      HOW,
      replace(HOW, plain("Maybe Apple too.")),
      ref,
      "vague",
    );
    const how = blockOf(HOW)!;
    const { revisionId } = writeProductBlocksAs(
      LAURA,
      PAGE,
      [{ op: "set", block: { ...how, content: plain("Maybe Apple too.") } as ProductBlock }],
      { kind: "answer" },
    );
    const comment = state.productComments.find((c) => c.id === commentId)!;
    comment.question!.answer = { byId: LAURA, option: "apply", seq: 1, revisionId };
    const row = await revisionView(LAURA, revisionId!);
    expect(row.answerOf).toBe(commentId);
    expect(row.undo).toBeUndefined();
  });
});
