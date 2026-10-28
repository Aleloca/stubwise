import { customerStatus, type CustomerStatus } from "../../domain/releases/customerStatus";
import type { ReleaseStatusKind } from "../../domain/releases/releaseStatus";
import { supportState, waitingSince, type SupportState } from "../../domain/support/state";
import { statusOf } from "../releases/visibility";
import { visibleProjectIds, state } from "../store";
import type { ProjectRequest, RequestStatus, SupportConversation, SupportMessage } from "../types";
import { can, viewerFor, type Permission } from "../viewer";
import { notFound } from "../writer";

// Chi vede che cosa in Support (area 8a) — l'unica regola, per letture e
// scritture. Le conversazioni e la richiesta nata le vedono i membri del
// progetto (chi lo vede); la bozza di Claude e la casella della risposta
// solo chi ha `support.reply`; i widget solo chi ha `widget.manage`. Una
// conversazione di un progetto invisibile risponde come una che non esiste
// (R-G5). Lo stato della conversazione e quello per il cliente si DERIVANO
// qui, con le regole pure di `domain/support` e `domain/releases`.

export const sees = (me: string, projectId: string): boolean =>
  visibleProjectIds(me).has(projectId);

export const holds = (me: string, perm: Permission, projectId: string): boolean =>
  can(viewerFor(me), perm, projectId);

const projectCodeOf = (projectId: string): string => state.projectsById.get(projectId)!.code;

export function conversationFor(me: string, code: string): SupportConversation {
  const c = state.supportConversations.find((x) => x.code === code);
  if (!c || !sees(me, c.projectId)) throw notFound();
  return c;
}

/** L'indirizzo di una conversazione (avvisi, ⌘K, Home). */
export const supportHref = (projectId: string, code: string): string =>
  `#/p/${projectCodeOf(projectId)}/support/${code}`;

/** L'indirizzo di una richiesta nel pannello delle richieste. */
export const requestHref = (req: ProjectRequest): string =>
  `#/p/${projectCodeOf(req.projectId)}/requests?request=${req.id}`;

// --- stato per il cliente ----------------------------------------------------

/** Gli stati dei rilasci delle PR di una task (dalla cronologia delle PR). */
function releasesOfTask(taskId: string): ReleaseStatusKind[] {
  const prs = state.pullRequests.filter((p) => p.taskId === taskId && p.kind === "pr_opened");
  return state.releases
    .filter((r) => prs.some((p) => p.repo === r.pr.repo && p.number === r.pr.number))
    .map((r) => statusOf(r).kind);
}

/**
 * Lo stato della richiesta come lo vede il cliente. Una richiesta fusa
 * segue la destinazione: lì vive il desiderio.
 */
export function customerStatusOf(req: ProjectRequest | null): CustomerStatus {
  let target = req;
  const seen = new Set<string>();
  while (target?.mergedIntoId && !seen.has(target.id)) {
    seen.add(target.id);
    const into: string = target.mergedIntoId;
    target = state.requests.find((r) => r.id === into) ?? target;
  }
  const tasks = (target?.taskIds ?? []).flatMap((id) => state.tasksById.get(id) ?? []);
  return customerStatus(
    target,
    tasks,
    tasks.flatMap((t) => releasesOfTask(t.id)),
  );
}

export const requestOf = (c: SupportConversation): ProjectRequest | null =>
  (c.requestId && state.requests.find((r) => r.id === c.requestId)) || null;

// --- la conversazione vista da chi guarda ------------------------------------

export interface SupportRequestView {
  id: string;
  code: string;
  title: string;
  /** Il desiderio riscritto (la descrizione della richiesta). */
  description: string;
  status: RequestStatus;
  /** Cosa vede il cliente adesso, in parole (Ricevuta, In valutazione…). */
  customerStatus: CustomerStatus;
}

export interface SupportConversationView extends Omit<
  SupportConversation,
  "followerIds" | "claudeDraft"
> {
  projectCode: string;
  state: SupportState;
  /** Il primo messaggio del cliente rimasto senza risposta, se aspetta noi. */
  waitingSince: string | null;
  lastMessage: SupportMessage | null;
  widgetName: string | null;
  request: SupportRequestView | null;
  /** Solo con `support.reply`; per gli altri sempre `null`. */
  claudeDraft: string | null;
  following: boolean;
  /** Cosa può fare chi guarda, deciso qui (il client non lo deduce). */
  canReply: boolean;
  /**
   * La casella è chiusa anche a chi può rispondere: `triage` mentre Claude
   * fa le domande al cliente (R-K15). `null` = si risponde.
   */
  replyClosed: "triage" | null;
  /** «Apri la richiesta»: su una non conclusa, con `backlog.create`. */
  canOpenRequest: boolean;
  /**
   * «Scrivigli anche per email»: `null` se si può; altrimenti il perché.
   * Senza `support.reply` la voce non c'è (`no_permission`); durante il
   * triage nemmeno (`triage`, R-K18).
   */
  emailBlocked: "no_permission" | "triage" | "no_email" | "no_mailbox" | null;
}

function emailBlocked(me: string, c: SupportConversation): SupportConversationView["emailBlocked"] {
  if (!holds(me, "support.reply", c.projectId)) return "no_permission";
  // Durante il triage le domande al cliente le fa Claude (R-K18).
  if (supportState(c) === "triage") return "triage";
  if (!c.customer.email) return "no_email";
  if (!state.mailboxes.some((b) => b.personId === me)) return "no_mailbox";
  return null;
}

export function conversationView(me: string, c: SupportConversation): SupportConversationView {
  const reply = holds(me, "support.reply", c.projectId);
  const st = supportState(c);
  const req = requestOf(c);
  const { followerIds, claudeDraft, ...rest } = structuredClone(c);
  return {
    ...rest,
    projectCode: projectCodeOf(c.projectId),
    state: st,
    waitingSince: waitingSince(c),
    lastMessage: rest.messages.at(-1) ?? null,
    widgetName: state.supportWidgets.find((w) => w.id === c.widgetId)?.name ?? null,
    request: req
      ? {
          id: req.id,
          code: req.code,
          title: req.title,
          description: req.description,
          status: req.status,
          customerStatus: customerStatusOf(req),
        }
      : null,
    claudeDraft: reply ? claudeDraft : null,
    following: followerIds.includes(me),
    canReply: reply,
    replyClosed: st === "triage" ? "triage" : null,
    canOpenRequest: st === "not_concluded" && holds(me, "backlog.create", c.projectId),
    emailBlocked: emailBlocked(me, c),
  };
}

// --- la bozza di Claude (deterministica nel prototipo) -------------------------

const CUSTOMER_WORDS: Record<CustomerStatus, string> = {
  received: "we have received it and the team will look at it soon",
  evaluating: "the team is evaluating it",
  planned: "it is planned",
  in_progress: "the team is working on it",
  released: "it has been released",
  not_proceeding: "unfortunately we are not going ahead with it for now",
};

/**
 * Il testo della bozza di Claude: dalla conversazione e dalla richiesta,
 * senza nomi del team, stime né commenti interni (li leggerebbe il
 * cliente). Lo stesso testo riempie l'email di «Scrivigli anche per email».
 */
export function draftText(c: SupportConversation): string {
  const first = c.customer.name.split(/\s+/)[0] || c.customer.name;
  const req = requestOf(c);
  const status = req
    ? `About your request (${req.code}): ${CUSTOMER_WORDS[customerStatusOf(req)]}.`
    : "We have read your message and we are looking into it.";
  return `Hi ${first}, thanks for writing. ${status} We'll write here as soon as there is news.`;
}
