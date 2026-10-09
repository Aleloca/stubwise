import type { InboxItem, Reader } from "@stubwise/shared";
import { Linking } from "react-native";
import { can } from "./inbox-sections";
import { ticketTabForKind } from "./ticket-tabs";
import type { TicketTab } from "./ticket-tabs";

/** Chi sa navigare (lo screen) apre il ticket nell'app, sulla tab data. */
export type OpenTicket = (ticketId: string, tab: TicketTab) => void;

/**
 * Chi sa navigare apre la SESSIONE di un job (piano C, Task 8): la schermata
 * `AgentSessionByJob` la cerca e, se non c'è, ripiega sul ticket — per questo
 * riceve anche `ticketId`.
 */
export type OpenSessionForJob = (jobId: string, ticketId: string) => void;

/**
 * I kind di notifica che RIGUARDANO un ticket. Gli altri (posta, pulse,
 * brief, monitor, docs…) non cambiano: «Apri» resta il loro link, anche se un
 * domani portassero un `ticketId`.
 */
const TICKET_KINDS: ReadonlySet<unknown> = new Set([
  "ticket.created",
  "job.pr_opened",
  "job.pr_closed",
  "job.held",
  "job.plan_review",
  "job.budget_held",
  "review.completed",
  "job.failed",
  "job.awaiting_input",
]);

/**
 * Il gesto di «Apri» di una card d'inbox (pagina del ticket a tab, 2 ott 2026,
 * decisione del maintainer): per un kind di ticket con `ticketId`, il ticket
 * NELL'APP sulla tab di `ticketTabForKind` (oggi Stato) — anche per le card
 * PR, la cui PR si apre dal titolo della sua card in Stato. Altrimenti il
 * link di oggi (`item.url`, che il server calcola). `null` = nessun «Apri».
 *
 * Se «Apri» C'È lo decide ancora il server (`can(item, "open")`): il client
 * cambia DOVE porta, non SE c'è. `inAppOnly` per la card che oggi non ha
 * «Apri» (`PlanReviewCard`): lo guadagna solo se porta al ticket nell'app,
 * mai il link al web.
 *
 * La DOMANDA dell'agente (`job.awaiting_input`) porta alla sessione che la
 * sta facendo (piano C, Task 8; design §8.4) con `onOpenSessionForJob`: solo
 * con `jobId` E `ticketId`, la stessa condizione di `openHref` sul web
 * (`apps/web/src/components/inbox-item.tsx`) — il ticket serve al ripiego.
 * Senza la callback, o senza uno dei due, il comportamento di prima.
 */
export function openActionFor(
  item: Reader<InboxItem>,
  onOpenTicket: OpenTicket | undefined,
  options: { inAppOnly?: boolean; onOpenSessionForJob?: OpenSessionForJob } = {},
): (() => void) | null {
  if (!can(item, "open")) return null;
  const ticketId = item.ticketId ?? null;
  const kind = item.kind;
  const jobId = item.jobId ?? null;
  const onOpenSessionForJob = options.onOpenSessionForJob;
  if (kind === "job.awaiting_input" && onOpenSessionForJob !== undefined && jobId !== null && ticketId !== null) {
    return () => onOpenSessionForJob(jobId, ticketId);
  }
  if (onOpenTicket !== undefined && ticketId !== null && typeof kind === "string" && TICKET_KINDS.has(kind)) {
    const tab = ticketTabForKind(kind);
    return () => onOpenTicket(ticketId, tab);
  }
  if (options.inAppOnly === true) return null;
  const url = item.url;
  if (url === undefined) return null;
  // Lo stesso gesto di prima, invariato.
  return () => void Linking.openURL(url);
}
