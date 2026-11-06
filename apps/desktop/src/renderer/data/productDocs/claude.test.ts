import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { instance, listNotifications, productDocs, resetApi, setLatency } from "../api";
import { failedHeldStarts, heldJobs, pauseQueueAs, resumeQueueAs } from "../instance/queue";
import type { MailMessage, ProductBlock, ProductFact, ProductSourceRef, RichText } from "../model";
import { CLAUDE_ID } from "../seed/people";
import { done, ext, mail, person } from "../seed/mail/helpers";
import { setSessionPersonId } from "../session";
import { state } from "../store";
import { grantInstancePermission, revokeProjectPermission } from "../viewer";
import { applyProductSource, askProductQuestion, whenProductClaudeIdle } from "./claude";

// Il motore degli aggiornamenti (11b, Task 2): i fatti di una fonte sulle
// pagine di prodotto. Una modifica entra da sola solo se il fatto è chiaro,
// non contraddice una persona e il titolare ha `docs.edit` (`decideFact`);
// aspetta chi scrive nella sezione (`writersNear`); con il budget finito o la
// coda in pausa aspetta in `holdJob`. Le domande partono subito.
//
// Pagina: Sign-in di ACQ (seme 11a). Due sezioni: «How customers sign in»
// (signin-1, titolo; signin-2, paragrafo riscritto da Marco) e «What the
// portal stores» (signin-3, titolo; signin-4, paragrafo di Laura). La
// seguono Laura (chi l'ha creata) e Marco: sono i destinatari delle card.
// Persone: Laura (Project Lead) e Marco (Developer) con `docs.edit` in ACQ,
// Sara (Contributor) con la sola lettura; Roberta full admin.

const LAURA = "p-laura";
const MARCO = "p-marco";
const SARA = "p-sara";
const ROBERTA = "p-roberta";
const ACQ = "prj-acq";
const PAGE = "pp-acq-sign-in";
const HOW = "blk-acq-signin-2";
const STORES_HEADING = "blk-acq-signin-3";
const STORES = "blk-acq-signin-4";
const TASK_ID = "t-acq-7";

const as = (personId: string) => setSessionPersonId(personId);
const page = () => state.productPages.find((p) => p.id === PAGE)!;
const blockOf = (id: string) => page().blocks.find((b) => b.id === id);
const contentOf = (id: string): RichText | null => {
  const b = blockOf(id);
  return b && "content" in b ? b.content : null;
};
const claudeRevisions = () =>
  state.productRevisions.filter((r) => r.pageId === PAGE && r.via === "claude");
const cards = (kind: string) => state.notifications.filter((n) => n.kind === kind);
const questions = () =>
  state.productComments.filter((c) => c.pageId === PAGE && c.question !== undefined);

function email(id: string, mailbox: string[]): MailMessage {
  return mail({
    id,
    threadId: `th-${id}`,
    from: ext("Fabio Rossi", "fabio@cliente.example"),
    to: mailbox.map(person),
    subject: `Subject of ${id}`,
    at: "2026-11-04T09:30:00Z",
    text: "body",
    mailboxPersonIds: mailbox,
    classification: done([ACQ], "normal"),
  });
}

const ref = (id: string): ProductSourceRef => ({ kind: "email", id });

let n = 0;
function fact(over: Partial<ProductFact> & Pick<ProductFact, "anchorId" | "change">): ProductFact {
  return { id: `fact-${++n}`, pageId: PAGE, clarity: "clear", ...over };
}

const GOOGLE_ONLY: RichText = {
  text: "Customers sign in with Google only. There is no password.",
  marks: [{ type: "bold", start: 22, end: 33 }],
};
const STORES_TEXT: RichText = { text: "Only the name and the email address.", marks: [] };
const replace = (anchorId: string, text: RichText = GOOGLE_ONLY) =>
  fact({ anchorId, change: { kind: "replace", text } });

const NEW_BLOCK: ProductBlock = {
  id: "blk-from-the-fact",
  type: "paragraph",
  content: { text: "Apple sign-in is not offered.", marks: [] },
};

beforeEach(() => {
  resetApi();
  setLatency(0);
  state.mailMessages.push(email("mm-laura-1", [LAURA]));
});
afterEach(async () => {
  await whenProductClaudeIdle();
  resetApi();
});

describe("un fatto chiaro", () => {
  it("diventa una revisione di Claude per conto del titolare, col testo del fatto parola per parola", () => {
    const out = applyProductSource(ref("mm-laura-1"), ACQ, [replace(HOW)]);
    expect(out).toMatchObject({ held: false, questions: [], pending: [], none: 0 });
    expect(out.edits).toHaveLength(1);
    const [rev] = claudeRevisions();
    expect(rev).toMatchObject({
      id: out.edits[0],
      via: "claude",
      actorId: LAURA,
      source: { kind: "email", id: "mm-laura-1" },
      kind: "edit",
    });
    expect(rev!.groupId).toEqual(expect.any(String));
    expect(contentOf(HOW)).toEqual(GOOGLE_ONLY);
  });

  it("tre fatti della stessa fonte: UNA revisione con tre cambi e un gruppo, e UNA card", () => {
    const out = applyProductSource(ref("mm-laura-1"), ACQ, [
      replace(HOW),
      replace(STORES, STORES_TEXT),
      fact({ anchorId: STORES, change: { kind: "insert_after", block: NEW_BLOCK } }),
    ]);
    expect(out.edits).toHaveLength(1);
    const revs = claudeRevisions();
    expect(revs).toHaveLength(1);
    expect(revs[0]!.changes).toHaveLength(3);
    // L'id del blocco nuovo si dà alla scrittura, non viene dal fatto (P46).
    const after = page().blocks[page().blocks.findIndex((b) => b.id === STORES) + 1]!;
    expect(after.id).not.toBe(NEW_BLOCK.id);
    expect("content" in after && after.content.text).toBe("Apple sign-in is not offered.");

    const updated = cards("product_doc.updated");
    expect(updated).toHaveLength(1);
    expect(updated[0]).toMatchObject({
      projectId: ACQ,
      objectCode: page().code,
      productUpdate: { pageId: PAGE, revisionIds: out.edits, sources: [ref("mm-laura-1")] },
    });
    expect([...updated[0]!.recipientIds].sort()).toEqual([LAURA, MARCO]);
  });

  it("un `link_task` aggiunge solo il codice in fondo alla frase", () => {
    applyProductSource({ kind: "task", id: TASK_ID }, ACQ, [
      fact({ anchorId: STORES, change: { kind: "link_task", taskCode: "ACQ-7" } }),
    ]);
    expect(contentOf(STORES)?.text).toBe(
      "Only the name and the email address that Google gives us. ACQ-7",
    );
    expect(claudeRevisions()[0]).toMatchObject({ actorId: CLAUDE_ID, via: "claude" });
  });

  it("la stessa fonte arrivata due volte non scrive due volte (P46)", () => {
    applyProductSource(ref("mm-laura-1"), ACQ, [replace(HOW)]);
    const again = applyProductSource(ref("mm-laura-1"), ACQ, [replace(STORES, STORES_TEXT)]);
    expect(again).toEqual({ held: false, edits: [], questions: [], pending: [], none: 0 });
    expect(claudeRevisions()).toHaveLength(1);
  });
});

describe("le domande", () => {
  it("un fatto vago: nessuna revisione, un commento-domanda di Claude sull'ancora, una card", () => {
    const before = JSON.stringify(page().blocks);
    const out = applyProductSource(ref("mm-laura-1"), ACQ, [
      fact({ anchorId: STORES, clarity: "vague", change: { kind: "replace", text: STORES_TEXT } }),
    ]);
    expect(out.edits).toEqual([]);
    expect(out.questions).toHaveLength(1);
    expect(JSON.stringify(page().blocks)).toBe(before);
    expect(claudeRevisions()).toHaveLength(0);
    const [q] = questions();
    expect(q).toMatchObject({
      id: out.questions[0],
      authorId: CLAUDE_ID,
      anchorId: STORES,
      replyToId: null,
      resolved: null,
      question: {
        reason: "vague",
        sourceRef: ref("mm-laura-1"),
        apply: STORES_TEXT,
        recommended: "keep",
        answer: null,
      },
    });
    const asked = cards("product_doc.question");
    expect(asked).toHaveLength(1);
    expect(asked[0]!.productQuestion).toEqual({ pageId: PAGE, commentId: q!.id });
    expect(asked[0]!.link).toContain(`?comment=${q!.id}`);
  });

  it("il titolare senza `docs.edit`: una domanda `no_permission` che lo nomina, nessuna revisione", () => {
    state.mailMessages.push(email("mm-sara-1", [SARA]));
    const out = applyProductSource(ref("mm-sara-1"), ACQ, [replace(HOW)]);
    expect(out.edits).toEqual([]);
    expect(claudeRevisions()).toHaveLength(0);
    expect(questions()[0]!.question).toMatchObject({
      reason: "no_permission",
      forId: SARA,
      recommended: "apply",
    });
  });

  it("parte subito anche con qualcuno nella sezione", async () => {
    as(MARCO);
    await productDocs.setProductPresence(PAGE, { anchorId: HOW, offset: 0 });
    const out = applyProductSource(ref("mm-laura-1"), ACQ, [
      fact({ anchorId: HOW, clarity: "vague", change: { kind: "replace", text: GOOGLE_ONLY } }),
    ]);
    expect(out.questions).toHaveLength(1);
    expect(out.pending).toEqual([]);
  });

  it("`askProductQuestion` restituisce l'id del commento e senza ancora usa la prima della pagina", () => {
    const f = fact({ anchorId: null, clarity: "vague", change: { kind: "insert_after", block: NEW_BLOCK } });
    const id = askProductQuestion(PAGE, null, f, ref("mm-laura-1"), "vague");
    const c = state.productComments.find((x) => x.id === id)!;
    expect(c.anchorId).toBe(page().blocks[0]!.id);
    expect(c.quote).toBe("How customers sign in");
    expect(c.question?.apply).toEqual(NEW_BLOCK.type === "paragraph" ? NEW_BLOCK.content : null);
  });
});

describe("Review Focus 2: Claude aspetta chi scrive", () => {
  beforeEach(async () => {
    as(MARCO);
    await productDocs.setProductPresence(PAGE, { anchorId: HOW, offset: 0 });
  });

  it("Marco nella sezione: nessuna revisione, il fatto aspetta", () => {
    const out = applyProductSource(ref("mm-laura-1"), ACQ, [replace(HOW)]);
    expect(out.edits).toEqual([]);
    expect(out.pending).toHaveLength(1);
    expect(state.productPending).toHaveLength(1);
    expect(claudeRevisions()).toHaveLength(0);
    // Un fatto in un'altra sezione non aspetta.
    expect(applyProductSource({ kind: "task", id: TASK_ID }, ACQ, [replace(STORES, STORES_TEXT)]).edits).toHaveLength(1);
  });

  it("senza riscrittura, la revisione parte quando Marco esce, con la sua card", () => {
    applyProductSource(ref("mm-laura-1"), ACQ, [replace(HOW)]);
    productDocs.leaveProductPageAs(MARCO, PAGE);
    expect(state.productPending).toEqual([]);
    expect(claudeRevisions()).toHaveLength(1);
    expect(contentOf(HOW)).toEqual(GOOGLE_ONLY);
    expect(cards("product_doc.updated")).toHaveLength(1);
  });

  it("Marco riscrive quel blocco ed esce: il fatto diventa una domanda `contradicts_person`, il suo testo resta", () => {
    applyProductSource(ref("mm-laura-1"), ACQ, [replace(HOW)]);
    const mine: RichText = { text: "Customers sign in with Google or Apple.", marks: [] };
    const block = blockOf(HOW)!;
    productDocs.writeProductBlocksAs(MARCO, PAGE, [{ op: "set", block: { ...block, content: mine } as ProductBlock }], {
      sessionId: "s-marco",
    });
    // Ancora dentro: niente.
    expect(questions()).toHaveLength(0);
    productDocs.leaveProductPageAs(MARCO, PAGE);
    expect(state.productPending).toEqual([]);
    expect(claudeRevisions()).toHaveLength(0);
    expect(contentOf(HOW)).toEqual(mine);
    expect(questions()[0]!.question).toMatchObject({ reason: "contradicts_person", forId: MARCO });
  });
});

describe("il budget e la pausa (Review Focus 5)", () => {
  beforeEach(async () => {
    as(ROBERTA);
    await instance.simulateBudgetReached(true);
  });

  it("budget finito: nessuna scrittura, un lavoro fermo `product_doc_update` sulla pagina", () => {
    const out = applyProductSource(ref("mm-laura-1"), ACQ, [replace(HOW)]);
    expect(out).toEqual({ held: true, edits: [], questions: [], pending: [], none: 0 });
    expect(claudeRevisions()).toHaveLength(0);
    expect(questions()).toHaveLength(0);
    const held = heldJobs().filter((j) => j.kind === "product_doc_update");
    expect(held).toHaveLength(1);
    expect(held[0]).toMatchObject({
      projectId: ACQ,
      productPageId: PAGE,
      starterId: LAURA,
      taskId: null,
      conversationId: null,
      automationRunId: null,
      block: { reason: "monthly_budget" },
    });
  });

  it("tre fonti in attesa, una sparita: al rilascio due revisioni in ordine d'arrivo e UNA card con due fonti", async () => {
    state.mailMessages.push(email("mm-laura-2", [LAURA]));
    applyProductSource(ref("mm-laura-1"), ACQ, [replace(HOW)]);
    applyProductSource(ref("mm-laura-2"), ACQ, [replace(STORES, STORES_TEXT)]);
    applyProductSource({ kind: "task", id: TASK_ID }, ACQ, [
      fact({ anchorId: STORES_HEADING, change: { kind: "link_task", taskCode: "ACQ-7" } }),
    ]);
    // La seconda email sparisce prima del rilascio.
    state.mailMessages = state.mailMessages.filter((m) => m.id !== "mm-laura-2");

    await instance.simulateBudgetReached(false);
    await whenProductClaudeIdle();

    const revs = claudeRevisions();
    expect(revs.map((r) => r.source)).toEqual([ref("mm-laura-1"), { kind: "task", id: TASK_ID }]);
    expect(revs[0]!.seq).toBeLessThan(revs[1]!.seq);
    expect(contentOf(STORES)?.text).toBe("Only the name and the email address that Google gives us.");
    const updated = cards("product_doc.updated");
    expect(updated).toHaveLength(1);
    expect(updated[0]!.productUpdate).toEqual({
      pageId: PAGE,
      revisionIds: revs.map((r) => r.id),
      sources: [ref("mm-laura-1"), { kind: "task", id: TASK_ID }],
      waited: "monthly_budget",
    });
    expect(heldJobs()).toEqual([]);
    expect(failedHeldStarts()).toEqual([]);
    // Più fonti: nessun «per conto di» (le persone possono essere più d'una).
    as(LAURA);
    const card = (await listNotifications()).find((x) => x.kind === "product_doc.updated")!;
    expect(card.productCard).toMatchObject({ onBehalfOfName: null, waited: "monthly_budget", changes: 2 });
    expect(card.productCard!.sources).toHaveLength(2);
  });

  it("una persona riscrive il blocco mentre la fonte aspetta il budget: al rilascio è una domanda", async () => {
    applyProductSource(ref("mm-laura-1"), ACQ, [replace(HOW)]);
    const mine: RichText = { text: "Customers sign in with Google or Apple.", marks: [] };
    productDocs.writeProductBlocksAs(
      MARCO,
      PAGE,
      [{ op: "set", block: { ...blockOf(HOW)!, content: mine } as ProductBlock }],
      { sessionId: "s-marco" },
    );
    await instance.simulateBudgetReached(false);
    await whenProductClaudeIdle();
    expect(claudeRevisions()).toHaveLength(0);
    expect(contentOf(HOW)).toEqual(mine);
    expect(questions()[0]!.question).toMatchObject({ reason: "contradicts_person", forId: MARCO });
  });

  it("la ripresa della coda raccoglie le card per pagina allo stesso modo", async () => {
    await instance.simulateBudgetReached(false);
    expect(pauseQueueAs(ROBERTA, ACQ)).toEqual({ ok: true });
    applyProductSource(ref("mm-laura-1"), ACQ, [replace(HOW)]);
    applyProductSource({ kind: "task", id: TASK_ID }, ACQ, [replace(STORES, STORES_TEXT)]);
    expect(heldJobs()[0]!.block.reason).toBe("queue_paused");
    expect(resumeQueueAs(ROBERTA, ACQ)).toEqual({ ok: true });
    await whenProductClaudeIdle();
    const updated = cards("product_doc.updated");
    expect(updated).toHaveLength(1);
    expect(updated[0]!.productUpdate?.sources).toHaveLength(2);
    expect(updated[0]!.productUpdate?.waited).toBe("queue_paused");
  });

  it("la pagina eliminata prima del rilascio: il fatto non fa niente", async () => {
    applyProductSource(ref("mm-laura-1"), ACQ, [replace(HOW)]);
    state.productPages = state.productPages.filter((p) => p.id !== PAGE);
    await instance.simulateBudgetReached(false);
    await whenProductClaudeIdle();
    expect(claudeRevisions()).toHaveLength(0);
    expect(questions()).toHaveLength(0);
    expect([...cards("product_doc.updated"), ...cards("product_doc.question")]).toHaveLength(0);
    expect(failedHeldStarts()).toEqual([]);
  });

  it("il modulo Docs spento prima del rilascio: il fatto non fa niente", async () => {
    // Non ci prova nemmeno: nessuna scrittura rifiutata da dire in console.
    const refused = vi.spyOn(console, "error").mockImplementation(() => {});
    applyProductSource(ref("mm-laura-1"), ACQ, [replace(HOW)]);
    const project = state.projectsById.get(ACQ)!;
    project.modules = project.modules.filter((m) => m !== "docs");
    await instance.simulateBudgetReached(false);
    await whenProductClaudeIdle();
    expect(claudeRevisions()).toHaveLength(0);
    expect(cards("product_doc.updated")).toHaveLength(0);
    expect(failedHeldStarts()).toEqual([]);
    expect(questions()).toHaveLength(0);
    expect(cards("product_doc.question")).toHaveLength(0);
    expect(refused).not.toHaveBeenCalled();
    refused.mockRestore();
  });

  it("un gesto del riquadro (`manual`) non passa dalla coda (P41)", () => {
    const out = applyProductSource(ref("mm-laura-1"), ACQ, [replace(HOW)], { manual: { requesterId: LAURA } });
    expect(out.held).toBe(false);
    expect(out.edits).toHaveLength(1);
    expect(heldJobs()).toEqual([]);
  });

  it("le fonti in attesa si contano per chi legge lo spazio (P11)", async () => {
    applyProductSource(ref("mm-laura-1"), ACQ, [replace(HOW)]);
    applyProductSource({ kind: "task", id: TASK_ID }, ACQ, [replace(STORES, STORES_TEXT)]);
    as(SARA);
    expect(await productDocs.productUpdatesWaiting(ACQ)).toEqual({
      count: 2,
      block: { reason: "monthly_budget" },
    });
    // Giulia non è in ACQ: niente (R-G5).
    as("p-giulia");
    expect(await productDocs.productUpdatesWaiting(ACQ)).toBeNull();
  });

  it("lo Stato dell'istanza nomina la pagina del lavoro fermo (P9)", async () => {
    applyProductSource(ref("mm-laura-1"), ACQ, [replace(HOW)]);
    as(ROBERTA);
    const view = await instance.getInstanceStatus();
    const job = view.jobs.find((j) => j.kind === "product_doc_update");
    expect(job).toMatchObject({
      state: "waiting",
      title: "Sign-in",
      code: page().code,
      href: `#/p/ACQ/docs/product/${page().code}`,
    });
  });
});

describe("Fix round 1: lo Stato dell'istanza e R-G5", () => {
  beforeEach(async () => {
    as(ROBERTA);
    await instance.simulateBudgetReached(true);
    applyProductSource(ref("mm-laura-1"), ACQ, [replace(HOW)]);
  });
  const row = async () =>
    (await instance.getInstanceStatus()).jobs.find((j) => j.kind === "product_doc_update")!;

  it("chi vede lo Stato ma non i Docs di ACQ non legge titolo, codice né link della pagina", async () => {
    grantInstancePermission(SARA, "instance.status.view");
    revokeProjectPermission(SARA, ACQ, "docs.view" as never);
    as(SARA);
    const job = await row();
    expect(job).toMatchObject({ title: "", code: null, href: null, state: "waiting" });
    expect(JSON.stringify(job).toLowerCase()).not.toContain("sign-in");
  });

  it("con i Docs spenti nemmeno il full admin legge la pagina nella riga", async () => {
    const project = state.projectsById.get(ACQ)!;
    project.modules = project.modules.filter((m) => m !== "docs");
    as(ROBERTA);
    expect(await row()).toMatchObject({ title: "", code: null, href: null });
  });
});

describe("Fix round 1: il gesto del riquadro non scrive due volte", () => {
  const insert = () => fact({ id: "fact-insert", anchorId: STORES, change: { kind: "insert_after", block: NEW_BLOCK } });
  const copies = () =>
    page().blocks.filter((b) => "content" in b && b.content.text === "Apple sign-in is not offered.");

  it("due volte di fila: il paragrafo entra una volta sola", () => {
    const manual = { manual: { requesterId: LAURA } };
    expect(applyProductSource(ref("mm-laura-1"), ACQ, [insert()], manual).edits).toHaveLength(1);
    const again = applyProductSource(ref("mm-laura-1"), ACQ, [insert()], manual);
    expect(again.edits).toEqual([]);
    expect(again.none).toBe(1);
    expect(copies()).toHaveLength(1);
  });

  it("due volte con Marco nella sezione: una riga in attesa, un paragrafo quando esce", async () => {
    as(MARCO);
    await productDocs.setProductPresence(PAGE, { anchorId: STORES, offset: 0 });
    const manual = { manual: { requesterId: LAURA } };
    applyProductSource(ref("mm-laura-1"), ACQ, [insert()], manual);
    const again = applyProductSource(ref("mm-laura-1"), ACQ, [insert()], manual);
    expect(state.productPending).toHaveLength(1);
    expect(again.pending).toEqual([state.productPending[0]!.id]);
    productDocs.leaveProductPageAs(MARCO, PAGE);
    expect(copies()).toHaveLength(1);
    expect(claudeRevisions()).toHaveLength(1);
  });

  it("una fonte ferma per il budget e poi il gesto: al rilascio non scrive di nuovo", async () => {
    as(ROBERTA);
    await instance.simulateBudgetReached(true);
    expect(applyProductSource(ref("mm-laura-1"), ACQ, [insert()]).held).toBe(true);
    applyProductSource(ref("mm-laura-1"), ACQ, [insert()], { manual: { requesterId: LAURA } });
    await instance.simulateBudgetReached(false);
    await whenProductClaudeIdle();
    expect(copies()).toHaveLength(1);
    expect(claudeRevisions()).toHaveLength(1);
    expect(cards("product_doc.updated")).toHaveLength(1);
  });

  it("chi chiede dal riquadro non fa aspettare sé stesso; un altro nella sezione sì", async () => {
    as(LAURA);
    await productDocs.setProductPresence(PAGE, { anchorId: HOW, offset: 0 });
    const mine = applyProductSource(ref("mm-laura-1"), ACQ, [replace(HOW)], { manual: { requesterId: LAURA } });
    expect(mine.edits).toHaveLength(1);
    expect(mine.pending).toEqual([]);
    as(MARCO);
    await productDocs.setProductPresence(PAGE, { anchorId: HOW, offset: 0 });
    const theirs = applyProductSource(ref("mm-laura-1"), ACQ, [replace(HOW, STORES_TEXT)], {
      manual: { requesterId: LAURA },
    });
    expect(theirs.pending).toHaveLength(1);
    // Marco esce, Laura è ancora lì: chi ha chiesto non conta, il fatto entra.
    productDocs.leaveProductPageAs(MARCO, PAGE);
    expect(state.productPending).toEqual([]);
    expect(contentOf(HOW)).toEqual(STORES_TEXT);
  });
});

describe("Fix round 1: la domanda su un'ancora sparita", () => {
  it("una divergenza su un blocco tolto si appoggia alla prima ancora della pagina, con la sua frase", () => {
    const out = applyProductSource({ kind: "task", id: TASK_ID }, ACQ, [
      fact({ anchorId: "blk-gone-forever", change: { kind: "diverges", built: "Apple sign-in" } }),
    ]);
    const c = state.productComments.find((x) => x.id === out.questions[0])!;
    expect(c.anchorId).toBe(page().blocks[0]!.id);
    expect(c.quote).toBe("How customers sign in");
  });
});

describe("chi riceve le card", () => {
  it("nessuna card per chi non vede più la pagina; Claude non è mai destinatario", () => {
    revokeProjectPermission(MARCO, ACQ, "docs.view" as never);
    state.productFollows.push({ pageId: PAGE, personId: CLAUDE_ID, since: "2026-11-01T00:00:00Z" });
    applyProductSource(ref("mm-laura-1"), ACQ, [replace(HOW)]);
    applyProductSource({ kind: "task", id: TASK_ID }, ACQ, [
      fact({ anchorId: STORES, clarity: "vague", change: { kind: "replace", text: STORES_TEXT } }),
    ]);
    for (const n of [...cards("product_doc.updated"), ...cards("product_doc.question")]) {
      expect(n.recipientIds).toEqual([LAURA]);
    }
  });
});

describe("le card a lettura (P12)", () => {
  it("Laura legge la sua email; Marco, che non l'ha ricevuta, «da un'email di Laura Costa» senza link", async () => {
    applyProductSource(ref("mm-laura-1"), ACQ, [replace(HOW), replace(STORES, STORES_TEXT)]);
    as(LAURA);
    const laura = (await listNotifications()).find((x) => x.kind === "product_doc.updated")!;
    expect(laura).toMatchObject({ objectCode: page().code, productPageTitle: "Sign-in" });
    expect(laura.productUpdate).toBeUndefined();
    expect(laura.productCard).toMatchObject({ changes: 2, onBehalfOfName: "Laura Costa", waited: null });
    expect(laura.productCard!.sources[0]!.link).toBe("#/mail/th-mm-laura-1");

    as(MARCO);
    const marco = (await listNotifications()).find((x) => x.kind === "product_doc.updated")!;
    expect(marco.productCard!.sources[0]).toMatchObject({ link: null, ownerId: LAURA });
    expect(JSON.stringify(marco).toLowerCase()).not.toContain("subject of mm-laura-1");
  });

  it("chi non legge più la pagina: `objectGone`, niente codice, titolo, fonte né link", async () => {
    applyProductSource(ref("mm-laura-1"), ACQ, [replace(HOW)]);
    revokeProjectPermission(MARCO, ACQ, "docs.view" as never);
    as(MARCO);
    const card = (await listNotifications()).find((x) => x.kind === "product_doc.updated")!;
    expect(card).toMatchObject({ objectGone: true, objectCode: "", link: "" });
    expect(card.productCard).toBeUndefined();
    expect(card.productPageTitle).toBeUndefined();
  });

  it("una card senza `productUpdate` non lancia: si legge come `objectGone`", async () => {
    state.notifications.push({
      id: "n-old",
      kind: "product_doc.updated",
      projectId: ACQ,
      objectCode: "ACQ-D5",
      departmentId: null,
      recipientIds: [LAURA],
      title: "",
      body: "",
      createdAt: "2026-11-05T10:00:00Z",
      read: false,
      archived: false,
      snoozedUntil: null,
      link: "#/p/ACQ/docs/product/ACQ-D5",
    });
    as(LAURA);
    const card = (await listNotifications()).find((x) => x.id === "n-old")!;
    expect(card).toMatchObject({ objectGone: true, objectCode: "", link: "" });
  });

  it("la card della domanda: la ragione, la persona nominata e la fonte vista da chi riceve", async () => {
    state.mailMessages.push(email("mm-sara-1", [SARA]));
    applyProductSource(ref("mm-sara-1"), ACQ, [replace(HOW)]);
    as(LAURA);
    const card = (await listNotifications()).find((x) => x.kind === "product_doc.question")!;
    expect(card.productQuestion).toBeUndefined();
    expect(card.productCard).toMatchObject({
      changes: 0,
      question: { reason: "no_permission", forName: "Sara Montanari", answer: null, answeredByName: null },
    });
    expect(card.productCard!.sources[0]!.link).toBeNull();
  });
});
