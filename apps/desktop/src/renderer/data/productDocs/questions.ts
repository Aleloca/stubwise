import { anchorIdsOf, isTextBlock } from "../../domain/productDocs/blocks";
import { visiblePeopleFor } from "../access/whoCan";
import { docsAccess } from "../docs/reads";
import { CLAUDE_ID, PEOPLE } from "../seed/people";
import { gate, nextSeq, now, state } from "../store";
import type {
  ProductAnswerChoice,
  ProductBlock,
  ProductBlockOp,
  ProductComment,
  ProductDocOrigin,
  ProductPage,
  ProductQuestion,
  ProductQuestionDecision,
  ProductQuestionView,
  ProposedAction,
  RichText,
} from "../types";
import { can, viewerFor } from "../viewer";
import { invalid, notFound, writer } from "../writer";
import { freshIds, withAnchor } from "./claude";
import { threadLink } from "./comments";
import { emitProductPage, emitProductQuestionsChanged } from "./events";
import { productDocRecipients } from "./follows";
import { productPageById } from "./reads";
import { touchedAfter } from "./revisions";
import { sourceViewOf } from "./sources";
import { editablePage, writeProductBlocksAs } from "./writes";

// Le risposte alle domande di Claude sulla doc di prodotto (11b, Task 4). La
// domanda la crea il motore (`askProductQuestion`, `claude.ts`); qui si
// legge come la vede chi guarda e si risponde. Le regole:
// - si risponde nel filo e in Home «Decidi» (maintainer, 6 nov 2026, Q1);
//   la notifica `product_doc.question` non ha bottoni;
// - rispondere chiede `docs.edit` nel progetto (`editablePage`); una domanda
//   ha UNA risposta: la seconda (un doppio clic, o un'altra persona) è
//   `already_answered` con chi ha risposto, e non scrive;
// - «Aggiorna così» scrive la frase del fatto, parola per parola, con una
//   revisione `kind: "answer"` a nome di chi risponde e SENZA `via`: nessun
//   segno di Claude (Task 3). Il suo id va in `answer.revisionId` (P19), da
//   cui la cronologia deriva `answerOf`. Se la frase è stata toccata dopo la
//   domanda (`touchedAfter`) è `changed_after`: la domanda resta aperta, e
//   «Lascia com'è» e «Apri una richiesta» restano;
// - «Lascia com'è» chiude senza revisioni;
// - «Apri una richiesta» non scrive da qui: la scheda B la costruisce
//   `productQuestionRequestDraft`, e la chiude `createRequestAs` quando la
//   richiesta nasce (`origin.product_doc` col `questionId`), nella stessa
//   scrittura;
// - la domanda si chiude rispondendo: «Resolve» e «Reopen» la rifiutano
//   (`comments.ts`);
// - Claude non scrive mai nel registro decisioni (`neverWritesDecisions.test.ts`).
//
// Import circolare con `comments.ts` (lui usa `questionViewOf`, qui si usa
// `threadLink`): innocuo finché nessuno dei due chiama l'altro al
// caricamento del modulo. Non aggiungerne.

const ANSWERS: readonly ProductAnswerChoice[] = ["apply", "keep", "request"];

const nameOf = (personId: string): string =>
  PEOPLE.find((p) => p.id === personId)?.name ?? personId;

/**
 * `already_answered` con chi ha risposto (se `me` lo vede, R-G5) e cosa,
 * come le domande di Claude sui task.
 */
const alreadyAnswered = (me: string, answer: NonNullable<ProductQuestion["answer"]>) =>
  Object.assign(new Error("already_answered"), { byId: seenBy(me)(answer.byId), option: answer.option });

/** «Update it» spento: la frase è cambiata dopo la domanda, e chi l'ha cambiata. */
const changedAfter = (byId: string | null) => Object.assign(new Error("changed_after"), { byId });

/** Chi guarda ha `docs.edit` nel progetto e ne legge i Docs. */
const canEdit = (me: string, projectId: string): boolean =>
  docsAccess(me, projectId) === "read" && can(viewerFor(me), "docs.edit", projectId);

/** Una persona come la nomina `me`: Claude sempre, le altre se le vede. */
const seenBy = (me: string) => {
  const people = visiblePeopleFor(me);
  return (id: string | null | undefined): string | null =>
    id && (id === CLAUDE_ID || people.has(id)) ? id : null;
};

/** La radice-domanda che `me` legge, con la sua pagina; altrimenti `not_found` (R-G5). */
function questionRoot(
  me: string,
  commentId: string,
): { comment: ProductComment; q: ProductQuestion; page: ProductPage } {
  const comment = state.productComments.find((c) => c.id === commentId);
  const page = comment ? productPageById(comment.pageId) : undefined;
  if (!comment?.question || comment.replyToId !== null || !page || docsAccess(me, page.projectId) !== "read")
    throw notFound();
  return { comment, q: comment.question, page };
}

/** La prima revisione che ha toccato la frase dopo la domanda (quella di «changed_after»). */
const blockerOf = (comment: ProductComment) => touchedAfter(comment.pageId, comment.anchorId, comment.seq);

/** Le risposte che hanno una strada; il consiglio per primo, se ha la sua. */
function optionsOf(q: ProductQuestion): { recommended: ProductAnswerChoice | null; options: ProductAnswerChoice[] } {
  const has = (o: ProductAnswerChoice) =>
    o === "keep" || (o === "apply" ? q.apply !== null : q.request !== null);
  const recommended = has(q.recommended) ? q.recommended : null;
  const rest = ANSWERS.filter((o) => o !== recommended && has(o));
  return { recommended, options: recommended ? [recommended, ...rest] : rest };
}

/** La frase di un'ancora (un blocco di testo o una cella) com'è adesso. */
function anchorRich(blocks: readonly ProductBlock[], anchorId: string): RichText | null {
  const block = blocks.find((b) => anchorIdsOf(b).includes(anchorId));
  if (!block) return null;
  if (block.type === "table")
    return block.rows.flatMap((r) => r.cells).find((c) => c.id === anchorId)?.content ?? null;
  return isTextBlock(block) && block.id === anchorId ? block.content : null;
}

// --- leggere -------------------------------------------------------------------

/** La domanda come la legge `me` (P18): la fonte nella sua forma, mai il riferimento grezzo. */
export function questionViewOf(me: string, comment: ProductComment, page: ProductPage): ProductQuestionView {
  const q = comment.question!;
  const seen = seenBy(me);
  const forId = seen(q.forId);
  const blocker = q.answer === null && q.apply !== null ? blockerOf(comment) : null;
  const answeredBy = q.answer ? seen(q.answer.byId) : null;
  return {
    reason: q.reason,
    forId,
    forName: forId && nameOf(forId),
    taskCode:
      q.reason === "diverges" && q.sourceRef.kind === "task"
        ? (state.tasksById.get(q.sourceRef.id)?.code ?? null)
        : null,
    source: sourceViewOf(me, q.sourceRef, page.projectId),
    applyMode: q.insert ? "insert" : "replace",
    current: q.insert ? null : structuredClone(anchorRich(page.blocks, comment.anchorId)),
    apply: structuredClone(q.apply),
    built: q.built,
    request: q.request && { ...q.request },
    ...optionsOf(q),
    canAnswer: q.answer === null && canEdit(me, page.projectId),
    applyBlocked: blocker && { byId: seen(blocker.actorId) },
    answer: q.answer && {
      byId: answeredBy,
      byName: answeredBy && nameOf(answeredBy),
      option: q.answer.option,
      revisionId: q.answer.revisionId,
      requestCode:
        q.answer.requestId === undefined
          ? null
          : (state.requests.find((r) => r.id === q.answer!.requestId)?.code ?? null),
    },
  };
}

/**
 * Le domande aperte che aspettano `me` in «Decide» (P17, P22): chi riceve la
 * domanda (`productDocRecipients`), legge la pagina e ha `docs.edit` nel
 * progetto. Chi segue senza `docs.edit` non le ha (non può rispondere).
 */
export function productQuestionDecisions(me: string): ProductQuestionDecision[] {
  const out: ProductQuestionDecision[] = [];
  for (const c of state.productComments) {
    if (!c.question || c.replyToId !== null || c.question.answer !== null || c.resolved !== null) continue;
    const page = productPageById(c.pageId);
    if (!page || !canEdit(me, page.projectId) || !productDocRecipients(page.id).includes(me)) continue;
    const view = questionViewOf(me, c, page);
    out.push({
      kind: "productQuestion",
      id: `product:${c.id}`,
      commentId: c.id,
      pageId: page.id,
      pageCode: page.code,
      pageTitle: page.title,
      projectId: page.projectId,
      at: c.createdAt,
      quote: c.quote,
      link: threadLink(page, c.id),
      reason: view.reason,
      forName: view.forName,
      taskCode: view.taskCode,
      source: view.source,
      applyMode: view.applyMode,
      apply: view.apply,
      recommended: view.recommended,
      options: view.options,
      applyBlocked: view.applyBlocked,
    });
  }
  return out;
}

// --- rispondere ----------------------------------------------------------------

/** La scrittura di «Aggiorna così»: la frase del fatto al posto di quella dell'ancora, o il blocco nuovo. */
function applyOp(page: ProductPage, comment: ProductComment, q: ProductQuestion): ProductBlockOp {
  if (q.insert) {
    const afterId = q.insert.afterId;
    if (afterId !== null && !page.blocks.some((b) => b.id === afterId)) throw invalid("anchor");
    return { op: "insert", afterId, block: freshIds(q.insert.block) };
  }
  const holder = page.blocks.find((b) => anchorIdsOf(b).includes(comment.anchorId));
  const block = holder && withAnchor(holder, comment.anchorId, () => structuredClone(q.apply!));
  if (!block) throw invalid("anchor");
  return { op: "set", block };
}

/** Chiude la domanda con la risposta (e il filo fra i risolti). */
function close(
  me: string,
  comment: ProductComment,
  answer: Omit<NonNullable<ProductQuestion["answer"]>, "byId" | "seq">,
): void {
  comment.question!.answer = { byId: me, seq: nextSeq(), ...answer };
  comment.resolved = { byId: me, at: now() };
  emitProductPage(comment.pageId, "comments");
  emitProductQuestionsChanged();
}

/**
 * «Aggiorna così» (`apply`) o «Lascia com'è» (`keep`), a nome di `me`.
 * Lancia `not_found` (domanda che non c'è o pagina che non legge),
 * `forbidden` (senza `docs.edit`), `already_answered` (con `byId` e
 * `option`), `changed_after` (con `byId`: la frase è cambiata dopo la
 * domanda) e `invalid: option` (una risposta senza strada).
 */
export function answerProductQuestionAs(
  me: string,
  commentId: string,
  option: "apply" | "keep",
): { revisionId: string | null } {
  const { comment, q, page } = questionRoot(me, commentId);
  editablePage(me, page.id);
  if (q.answer !== null) throw alreadyAnswered(me, q.answer);
  if (option === "keep") {
    close(me, comment, { option, revisionId: null });
    return { revisionId: null };
  }
  if (option !== "apply" || q.apply === null) throw invalid("option");
  const blocker = blockerOf(comment);
  if (blocker) throw changedAfter(seenBy(me)(blocker.actorId));
  const { revisionId } = writeProductBlocksAs(me, page.id, [applyOp(page, comment, q)], { kind: "answer" });
  close(me, comment, { option, revisionId });
  // La revisione di «Aggiorna così»: la Home la apre in cronologia («Apri la cronologia»).
  return { revisionId };
}

export async function answerProductQuestion(
  commentId: string,
  option: "apply" | "keep",
): Promise<{ revisionId: string | null }> {
  return answerProductQuestionAs(await writer("productDocs.answerProductQuestion"), commentId, option);
}

/**
 * Le domande di una pagina per cui `me` ha una scheda «Apri una richiesta»
 * ancora aperta nel riquadro di Claude (shape Q §3.3: «Una richiesta è in
 * preparazione…»): una proposta `open` di `me` con una `createRequest` che
 * nomina la domanda (`origin.questionId`). Confermata, la domanda si chiude
 * (`createRequestAs`); annullata, la riga sparisce. Solo le proprie schede:
 * quelle degli altri non si vedono da qui.
 */
export function productRequestsPreparingAs(me: string, pageId: string): string[] {
  const page = productPageById(pageId);
  if (!page || docsAccess(me, page.projectId) !== "read") return [];
  const asked = new Set(
    state.productComments.filter((c) => c.pageId === pageId && c.question && c.question.answer === null).map((c) => c.id),
  );
  const out = new Set<string>();
  for (const events of state.conversationEvents.values()) {
    for (const e of events) {
      if (e.type !== "proposal" || e.status !== "open" || e.requesterId !== me) continue;
      for (const a of e.actions) {
        const origin = a.fn === "createRequest" ? (a.args as { origin?: ProductDocOrigin }).origin : undefined;
        if (origin?.kind === "product_doc" && origin.questionId && asked.has(origin.questionId)) out.add(origin.questionId);
      }
    }
  }
  return [...out];
}

export async function listProductRequestsPreparing(pageId: string): Promise<string[]> {
  return productRequestsPreparingAs(await gate("productDocs.listProductRequestsPreparing"), pageId);
}

/**
 * «Apri una richiesta»: la scheda B da aprire nel riquadro di Claude, una
 * `createRequest` col titolo e la descrizione del fatto e
 * `origin.product_doc` col `questionId`. Confermata, la richiesta chiude la
 * domanda (`createRequestAs`); annullata, la domanda resta aperta. Il
 * permesso del backlog lo controlla la scheda come oggi (non qui). Lancia
 * come `answerProductQuestionAs`, e `invalid: option` se la domanda non ha
 * una richiesta da proporre.
 */
export function productQuestionRequestDraft(me: string, commentId: string): ProposedAction[] {
  const { comment, q, page } = questionRoot(me, commentId);
  editablePage(me, page.id);
  if (q.answer !== null) throw alreadyAnswered(me, q.answer);
  if (q.request === null) throw invalid("option");
  const code = state.projectsById.get(page.projectId)!.code;
  const origin: ProductDocOrigin = {
    kind: "product_doc",
    pageId: page.id,
    anchorId: comment.anchorId,
    questionId: comment.id,
  };
  return [
    {
      fn: "createRequest",
      args: {
        projectId: page.projectId,
        title: q.request.title,
        description: q.request.description,
        origin,
      },
      summary: `Open a request in ${code} · ${q.request.title}`,
      summaryText: { key: "claude.answers.request.summary", params: { code, title: q.request.title } },
    },
  ];
}

// --- la richiesta nata dalla doc (`createRequestAs`) --------------------------------

/**
 * Un'origine `product_doc` di una richiesta nuova (P20): la pagina c'è, è del
 * progetto della richiesta e `me` ne legge i Docs (altrimenti `invalid:
 * origin`, senza dire perché). Con `questionId`, la domanda è di quella
 * pagina, ha una richiesta da proporre ed è aperta, e `me` può rispondere:
 * rifiutata PRIMA che la richiesta nasca, così non ne nasce una per una
 * domanda già chiusa.
 */
export function checkProductDocOrigin(me: string, projectId: string, origin: ProductDocOrigin): void {
  const page = productPageById(origin.pageId);
  if (!page || page.projectId !== projectId || docsAccess(me, projectId) !== "read") throw invalid("origin");
  if (origin.questionId === undefined) return;
  const comment = state.productComments.find((c) => c.id === origin.questionId);
  if (!comment?.question || comment.pageId !== page.id || comment.replyToId !== null) throw invalid("origin");
  editablePage(me, page.id);
  if (comment.question.answer !== null) throw alreadyAnswered(me, comment.question.answer);
  if (comment.question.request === null) throw invalid("origin");
}

/** Chiude la domanda con «Apri una richiesta», nella scrittura della richiesta (già controllata). */
export function answerProductQuestionWithRequest(me: string, questionId: string, requestId: string): void {
  const comment = state.productComments.find((c) => c.id === questionId)!;
  close(me, comment, { option: "request", revisionId: null, requestId });
}
