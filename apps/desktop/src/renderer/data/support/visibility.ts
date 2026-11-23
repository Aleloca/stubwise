import { customerStatus, type CustomerStatus } from "../../domain/releases/customerStatus";
import { personMasker } from "../access/hidden";
import type { ReleaseStatusKind } from "../../domain/releases/releaseStatus";
import { supportState, type SupportState } from "../../domain/support/state";
import { publishAlert } from "../alerts/publish";
import { statusOf } from "../releases/visibility";
import { holds, sees } from "../access";
import { state } from "../store";
import type { ProjectRequest, RequestStatus, SupportConversation, SupportMessage } from "../types";
import { notFound } from "../writer";

// Chi vede che cosa in Support (area 8a) — l'unica regola, per letture e
// scritture. Le conversazioni e la richiesta nata le vedono i membri del
// progetto (chi lo vede); la casella della risposta ai collaboratori (canale
// `mcp`) solo chi ha `support.manage`; i widget solo chi ha `widget.manage`. Una
// conversazione di un progetto invisibile risponde come una che non esiste
// (R-G5). Lo stato della conversazione e quello per il cliente si DERIVANO
// qui, con le regole pure di `domain/support` e `domain/releases`.

export { holds, sees };

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

/**
 * L'avviso di una richiesta nata da una conversazione di Support, da
 * qualunque porta (il triage concluso, «Apri la richiesta»): uno per
 * richiesta, col suo codice e il suo link (R-K11).
 */
export function publishSupportRequest(req: ProjectRequest): void {
  publishAlert({
    kind: "support.request",
    projectId: req.projectId,
    objectCode: req.code,
    title: "New request from a customer",
    body: req.title,
    link: requestHref(req),
  });
}

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

/**
 * L'esito che è un ticket del widget (area 8, F3-1): la task, col passo che
 * vede il cliente (nessuna richiesta: le task, i rilasci delle loro PR).
 */
function taskOutcomeOf(c: SupportConversation): SupportConversationView["task"] {
  const task = c.taskId ? state.tasksById.get(c.taskId) : undefined;
  if (!task) return null;
  return {
    id: task.id,
    code: task.code,
    title: task.title,
    customerStatus: customerStatus(null, [task], releasesOfTask(task.id)),
  };
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

export interface SupportConversationView extends SupportConversation {
  projectCode: string;
  state: SupportState;
  lastMessage: SupportMessage | null;
  widgetName: string | null;
  request: SupportRequestView | null;
  /**
   * Build app (area 8, F3): l'esito è un TICKET aperto dal widget (nessuna
   * richiesta). Il prototipo non ne ha: assente.
   */
  task?: { id: string; code: string; title: string; customerStatus: CustomerStatus } | null;
  /**
   * Area 8, F3 (S17): sulla conversazione chiusa, quella che l'ha seguita;
   * sulla successiva, da dove viene. `null`: nessuna.
   */
  continuedIn: { code: string } | null;
  continuedFrom: { code: string } | null;
  /**
   * Cosa può fare chi guarda, deciso qui (il client non lo deduce). La
   * casella c'è SOLO sul canale `mcp` (i collaboratori interni), con
   * `support.manage`: al cliente del widget il team non scrive mai (area 8, F3).
   */
  canReplyToCollaborator: boolean;
  /** «Apri la richiesta»: su una non conclusa, con `support.manage` e `backlog.create`. */
  canOpenRequest: boolean;
  /** «Not concluded» (area 8, F3): su una `answered`, con `support.manage`. */
  canMarkNotConcluded: boolean;
}

export function conversationView(
  me: string,
  c: SupportConversation,
  // R.1414 (lotto 3): il masker della risposta (un elenco ne ha uno solo).
  mask: ReturnType<typeof personMasker> = personMasker(me),
): SupportConversationView {
  const manage = holds(me, "support.manage", c.projectId);
  const codeOf = (id: string | undefined) => {
    const other = id ? state.supportConversations.find((x) => x.id === id) : undefined;
    return other ? { code: other.code } : null;
  };
  const st = supportState(c);
  const req = requestOf(c);
  const rest = structuredClone(c);
  rest.messages = rest.messages.map((m) => ({ ...m, authorId: m.authorId === null ? null : mask(m.authorId) }));
  if (rest.triage) rest.triage = { ...rest.triage, byUserId: rest.triage.byUserId === null ? null : mask(rest.triage.byUserId) };
  return {
    ...rest,
    projectCode: projectCodeOf(c.projectId),
    state: st,
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
    task: taskOutcomeOf(c),
    continuedIn: codeOf(c.continuedInId),
    continuedFrom: codeOf(state.supportConversations.find((x) => x.continuedInId === c.id)?.id),
    canReplyToCollaborator: c.channel === "mcp" && manage,
    canOpenRequest: st === "not_concluded" && manage && holds(me, "backlog.create", c.projectId),
    canMarkNotConcluded: st === "answered" && manage,
  };
}
