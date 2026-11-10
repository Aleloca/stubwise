import type { DecisionRequestView, TaskActivityEntryView } from "@stubwise/shared";
import type * as Fake from "../../api";
import type { ActivityEntry, DecisionRequest, StoredLinkKind } from "../../types";
import { appClient } from "./client";
import { reread } from "./tasks";

// Il dettaglio della task nella build app (integrazione area 2, fetta 1):
// attività (commenti di oggi e cambiamenti da `ticket_events`), richieste
// di decisione, collegamenti (`ticket_links`, rotte di oggi), il lavoro di
// Claude in breve e la richiesta d'origine in lettura.

/** Il ticket di ogni commento letto: le rotte dei commenti sono sotto il ticket. */
const ticketOfComment = new Map<string, string>();

/** Al cambio di sessione: i commenti letti erano della persona di prima. */
export function forgetCommentTickets(): void {
  ticketOfComment.clear();
}

/**
 * «via Claude» (chat, fetta 3): il server lo deriva a lettura; qui diventa il
 * segno del prototipo (`via: "claude"`, `claudeActionId`). Un server vecchio
 * non manda i campi: nessun segno.
 */
function viaOf(v: { viaClaude?: boolean; viaClaudeActionId?: string | null }): Pick<ActivityEntry, "via" | "claudeActionId"> {
  if (v.viaClaude !== true) return {};
  return { via: "claude", ...(v.viaClaudeActionId ? { claudeActionId: v.viaClaudeActionId } : {}) };
}

function toEntry(v: TaskActivityEntryView): ActivityEntry {
  if (v.kind === "comment") ticketOfComment.set(v.id, v.taskId);
  const { viaClaude: _v, viaClaudeActionId: _a, viaClaudeRequesterId: _r, ...rest } = v;
  void _v;
  void _a;
  void _r;
  return { ...rest, ...viaOf(v) } as ActivityEntry;
}

export const listActivity: typeof Fake.listActivity = async (taskId) =>
  (await appClient().tasks.activity(taskId)).map((v) => toEntry(v as TaskActivityEntryView));

interface ServerComment {
  id: string;
  ticketId?: string;
  authorId?: string | null;
  author?: { id: string } | null;
  body: string;
  createdAt: string;
  replyToCommentId?: string | null;
  editedAt?: string | null;
  viaClaude?: boolean;
  viaClaudeActionId?: string | null;
}

function commentEntry(taskId: string, c: ServerComment): ActivityEntry {
  ticketOfComment.set(c.id, taskId);
  return {
    id: c.id,
    taskId,
    kind: "comment",
    authorId: c.authorId ?? c.author?.id ?? null,
    at: c.createdAt,
    body: c.body,
    ...(c.replyToCommentId ? { replyToId: c.replyToCommentId } : {}),
    ...(c.editedAt ? { editedAt: c.editedAt } : {}),
    ...viaOf(c),
  };
}

export const addComment: typeof Fake.addComment = async (taskId, body, replyToId) => {
  const c = await appClient().tickets.comment(taskId, body, replyToId ? { replyToCommentId: replyToId } : {});
  return commentEntry(taskId, c as unknown as ServerComment);
};

function ticketOf(commentId: string): string {
  const ticket = ticketOfComment.get(commentId);
  if (!ticket) throw new Error("not_found");
  return ticket;
}

export const editComment: typeof Fake.editComment = async (id, body) => {
  const taskId = ticketOf(id);
  const c = await appClient().tickets.editComment(taskId, id, body);
  return commentEntry(taskId, c as unknown as ServerComment);
};

export const deleteComment: typeof Fake.deleteComment = async (id) => {
  await appClient().tickets.deleteComment(ticketOf(id), id);
};

const toDecision = (v: DecisionRequestView): DecisionRequest => ({
  id: v.id,
  taskId: v.taskId,
  ...(v.projectId ? { projectId: v.projectId } : {}),
  askedById: v.askedById,
  askedOfId: v.askedOfId,
  question: v.question,
  options: v.options,
  createdAt: v.createdAt,
  withdrawnAt: v.withdrawnAt,
  answer: v.answer,
});

export const listDecisionRequests: typeof Fake.listDecisionRequests = async (filter) =>
  (await appClient().decisions.list(filter)).map((v) => toDecision(v as DecisionRequestView));

export const askDecision: typeof Fake.askDecision = async (input) =>
  toDecision(
    (await appClient().tasks.askDecision(input.taskId, {
      askedOfId: input.askedOfId,
      question: input.question,
      options: input.options,
    })) as DecisionRequestView,
  );

export const answerDecision: typeof Fake.answerDecision = async (id, answer) =>
  toDecision((await appClient().decisions.answer(id, answer)) as DecisionRequestView);

export const withdrawDecision: typeof Fake.withdrawDecision = async (id) =>
  toDecision((await appClient().decisions.withdraw(id)) as DecisionRequestView);

// --- collegamenti (rotte di oggi) ------------------------------------------------

/** Il prototipo dice `relates`, il server `relates_to`. */
export const serverLinkKind = (kind: StoredLinkKind): string => (kind === "relates" ? "relates_to" : kind);

interface ServerLinkView {
  linkId: string;
  relation: string;
  otherTicketId: string;
}

export const addLink: typeof Fake.addLink = async (id, link) => {
  await appClient().request("POST", `/api/tickets/${encodeURIComponent(id)}/links`, {
    targetTicketId: link.taskId,
    kind: serverLinkKind(link.kind),
  });
  return reread(id);
};

/** Il collegamento si cerca nelle righe del ticket che lo tiene, e si toglie per id. */
export const removeLink: typeof Fake.removeLink = async (id, link) => {
  const rows = await appClient().request<ServerLinkView[]>(
    "GET",
    `/api/tickets/${encodeURIComponent(id)}/links`,
  );
  const row = rows.find((r) => r.relation === serverLinkKind(link.kind) && r.otherTicketId === link.taskId);
  if (row) {
    await appClient().request(
      "DELETE",
      `/api/tickets/${encodeURIComponent(id)}/links/${encodeURIComponent(row.linkId)}`,
    );
  }
  return reread(id);
};

// --- Claude e la richiesta d'origine ----------------------------------------------

/** Lo stato del lavoro di Claude, le PR e il dettaglio nel web vecchio. */
export const getTaskWorkSummary: typeof Fake.getTaskWorkSummary = async (taskId) => {
  const w = await appClient().tasks.work(taskId);
  // Un valore che questa app non conosce (lettore: `UNKNOWN`) non si mostra come uno noto.
  const known = <T extends string>(v: T | "__unknown__"): v is T => v !== "__unknown__";
  return {
    claude: known(w.claude) ? w.claude : "none",
    pullRequests: w.pullRequests.flatMap((p) => (known(p.state) ? [{ ...p, state: p.state }] : [])),
    webHref: w.webHref,
  };
};

// `getRequest` (la richiesta da cui è nata una task) sta in `requests.ts` dalla fetta 4.
