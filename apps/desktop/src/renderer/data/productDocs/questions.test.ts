import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRequestAs } from "../api-mutations";
import { listClaudeDecisions, listNotifications, productDocs, resetApi, setLatency } from "../api";
import { executeGroup } from "../claude/actions";
import { classOfGroup } from "../claude/classes";
import type { MailMessage, ProductFact, ProductSourceRef, RichText } from "../model";
import { done, ext, mail, person } from "../seed/mail/helpers";
import { setSessionPersonId } from "../session";
import { state } from "../store";
import type { ClaudeDecision } from "../types";
import { revokeProjectPermission } from "../viewer";
import { askProductQuestion, whenProductClaudeIdle } from "./claude";
import { listProductMarksAs } from "./marks";
import { answerProductQuestionAs, productQuestionRequestDraft } from "./questions";
import { writeProductBlocksAs } from "./writes";

// Le domande di Claude sulla doc di prodotto (11b, Task 4): un commento di
// Claude con le risposte già scritte. Si risponde nel filo o in Home
// «Decidi» («Aggiorna così», «Lascia com'è», «Apri una richiesta»); una
// domanda ha una sola risposta.
//
// Pagina: Sign-in di ACQ (seme 11a), seguita da Laura e Marco. Laura (Project
// Lead) e Marco (Developer) hanno `docs.edit` in ACQ; Sara (Contributor)
// legge soltanto. L'email della fonte è nella casella di Laura: Sara non la
// vede.

const LAURA = "p-laura";
const MARCO = "p-marco";
const SARA = "p-sara";
const ACQ = "prj-acq";
const PAGE = "pp-acq-sign-in";
const HOW = "blk-acq-signin-2";
const STORES = "blk-acq-signin-4";
const SUBJECT = "Sign-in for the portal: confirmed";

const as = (personId: string) => setSessionPersonId(personId);
const page = () => state.productPages.find((p) => p.id === PAGE)!;
const contentOf = (id: string): RichText | null => {
  const b = page().blocks.find((x) => x.id === id);
  return b && "content" in b ? b.content : null;
};
const revisions = () => state.productRevisions.filter((r) => r.pageId === PAGE);
const comment = (id: string) => state.productComments.find((c) => c.id === id)!;

function email(id: string, mailbox: string[]): MailMessage {
  return mail({
    id,
    threadId: `th-${id}`,
    from: ext("Fabio Rossi", "fabio@cliente.example"),
    to: mailbox.map(person),
    subject: SUBJECT,
    at: "2026-11-04T09:30:00Z",
    text: "body",
    mailboxPersonIds: mailbox,
    classification: done([ACQ], "normal"),
  });
}

const REF: ProductSourceRef = { kind: "email", id: "mm-laura-q" };
const APPLE: RichText = { text: "Apple sign-in may come later.", marks: [] };
const REQUEST = { title: "Offer Apple sign-in", description: "Customers asked for Apple sign-in." };

function vague(over: Partial<ProductFact> = {}): ProductFact {
  return {
    id: "fact-apple",
    pageId: PAGE,
    anchorId: HOW,
    change: { kind: "replace", text: APPLE },
    clarity: "vague",
    options: { request: REQUEST },
    recommended: "apply",
    ...over,
  };
}

const ask = (fact: ProductFact = vague()) => askProductQuestion(PAGE, fact.anchorId, fact, REF, "vague");

const productDecisions = async (): Promise<Extract<ClaudeDecision, { kind: "productQuestion" }>[]> =>
  (await listClaudeDecisions()).filter(
    (d): d is Extract<ClaudeDecision, { kind: "productQuestion" }> => d.kind === "productQuestion",
  );

async function thread(commentId: string) {
  const { open, resolved } = await productDocs.listProductComments(PAGE);
  return [...open, ...resolved].find((t) => t.root.id === commentId)!;
}

beforeEach(() => {
  resetApi();
  setLatency(0);
  state.mailMessages.push(email("mm-laura-q", [LAURA]));
});
afterEach(async () => {
  await whenProductClaudeIdle();
  resetApi();
});

describe("la domanda come la legge il filo", () => {
  it("ha la vista del lettore: consiglio, risposte, fonte e chi può rispondere, senza la fonte grezza", async () => {
    const id = ask();
    as(LAURA);
    const t = await thread(id);
    expect(t.root.question).toMatchObject({
      reason: "vague",
      apply: APPLE,
      current: contentOf(HOW),
      request: REQUEST,
      recommended: "apply",
      options: ["apply", "keep", "request"],
      canAnswer: true,
      applyBlocked: null,
      answer: null,
      source: { kind: "email", link: "#/mail/th-mm-laura-q" },
    });
    expect(t.root.question).not.toHaveProperty("sourceRef");
  });

  it("per Sara, che non ha ricevuto l'email: nessun oggetto né riferimento grezzo, e nessuna risposta", async () => {
    const id = ask();
    as(SARA);
    const t = await thread(id);
    expect(t.root.question).toMatchObject({ canAnswer: false, source: { link: null } });
    const json = JSON.stringify(t).toLowerCase();
    expect(json).not.toContain(SUBJECT.toLowerCase());
    expect(json).not.toContain("mm-laura-q");
  });

  it("il consiglio va per primo; un consiglio senza la sua strada non si dà", async () => {
    const first = ask(vague({ recommended: "keep" }));
    const noApply = askProductQuestion(
      PAGE,
      STORES,
      vague({ id: "fact-x", anchorId: STORES, change: { kind: "diverges", built: "x" }, options: {}, recommended: "apply" }),
      REF,
      "vague",
    );
    as(LAURA);
    expect((await thread(first)).root.question).toMatchObject({
      recommended: "keep",
      options: ["keep", "apply", "request"],
    });
    expect((await thread(noApply)).root.question).toMatchObject({ recommended: null, options: ["keep"] });
  });

  it("«Risolto» e «Riapri» non valgono per una domanda: si chiude rispondendo", async () => {
    const id = ask();
    as(LAURA);
    await expect(productDocs.resolveProductComment(id)).rejects.toThrow("invalid: question");
    expect(comment(id).resolved).toBeNull();
    answerProductQuestionAs(LAURA, id, "keep");
    await expect(productDocs.reopenProductComment(id)).rejects.toThrow("invalid: question");
    expect(comment(id).resolved).not.toBeNull();
  });
});

describe("«Aggiorna così»", () => {
  it("scrive una revisione `answer` di chi risponde, senza `via` né segno; il filo è risolto e la domanda esce da «Decidi»", async () => {
    const id = ask();
    as(LAURA);
    expect((await productDecisions()).map((d) => d.commentId)).toEqual([id]);
    const before = revisions().length;

    answerProductQuestionAs(LAURA, id, "apply");

    expect(revisions()).toHaveLength(before + 1);
    const rev = revisions().at(-1)!;
    expect(rev).toMatchObject({ kind: "answer", actorId: LAURA });
    expect(rev.via).toBeUndefined();
    expect(rev.source).toBeUndefined();
    expect(contentOf(HOW)).toEqual(APPLE);
    expect(listProductMarksAs(LAURA, PAGE)).toEqual([]);
    expect(comment(id).question!.answer).toMatchObject({ byId: LAURA, option: "apply", revisionId: rev.id });
    expect(comment(id).resolved).toMatchObject({ byId: LAURA });

    const { open, resolved } = await productDocs.listProductComments(PAGE);
    expect(open.map((t) => t.root.id)).not.toContain(id);
    expect(resolved.find((t) => t.root.id === id)!.root.question).toMatchObject({
      canAnswer: false,
      answer: { byId: LAURA, byName: "Laura Costa", option: "apply", revisionId: rev.id },
    });
    expect(await productDecisions()).toEqual([]);
    const history = await productDocs.listProductRevisions(PAGE);
    expect(history.find((r) => r.id === rev.id)!.answerOf).toBe(id);
  });

  it("un secondo clic, o Marco dopo Laura: `already_answered` con chi ha risposto, e nessuna seconda revisione", () => {
    const id = ask();
    answerProductQuestionAs(LAURA, id, "apply");
    const after = revisions().length;
    expect(() => answerProductQuestionAs(LAURA, id, "apply")).toThrow("already_answered");
    let error: unknown;
    try {
      answerProductQuestionAs(MARCO, id, "keep");
    } catch (e) {
      error = e;
    }
    expect(error).toMatchObject({ message: "already_answered", byId: LAURA, option: "apply" });
    expect(revisions()).toHaveLength(after);
    expect(comment(id).question!.answer).toMatchObject({ byId: LAURA, option: "apply" });
  });

  it("la frase toccata dopo la domanda: `changed_after` con chi l'ha toccata; la domanda resta aperta e «Lascia com'è» resta possibile", async () => {
    const id = ask();
    const current = page().blocks.find((b) => b.id === HOW)!;
    writeProductBlocksAs(MARCO, PAGE, [
      { op: "set", block: { ...current, content: { text: "Marco's sentence.", marks: [] } } as typeof current },
    ], {});
    const before = revisions().length;

    let error: unknown;
    try {
      answerProductQuestionAs(LAURA, id, "apply");
    } catch (e) {
      error = e;
    }
    expect(error).toMatchObject({ message: "changed_after", byId: MARCO });
    expect(revisions()).toHaveLength(before);
    expect(comment(id).question!.answer).toBeNull();
    expect(contentOf(HOW)!.text).toBe("Marco's sentence.");

    as(LAURA);
    expect((await thread(id)).root.question).toMatchObject({
      canAnswer: true,
      applyBlocked: { byId: MARCO },
      recommended: "apply",
    });
    expect((await productDecisions())[0]).toMatchObject({ commentId: id, applyBlocked: { byId: MARCO } });

    answerProductQuestionAs(LAURA, id, "keep");
    expect(comment(id).question!.answer).toMatchObject({ option: "keep" });
  });

  it("su un fatto `insert_after`: inserisce il blocco del fatto dopo l'ancora, con un id nuovo", () => {
    const block = { id: "blk-of-the-fact", type: "paragraph" as const, content: APPLE };
    const id = ask(vague({ change: { kind: "insert_after", block }, options: {} }));
    answerProductQuestionAs(LAURA, id, "apply");
    const at = page().blocks.findIndex((b) => b.id === HOW);
    const next = page().blocks[at + 1]!;
    expect(next.id).not.toBe(block.id);
    expect("content" in next && next.content).toEqual(APPLE);
    expect(contentOf(HOW)!.text).not.toBe(APPLE.text);
  });
});

describe("«Lascia com'è»", () => {
  it("chiude la domanda senza revisioni", async () => {
    const id = ask();
    const before = revisions().length;
    answerProductQuestionAs(LAURA, id, "keep");
    expect(revisions()).toHaveLength(before);
    expect(comment(id).question!.answer).toMatchObject({ byId: LAURA, option: "keep", revisionId: null });
    expect(comment(id).resolved).not.toBeNull();
    as(LAURA);
    expect(await productDecisions()).toEqual([]);
  });
});

describe("«Apri una richiesta»", () => {
  it("la bozza è una `createRequest` con `origin.product_doc` e il `questionId`; confermata crea la richiesta e chiude la domanda", async () => {
    const id = ask();
    const draft = productQuestionRequestDraft(LAURA, id);
    expect(draft).toHaveLength(1);
    expect(draft[0]).toMatchObject({
      fn: "createRequest",
      args: {
        projectId: ACQ,
        title: REQUEST.title,
        description: REQUEST.description,
        origin: { kind: "product_doc", pageId: PAGE, anchorId: HOW, questionId: id },
      },
    });
    // Annullata (mai confermata): la domanda resta aperta.
    expect(comment(id).question!.answer).toBeNull();

    const request = createRequestAs(LAURA, draft[0]!.args as never);
    expect(request.origin).toEqual({ kind: "product_doc", pageId: PAGE, anchorId: HOW, questionId: id });
    expect(request.requesterIds).toEqual([LAURA]);
    expect(comment(id).question!.answer).toMatchObject({
      byId: LAURA,
      option: "request",
      revisionId: null,
      requestId: request.id,
    });
    as(LAURA);
    expect((await thread(id)).root.question!.answer).toMatchObject({ option: "request", requestCode: request.code });
    expect(await productDecisions()).toEqual([]);
    // Una seconda conferma non apre una seconda richiesta.
    const count = state.requests.length;
    expect(() => createRequestAs(LAURA, draft[0]!.args as never)).toThrow("already_answered");
    expect(state.requests).toHaveLength(count);
  });

  it("senza il permesso del backlog la scheda è B e si ferma col blocco di oggi; la domanda resta aperta", () => {
    const id = ask();
    revokeProjectPermission(LAURA, ACQ, "backlog.create" as never);
    const draft = productQuestionRequestDraft(LAURA, id);
    expect(classOfGroup(LAURA, draft).cls).toBe("B");
    const count = state.requests.length;
    expect(executeGroup(LAURA, "conv-x", draft, "B")).toMatchObject({ ok: false, code: "forbidden" });
    expect(state.requests).toHaveLength(count);
    expect(comment(id).question!.answer).toBeNull();
  });

  it("un'origine della doc di un altro progetto è rifiutata", () => {
    const id = ask();
    const draft = productQuestionRequestDraft(LAURA, id);
    const args = { ...(draft[0]!.args as object), projectId: "prj-aud" };
    expect(() => createRequestAs("p-roberta", args as never)).toThrow("invalid: origin");
    expect(comment(id).question!.answer).toBeNull();
  });
});

describe("chi non può rispondere", () => {
  it("Sara senza `docs.edit`: `forbidden`, e in «Decidi» non c'è anche se segue la pagina", async () => {
    const id = ask();
    state.productFollows.push({ pageId: PAGE, personId: SARA, since: "2026-11-04T10:00:00Z" });
    expect(() => answerProductQuestionAs(SARA, id, "keep")).toThrow("forbidden");
    expect(() => productQuestionRequestDraft(SARA, id)).toThrow("forbidden");
    expect(comment(id).question!.answer).toBeNull();
    as(SARA);
    expect(await productDecisions()).toEqual([]);
  });

  it("chi ha `docs.edit` ma non la riceve (Roberta non segue la pagina) non la ha in «Decidi»", async () => {
    ask();
    as("p-roberta");
    expect(await productDecisions()).toEqual([]);
    as(LAURA);
    expect(await productDecisions()).toHaveLength(1);
  });

  it("una domanda la cui pagina non si vede più non è in «Decidi» né in inbox", async () => {
    const id = ask();
    as(MARCO);
    expect(await productDecisions()).toHaveLength(1);
    revokeProjectPermission(MARCO, ACQ, "docs.view" as never);
    expect(await productDecisions()).toEqual([]);
    const card = (await listNotifications()).find(
      (n) => n.kind === "product_doc.question" && n.recipientIds.includes(MARCO),
    )!;
    expect(card.objectGone).toBe(true);
    expect(() => answerProductQuestionAs(MARCO, id, "keep")).toThrow();
  });
});

describe("la voce di «Decidi»", () => {
  it("porta pagina, frase, fonte vista da chi guarda, frase proposta, consiglio e risposte", async () => {
    const id = ask();
    as(LAURA);
    const [d] = await productDecisions();
    expect(d).toMatchObject({
      kind: "productQuestion",
      id: `product:${id}`,
      commentId: id,
      pageId: PAGE,
      pageCode: page().code,
      pageTitle: page().title,
      projectId: ACQ,
      quote: comment(id).quote,
      reason: "vague",
      apply: APPLE,
      recommended: "apply",
      options: ["apply", "keep", "request"],
      source: { kind: "email" },
      link: expect.stringContaining(`?comment=${id}`),
    });
  });
});
