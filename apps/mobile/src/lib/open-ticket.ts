import type { InboxItem, Reader } from "@stubwise/shared";
import { Linking } from "react-native";
import { can } from "./inbox-sections";
import { ticketTabForKind } from "./ticket-tabs";
import type { TicketTab } from "./ticket-tabs";

/** Chi sa navigare (lo screen) apre il ticket nell'app, sulla tab data. */
export type OpenTicket = (ticketId: string, tab: TicketTab) => void;

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
 */
export function openActionFor(
  item: Reader<InboxItem>,
  onOpenTicket: OpenTicket | undefined,
  options: { inAppOnly?: boolean } = {},
): (() => void) | null {
  if (!can(item, "open")) return null;
  const ticketId = item.ticketId ?? null;
  const kind = item.kind;
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
