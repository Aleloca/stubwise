import { ApiError } from "@stubwise/api-client";
import type { ProductQuestionView as SharedQuestionView, Reader } from "@stubwise/shared";
import type * as Fake from "../../api";
import i18n from "../../../i18n";
import type {
  ProductMarkView,
  ProductQuestionDecision,
  ProductQuestionView,
  ProductSourceView,
  ProductUndoView,
  RichText,
} from "../../types";
import { appClient } from "./client";
import { threadKey } from "./mailKeys";

// Claude sulla doc di prodotto nella build app (area 11, F5; R11-5), sulle
// forme di 72 in shared (Task 4, aededb033) e l'api-client `productDocs`:
// - la fonte vista arriva A PEZZI (`ProductSourceView` del server: tipo, se
//   chi guarda la apre, titolo, codice, titolare, data). La frase la compone
//   il renderer con le stesse chiavi del prototipo: chi non apre un'email o
//   una riunione di un altro (un admin compreso) legge solo «da un'email di
//   <titolare> · <data>», mai l'oggetto né l'id (N-2 = a);
// - i segni aperti di una pagina, «Looks good» e «Undo» per id del segno
//   (il prototipo li chiama con pagina e ancora: l'id viene dall'ultima
//   lettura dei segni), «Undo all» per revisione;
// - la risposta alle domande, con gli errori del prototipo
//   (`already_answered` con chi e cosa, `changed_after` con chi).
// Dietro `product-docs`, spento.

/** La fonte come la manda il server (72, Task 4). */
export interface ServerSourceView {
  /** Un tipo che il renderer non conosce (enum aperto) si legge come la prima versione. */
  kind: "email" | "meeting" | "decision" | "task" | "release" | "first_version" | (string & {});
  canOpen: boolean;
  id: string | null;
  title: string | null;
  code: string | null;
  ownerId: string | null;
  ownerName: string | null;
  at: string | null;
  gone: boolean;
  /** La conversazione della Posta di un'email (o della riunione) che chi guarda apre. */
  thread?: { threadId: string; accountId: string } | null;
}

const someone = () => i18n.t("productDocs.history.someone");

/** La fonte vista, con la frase composta qui (le chiavi del prototipo, `data/productDocs/sources.ts`). */
export function sourceViewFrom(s: ServerSourceView): ProductSourceView {
  const KINDS = ["email", "meeting", "decision", "task", "release", "first_version"] as const;
  const kind = (KINDS as readonly string[]).includes(s.kind)
    ? (s.kind as (typeof KINDS)[number])
    : ("first_version" as const);
  const base = {
    kind: kind as ProductSourceView["kind"],
    code: s.code,
    ownerId: s.ownerId,
    at: s.at,
  };
  if (s.gone)
    return {
      ...base,
      label: { key: "productDocs.source.gone" },
      code: null,
      link: null,
      ownerId: null,
      at: null,
      gone: true,
    };
  const link =
    s.canOpen && s.thread ? `#/mail/${threadKey(s.thread.accountId, s.thread.threadId)}` : null;
  const of = (key: string) => ({
    key,
    params: { owner: s.ownerName ?? someone(), date: s.at ? Date.parse(s.at) : 0 },
  });
  const label = (() => {
    switch (s.kind) {
      case "email":
        return s.canOpen && s.title !== null
          ? { key: "productDocs.source.email", params: { subject: s.title } }
          : of("productDocs.source.emailOf");
      case "meeting":
        return s.canOpen && s.title !== null
          ? { key: "productDocs.source.meeting", params: { title: s.title } }
          : of("productDocs.source.meetingOf");
      case "decision":
        return s.title !== null
          ? { key: "productDocs.source.decision", params: { title: s.title } }
          : { key: "productDocs.source.decisionHidden" };
      case "task":
        return s.title !== null
          ? { key: "productDocs.source.task", params: { title: s.title } }
          : { key: "productDocs.source.taskHidden" };
      case "release":
        return s.title !== null
          ? { key: "productDocs.source.release", params: { title: s.title } }
          : { key: "productDocs.source.releaseHidden" };
      default:
        return { key: "productDocs.source.firstVersion" };
    }
  })();
  return { ...base, label, link, gone: false } as ProductSourceView;
}

/** L'id del segno di ogni ancora, per pagina e per revisione, dall'ultima lettura dei segni. */
const markIds = new Map<string, string>();
const markKey = (scope: string, anchorId: string) => `${scope}|${anchorId}`;

/** Solo nei test, e al cambio di persona. */
export function forgetProductClaude(): void {
  markIds.clear();
}

const UNDO_REASONS = ["changed_after", "no_permission", "already_undone"] as const;

/** «Undo» del server (UN oggetto: `enabled`, e il perché quando è spento) nella forma del prototipo. */
export function undoViewFrom(u: {
  enabled: boolean;
  reason: string | null;
  byId: string | null;
}): ProductUndoView {
  if (u.enabled) return { enabled: true };
  const reason = (UNDO_REASONS as readonly string[]).includes(u.reason ?? "")
    ? (u.reason as (typeof UNDO_REASONS)[number])
    : // Un motivo che il renderer non conosce spegne «Undo» come un cambio dopo.
      "changed_after";
  return { enabled: false, reason, byId: u.byId };
}

/** Gli errori di Claude sulla doc nelle parole del prototipo (con chi, quando il server lo dice). */
function mapClaudeError(error: unknown): never {
  if (error instanceof ApiError) {
    const d = (error.details ?? {}) as { byId?: unknown; option?: unknown };
    const byId = typeof d.byId === "string" ? d.byId : null;
    if (error.status === 409 && error.code === "already_answered")
      throw Object.assign(new Error("already_answered"), {
        byId,
        ...(typeof d.option === "string" ? { option: d.option } : {}),
      });
    if (error.status === 409 && error.code === "changed_after")
      throw Object.assign(new Error("changed_after"), { byId });
    if (error.status === 409 && error.code === "already_undone") throw new Error("already_undone");
    if (error.status === 409 && error.code === "section_busy") throw new Error("section_busy");
    if (error.status === 403) throw new Error("forbidden");
    if (error.status === 404) throw new Error("not_found");
    if (error.status === 422 || error.status === 400)
      throw new Error(`invalid: ${error.code ?? "input"}`);
  }
  throw error;
}

/** Le domande aperte di chi guarda (72, 4b); un server senza la rotta (404): nessuna. */
async function openQuestions() {
  try {
    return await appClient().productDocs.openQuestions();
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return [];
    return mapClaudeError(error);
  }
}

/**
 * Le domande di Claude sulla doc per «Decide» della Home (11b, P17): una voce
 * per domanda aperta a cui chi guarda può rispondere, `product:<commento>`,
 * col filo da aprire e la fonte vista. Le aggiunge `listClaudeDecisions` con
 * `product-docs` acceso.
 */
export async function productQuestionDecisions(): Promise<ProductQuestionDecision[]> {
  return (await openQuestions()).map((q): ProductQuestionDecision => {
    const view = questionViewFrom(q.question);
    return {
      kind: "productQuestion",
      id: `product:${q.commentId}`,
      commentId: q.commentId,
      pageId: q.pageId,
      pageCode: q.pageCode,
      pageTitle: q.pageTitle,
      projectId: q.projectId,
      projectCode: q.projectCode,
      at: q.createdAt,
      quote: q.question.current?.text ?? "",
      link: `#/p/${q.projectCode}/docs/product/${q.pageCode}?comment=${q.commentId}`,
      reason: view.reason,
      forName: view.forName,
      taskCode: view.taskCode,
      source: view.source,
      applyMode: view.applyMode,
      apply: view.apply,
      recommended: view.recommended,
      options: view.options,
      applyBlocked: view.applyBlocked,
    };
  });
}

const ANSWERS = ["apply", "keep", "request"] as const;
const isAnswer = (x: string): x is (typeof ANSWERS)[number] =>
  (ANSWERS as readonly string[]).includes(x);

/** Il testo di una domanda del server (`RichTextView`) nella forma del prototipo. */
const richOf = (r: { text: string; marks: readonly unknown[] } | null): RichText | null =>
  r ? ({ text: r.text, marks: [...r.marks] } as RichText) : null;

/** La domanda di Claude del server nella forma del prototipo (enum aperti: un valore ignoto si scarta). */
export function questionViewFrom(q: Reader<SharedQuestionView>): ProductQuestionView {
  return {
    reason: q.reason as ProductQuestionView["reason"],
    forId: q.forId,
    forName: q.forName,
    taskCode: q.taskCode,
    source: sourceViewFrom(q.source as ServerSourceView),
    applyMode: q.applyMode === "insert" ? "insert" : "replace",
    current: richOf(q.current),
    apply: richOf(q.apply),
    built: q.built,
    request: q.request,
    // «Open a request» c'è: la scheda B sta nel filo (decisione del maintainer).
    recommended: q.recommended !== null && isAnswer(q.recommended) ? q.recommended : null,
    options: q.options.filter(isAnswer),
    canAnswer: q.canAnswer,
    applyBlocked: q.applyBlocked ? { byId: q.applyBlocked.byId } : null,
    answer:
      q.answer && isAnswer(q.answer.option)
        ? {
            byId: q.answer.byId,
            byName: q.answer.byName,
            option: q.answer.option,
            revisionId: q.answer.revisionId,
            requestCode: q.answer.requestCode,
          }
        : null,
  };
}

type ProductDocs = typeof Fake.productDocs;

export const liveProductClaude: Partial<ProductDocs> = {
  async listProductMarks(pageId) {
    let rows: Awaited<ReturnType<ReturnType<typeof appClient>["productDocs"]["marks"]>>;
    try {
      rows = await appClient().productDocs.marks(pageId);
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) return [];
      return mapClaudeError(error);
    }
    return rows.map((m): ProductMarkView => {
      markIds.set(markKey(pageId, m.anchorId), m.id);
      markIds.set(markKey(m.revisionId, m.anchorId), m.id);
      return {
        anchorId: m.anchorId,
        blockId: m.blockId,
        ...(m.cell ? { cell: m.cell } : {}),
        revisionId: m.revisionId,
        groupId: m.revisionId,
        actorId: m.actorId ?? "",
        onBehalfOfId: m.onBehalfOfId,
        at: m.at,
        groupAnchors: m.groupAnchors,
        source: sourceViewFrom(m.source as ServerSourceView),
        canAccept: m.canAccept,
        undo: undoViewFrom(m.undo),
      };
    });
  },

  async acceptProductMark(pageId, anchorId) {
    const id = markIds.get(markKey(pageId, anchorId));
    if (!id) throw new Error("not_found");
    try {
      await appClient().productDocs.acceptMark(id);
    } catch (error) {
      mapClaudeError(error);
    }
  },

  async undoProductChange(revisionId, anchorId) {
    const id = anchorId === undefined ? null : (markIds.get(markKey(revisionId, anchorId)) ?? null);
    if (anchorId !== undefined && !id) throw new Error("not_found");
    try {
      // «Undo all» è tutto o niente: un'ancora toccata dopo dà `changed_after` e niente cambia.
      const out = id
        ? await appClient().productDocs.undoMark(id)
        : await appClient().productDocs.undoRevision(revisionId);
      return { revisionId: out.revisionId ?? revisionId };
    } catch (error) {
      return mapClaudeError(error);
    }
  },

  // La riga «riprende quando…» dello spazio: quanti lavori della doc aspettano
  // nel progetto e il motivo più grave (`claudeHeld` di 72; sulla pagina vale
  // sempre null). Le quattro frasi le ha decise il maintainer.
  async productUpdatesWaiting(projectId) {
    try {
      const held = (await appClient().productDocs.space(projectId)).claudeHeld;
      if (!held || held.count === 0) return null;
      const reasons = ["budget", "paused", "limit", "section_busy"] as const;
      const reason = (reasons as readonly string[]).includes(held.reason)
        ? (held.reason as (typeof reasons)[number])
        : "budget";
      return { count: held.count, reason };
    } catch (error) {
      if (error instanceof ApiError && (error.status === 404 || error.status === 403)) return null;
      throw error;
    }
  },

  async answerProductQuestion(commentId, option) {
    try {
      // «Update it» scrive una revisione `edit` di chi risponde (niente segno di Claude).
      const out = await appClient().productDocs.answerQuestion(commentId, option);
      return { revisionId: out.revisionId };
    } catch (error) {
      return mapClaudeError(error);
    }
  },

  // Nella build app non c'è un evento delle domande: si rileggono con le
  // scritture che le toccano (le risposte invalidano «Decide» e i fili) e con
  // lo stream della pagina. L'iscrizione c'è, e non chiama niente.
  onProductQuestionsChanged() {
    return () => undefined;
  },

  // Il riquadro di uno spazio: le domande aperte del progetto a cui chi guarda
  // può rispondere (`docs.edit`), con la frase citata.
  async listOpenProductQuestions(projectId) {
    const items = (await openQuestions()).filter((q) => q.projectId === projectId);
    return {
      count: items.length,
      items: items.map((q) => ({
        commentId: q.commentId,
        pageId: q.pageId,
        pageCode: q.pageCode,
        pageTitle: q.pageTitle,
        quote: q.question.current?.text ?? "",
      })),
    };
  },
};
