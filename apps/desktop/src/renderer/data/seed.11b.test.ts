import { beforeEach, describe, expect, it } from "vitest";
import { anchorIdsOf, anchorText } from "../domain/productDocs/blocks";
import { decideFact } from "../domain/productDocs/claudeRule";
import { productDocs, resetApi, setLatency } from "./api";
import { listProductMarksAs } from "./productDocs/marks";
import { productQuestionDecisions } from "./productDocs/questions";
import { sourceViewOf } from "./productDocs/sources";
import { productFactsOf } from "./productDocs/sourceEvents";
import { CLAUDE_ID } from "./seed/people";
import {
  PRODUCT_COMMENTS,
  PRODUCT_COMMENTS_11B,
  PRODUCT_REVISIONS,
  PRODUCT_REVISIONS_11B,
} from "./seed/productDocs";
import {
  ACQ_11B,
  PRODUCT_SCRIPTED_SOURCE_KEYS,
  PRODUCT_SOURCE_FACTS,
} from "./seed/productDocs/facts";
import { setSessionPersonId } from "./session";
import { state } from "./store";
import type { ProductFact, ProductFactDecision, ProductSourceRef } from "./types";

// Il seme del 11b per ACQ (Task 5): quello che Claude ha già fatto nella doc
// di prodotto si legge con le funzioni dei Task 1–4, i suoi id non toccano
// quelli del 11a, e i fatti dei copioni coprono le tre uscite della regola.

const LAURA = "p-laura";
const MARCO = "p-marco";
const SARA = "p-sara";
const ACQ = "prj-acq";
const PAGE = {
  signIn: "pp-acq-sign-in",
  bills: "pp-acq-bills",
  meter: "pp-acq-meter-reading",
  decisions: "pp-acq-client-decisions",
  faults: "pp-acq-fault-reports",
  phases: "pp-acq-phases",
} as const;

const as = (personId: string) => setSessionPersonId(personId);
const page = (id: string) => state.productPages.find((p) => p.id === id)!;

beforeEach(() => {
  setLatency(0);
  resetApi();
});

describe("Sign-in: la modifica dall'email di Laura", () => {
  it("è segnata, per conto di Laura, con «Annulla» acceso", () => {
    const marks = listProductMarksAs(LAURA, PAGE.signIn);
    expect(marks).toHaveLength(1);
    expect(marks[0]).toMatchObject({
      anchorId: "blk-acq-signin-5",
      actorId: LAURA,
      onBehalfOfId: LAURA,
      canAccept: true,
      undo: { enabled: true },
      source: { kind: "email", ownerId: LAURA, gone: false, link: "#/mail/th-acq-signin-google" },
    });
    expect(anchorText(page(PAGE.signIn).blocks, "blk-acq-signin-5")).toBe(
      "Google is the only way in: there is no password of our own and no other kind of account.",
    );
  });

  it("a Sara, che non ha ricevuto l'email, dice solo «da un'email di Laura Costa · data»", () => {
    const [mark] = listProductMarksAs(SARA, PAGE.signIn);
    expect(mark!.source).toMatchObject({
      label: { key: "productDocs.source.emailOf", params: { owner: "Laura Costa" } },
      link: null,
      code: null,
    });
    const json = JSON.stringify(mark).toLowerCase();
    for (const hidden of ["google accounts only", "portal sign-in", "kick-off", "th-acq-signin"])
      expect(json).not.toContain(hidden);
  });

  it("ha la card `product_doc.updated` a chi segue la pagina: Laura e Marco, non Sara", () => {
    const cards = state.notifications.filter(
      (n) => n.kind === "product_doc.updated" && n.productUpdate?.pageId === PAGE.signIn,
    );
    expect(cards).toHaveLength(1);
    expect([...cards[0]!.recipientIds].sort()).toEqual([LAURA, MARCO]);
    expect(cards[0]!.productUpdate).toEqual({
      pageId: PAGE.signIn,
      revisionIds: ["prev-acq11b-signin"],
      sources: [{ kind: "email", id: ACQ_11B.signInEmailId }],
    });
  });
});

describe("Bills: la domanda nata da una riunione", () => {
  it("è aperta, vaga, con la riunione come fonte; Claude consiglia «Lascia com'è»", async () => {
    as(LAURA);
    const { open } = await productDocs.listProductComments(PAGE.bills);
    const root = open.map((t) => t.root).find((c) => c.id === "pc-acq11b-bills-q")!;
    expect(root.authorId).toBe(CLAUDE_ID);
    expect(root.question).toMatchObject({
      reason: "vague",
      applyMode: "insert",
      recommended: "keep",
      canAnswer: true,
      answer: null,
      source: {
        kind: "meeting",
        ownerId: LAURA,
        label: {
          key: "productDocs.source.meeting",
          params: { title: "Portal review with Acquedotto delle Colline" },
        },
      },
    });
  });

  it("è in «Decidi» di Laura (insieme a quella di Meter reading), non in quello di Sara", () => {
    expect(productQuestionDecisions(LAURA).map((d) => d.commentId)).toEqual([
      "pc-acq11b-bills-q",
      "pc-acq11b-meter-q",
    ]);
    expect(productQuestionDecisions(SARA)).toEqual([]);
  });

  it("chi non era alla riunione legge «da una riunione di Laura Costa»", () => {
    const view = sourceViewOf(SARA, { kind: "meeting", id: ACQ_11B.meetingId }, ACQ);
    expect(view).toMatchObject({
      label: { key: "productDocs.source.meetingOf", params: { owner: "Laura Costa" } },
      link: null,
    });
  });
});

describe("Meter reading: la divergenza da una task chiusa", () => {
  it("è aperta, con il codice della task e la frase proposta", async () => {
    expect(state.tasksById.get(ACQ_11B.closedTaskId)!.closedAt).not.toBeNull();
    as(LAURA);
    const { open } = await productDocs.listProductComments(PAGE.meter);
    const root = open.map((t) => t.root).find((c) => c.id === "pc-acq11b-meter-q")!;
    expect(root.anchorId).toBe("blk-acq-meter-4");
    expect(root.question).toMatchObject({
      reason: "diverges",
      taskCode: "ACQ-8",
      recommended: "apply",
      built:
        "A reading lower than the previous one is accepted when the meter was replaced in the same month.",
      source: { kind: "task", code: "ACQ-8" },
    });
  });
});

describe("Client decisions: la modifica da una decisione, già accettata", () => {
  it("non ha più il segno, ma in cronologia «Annulla» resta, con la decisione come fonte", async () => {
    expect(listProductMarksAs(LAURA, PAGE.decisions)).toEqual([]);
    expect(state.productMarks.find((m) => m.pageId === PAGE.decisions)).toMatchObject({
      anchorId: "blk-acq-decisions-4",
      acceptedById: LAURA,
    });
    as(LAURA);
    const rows = await productDocs.listProductRevisions(PAGE.decisions);
    const row = rows.find((r) => r.id === "prev-acq11b-decisions")!;
    expect(row).toMatchObject({
      actorId: CLAUDE_ID,
      via: "claude",
      undo: { enabled: true },
      sourceView: {
        kind: "decision",
        label: {
          key: "productDocs.source.decision",
          params: { title: "Fault photos up to 10 MB" },
        },
      },
    });
    expect(page(PAGE.decisions).blocks.find((b) => b.id === "blk-acq-decisions-4")).toEqual({
      id: "blk-acq-decisions-4",
      type: "decision",
      decisionId: ACQ_11B.decisionId,
    });
  });
});

describe("Fault reports: il segno di un'email che non c'è più", () => {
  it("dice «Fonte non più disponibile», e «Annulla» resta", () => {
    expect(state.mailMessages.some((m) => m.id === ACQ_11B.goneEmailId)).toBe(false);
    const marks = listProductMarksAs(LAURA, PAGE.faults);
    expect(marks).toHaveLength(1);
    expect(marks[0]).toMatchObject({
      anchorId: "blk-acq-faults-2",
      undo: { enabled: true },
      source: { gone: true, label: { key: "productDocs.source.gone" }, ownerId: null },
    });
  });
});

describe("Phases: le richieste nate dalla doc", () => {
  it("sono due, ciascuna sulla sua frase, e dalla prima è nata una task", () => {
    const fromDoc = state.requests.filter((r) => r.origin?.kind === "product_doc");
    expect(fromDoc.map((r) => r.id)).toEqual(ACQ_11B.requestIds);
    const anchors = page(PAGE.phases).blocks.flatMap(anchorIdsOf);
    for (const r of fromDoc) {
      expect(r.origin).toMatchObject({ kind: "product_doc", pageId: PAGE.phases });
      expect(anchors).toContain((r.origin as { anchorId: string }).anchorId);
      expect(r.requesterIds).toEqual([LAURA]);
    }
    const task = state.tasksById.get(ACQ_11B.requestTaskId)!;
    expect(task).toMatchObject({ code: "ACQ-10", projectId: ACQ, requestId: "req-acq-6" });
    expect(fromDoc[0]!.taskIds).toEqual([task.id]);
  });
});

describe("id, codici e `seq` del 11b", () => {
  it("non toccano quelli del 11a", () => {
    const revs = [...PRODUCT_REVISIONS, ...PRODUCT_REVISIONS_11B].map((r) => r.id);
    expect(new Set(revs).size).toBe(revs.length);
    const comments = [...PRODUCT_COMMENTS, ...PRODUCT_COMMENTS_11B].map((c) => c.id);
    expect(new Set(comments).size).toBe(comments.length);
    const cards = state.notifications.map((n) => n.id);
    expect(new Set(cards).size).toBe(cards.length);
    const marks = state.productMarks.map((m) => m.id);
    expect(new Set(marks).size).toBe(marks.length);
    for (const p of state.productPages) {
      const ids = p.blocks.flatMap((b) => [b.id, ...anchorIdsOf(b)]);
      for (const id of ids) expect(state.productBlockIds.has(id), id).toBe(true);
    }
    const codes = state.tasks.filter((t) => t.projectId === ACQ).map((t) => t.code);
    expect(new Set(codes).size).toBe(codes.length);
    const requestCodes = state.requests.map((r) => r.code);
    expect(new Set(requestCodes).size).toBe(requestCodes.length);
  });

  it("i `seq` vengono dopo il 11a e crescono con la data", () => {
    const max11a = Math.max(
      ...PRODUCT_REVISIONS.map((r) => r.lastSeq),
      ...PRODUCT_COMMENTS.map((c) => c.seq),
    );
    const rows = [
      ...PRODUCT_REVISIONS_11B.map((r) => ({ at: r.at, seq: r.seq })),
      ...PRODUCT_COMMENTS_11B.map((c) => ({ at: c.createdAt, seq: c.seq })),
    ];
    for (const r of rows) expect(r.seq).toBeGreaterThan(max11a);
    const byTime = [...rows].sort((a, b) => a.at.localeCompare(b.at)).map((r) => r.seq);
    expect(byTime).toEqual([...byTime].sort((a, b) => a - b));
  });

  it("ogni revisione di Claude riporta lo stato di adesso, e ha una riga del segno per ancora", () => {
    for (const r of PRODUCT_REVISIONS_11B) {
      for (const c of r.changes) {
        expect(c.after, r.id).toEqual(page(r.pageId).blocks.find((b) => b.id === c.blockId));
        for (const anchorId of c.anchors)
          expect(
            state.productMarks.some((m) => m.revisionId === r.id && m.anchorId === anchorId),
          ).toBe(true);
      }
    }
  });
});

/** Il contesto che il motore darebbe alla regola sulla pagina di adesso, per un titolare con `docs.edit`. */
function decide(fact: ProductFact): ProductFactDecision {
  const p = page(fact.pageId);
  return decideFact(fact, {
    lastWriterIsPerson: false,
    actorCanEdit: true,
    changedByPersonSinceArrival: false,
    anchorExists: fact.anchorId === null || anchorText(p.blocks, fact.anchorId) !== null,
  });
}

describe("i fatti del seme", () => {
  it("quelli dei copioni coprono le tre uscite della regola: modifica, domanda, niente", () => {
    const kinds = new Set(
      PRODUCT_SCRIPTED_SOURCE_KEYS.flatMap((key) =>
        PRODUCT_SOURCE_FACTS[key]!.map((f) => decide(f).kind),
      ),
    );
    expect(kinds).toEqual(new Set(["edit", "question", "none"]));
  });

  it("quelli già arrivati sono le uscite che il seme racconta", () => {
    const facts = (ref: ProductSourceRef) => productFactsOf(ref).map((f) => decide(f));
    expect(facts({ kind: "email", id: ACQ_11B.signInEmailId })).toEqual([{ kind: "edit" }]);
    expect(facts({ kind: "email", id: ACQ_11B.goneEmailId })).toEqual([{ kind: "edit" }]);
    expect(facts({ kind: "decision", id: ACQ_11B.decisionId })).toEqual([{ kind: "edit" }]);
    expect(facts({ kind: "meeting", id: ACQ_11B.meetingId })).toEqual([
      { kind: "question", reason: "vague" },
    ]);
    expect(facts({ kind: "task", id: ACQ_11B.closedTaskId })).toEqual([
      { kind: "question", reason: "diverges" },
    ]);
  });

  it("le fonti già arrivate risultano viste dal motore", () => {
    for (const key of [
      `email:${ACQ_11B.signInEmailId}`,
      `email:${ACQ_11B.goneEmailId}`,
      `meeting:${ACQ_11B.meetingId}`,
      `task:${ACQ_11B.closedTaskId}`,
      `decision:${ACQ_11B.decisionId}`,
    ])
      expect(state.productSourcesSeen.has(`${key}:${ACQ}`), key).toBe(true);
    for (const key of PRODUCT_SCRIPTED_SOURCE_KEYS)
      expect(state.productSourcesSeen.has(`${key}:${ACQ}`), key).toBe(false);
  });
});
