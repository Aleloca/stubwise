import type { Reader, TicketRepository } from "@stubwise/shared";
import { isUnknown } from "@stubwise/shared";
import { actionsOf } from "./pr-cycle";

/**
 * La pagina del ticket a tab (2 ott 2026, design
 * `docs/plans/2026-10-02-app-ticket-tabs-design.md`): quale tab si apre e
 * quando la tab Stato chiede un'azione a chi guarda. Funzioni pure, nessun
 * React: la schermata le chiama e basta.
 */

export const TICKET_TABS = ["status", "content", "activity", "details"] as const;
export type TicketTab = (typeof TICKET_TABS)[number];

/**
 * Il parametro `tab` della rotta, letto come lo manda chiunque (una card
 * d'inbox, un deep link, un chiamante futuro): assente, sconosciuto o non
 * stringa → Stato. Mai un cast: una tab che non esiste lascerebbe la
 * schermata senza nessuna tab selezionata.
 */
export function parseTicketTab(value: unknown): TicketTab {
  return TICKET_TABS.find((tab) => tab === value) ?? "status";
}

/** Gli stati del ciclo in cui una PR aspetta che una PERSONA chieda modifiche. */
const NEEDS_A_REQUEST = new Set(["stopped_at_cap", "correction_failed", "changes_requested"]);

/**
 * Il pallino della tab Stato: dietro c'è un'azione che CHI GUARDA può fare
 * adesso. Solo dati che la schermata ha già, nessun campo nuovo dal server.
 *
 * - una domanda dell'AI aperta e `canAnswer`;
 * - un piano da approvare (`canDecide`, che include già lo stato del job);
 * - una PR con un'azione DAVVERO offerta (decisione del maintainer, piano
 *   §3.3): «Chiedi modifiche» offerto (PR aperta, {@link actionsOf}) e
 *   acceso (`canRequestCorrection`) su uno stato che aspetta una persona;
 *   oppure «Riprendi» offerto (`canResume` + `heldJobId`, sempre
 *   {@link actionsOf}) su una correzione ferma per un motivo che non si
 *   risolve da solo — `limit` escluso, riparte da sé. Un pallino su una tab
 *   dove il bottone è spento chiederebbe un'azione che non si può fare.
 *
 * ⚠️ `canAnswer` e `canDecide` non arrivano dal server: li DEDUCE
 * `WorkScreen` dal ruolo, come fa già per mostrare i bottoni (l'autorità
 * resta il server). Il ciclo invece è tutto del server: qui lo si legge e
 * basta, ruolo mai in input.
 */
export function statusNeedsViewer(input: {
  hasOpenQuestion: boolean;
  canAnswer: boolean;
  canDecide: boolean;
  repositories: readonly Reader<TicketRepository>[];
}): boolean {
  if (input.hasOpenQuestion && input.canAnswer) return true;
  if (input.canDecide) return true;
  return input.repositories.some(prNeedsViewer);
}

function prNeedsViewer(repo: Reader<TicketRepository>): boolean {
  const cycle = repo.cycle ?? null;
  if (repo.prUrl === null || cycle === null) return false;
  const actions = actionsOf(repo);
  const state = cycle.state;
  if (actions.request && cycle.canRequestCorrection && !isUnknown(state) && NEEDS_A_REQUEST.has(state)) return true;
  return actions.resumeJobId !== null && (cycle.heldReason ?? null) !== "limit";
}

/**
 * Quale tab apre una notifica che riguarda il ticket. Oggi TUTTE vanno su
 * Stato — è lì che si risponde, si approva, si guarda la PR — e nessuna su
 * Attività: non esiste un kind per i commenti (decisione del maintainer, 2
 * ott 2026). Un kind sconosciuto va su Stato, come un parametro sconosciuto.
 * Il valore `activity` della rotta resta per il deep link.
 */
export function ticketTabForKind(kind: string): TicketTab {
  void kind;
  return "status";
}
