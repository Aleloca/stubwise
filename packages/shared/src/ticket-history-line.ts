/**
 * Una riga della «Storia del lavoro» di un ticket, DESCRITTA ma non ancora in
 * parole: web e app la leggono da qui e la mettono nelle parole del proprio
 * catalogo (`apps/mobile/src/lib/ticket-history.ts`,
 * `apps/web/src/components/ticket-history.tsx`).
 *
 * Il server decide QUALI eventi ci sono (`buildTicketHistory`,
 * `@stubwise/notifications`); qui sta la regola di PRESENTAZIONE — quale
 * titolo per quale kind, chi, quale PR, se l'URL è apribile, di che colore è
 * il pallino. Sta in shared e non in un client perché i client sono due:
 * scritta una volta per superficie, al primo kind nuovo una delle due resta
 * indietro (lo stesso difetto di `pulse-line.ts`, che qui si evita).
 *
 * Tre scelte decise dal maintainer (D3 del piano
 * `2026-10-05-ticket-history-and-replies`), da non «migliorare»:
 *
 * - `ticket_closed` si legge come chiusura, con lo stato del server fra
 *   parentesi.
 * - `status_changed` dice il cambio di stato e basta, MAI «PR chiusa senza
 *   merge»: la stessa riga la scrive anche il triage che parcheggia un
 *   rilancio, e il dato non distingue i due casi.
 * - `actor: null` non ha nome e non diventa «automatico» (può essere un
 *   utente eliminato); una persona senza nome è «qualcuno».
 *
 * Un `kind` sconosciuto è `{ key: "unknown" }` («Aggiornamento»), mai
 * scartato: il server può aggiungere eventi prima che un client si aggiorni.
 */
import { isSafeWebUrl } from "./safe-url.js";

/**
 * Il colore del pallino (5 ott 2026, deciso dal maintainer provando l'app):
 * per SIGNIFICATO. Verde un traguardo, ambra dove è servita (o serve) una
 * persona, azzurro il lavoro dell'AI, rosso qualcosa andato storto, grigio il
 * contesto — cambi di stato, una richiesta annullata, un evento ignoto.
 */
export type HistoryTone = "ok" | "signal" | "sky" | "danger" | "faint";

/** I kind che diventano un titolo fisso, senza parametri. */
export type HistorySimpleTitleKey =
  | "run_started"
  | "question_asked"
  | "question_answered"
  | "plan_approved"
  | "plan_pre_approved"
  | "plan_rejected"
  | "pr_opened"
  | "changes_requested"
  | "changes_requested_cancelled"
  | "correction_pushed"
  | "correction_failed"
  | "unknown";

export type HistoryVerdict = "approve" | "requestChanges" | "other";

/**
 * Il titolo di una riga. Gli stati restano VALORI GREZZI del server: le
 * parole degli stati le ha già ogni client (con la sua parola per uno stato
 * che non conosce), e non vanno ricopiate qui.
 */
export type HistoryTitle =
  | { key: HistorySimpleTitleKey }
  | { key: "review_completed"; verdict: HistoryVerdict }
  | { key: "ticket_closed"; status: string }
  | { key: "status_changed"; from: string; to: string }
  | { key: "status_changed_to"; to: string };

/** Chi: un nome da mostrare così com'è, o una parola del catalogo. */
export type HistoryWho =
  | { key: "name"; name: string }
  | { key: "agent" }
  | { key: "someone" }
  | { key: "provider"; name: string };

export interface HistoryLineSpec {
  title: HistoryTitle;
  /** `null` = nessuna persona registrata: niente nome, mai «automatico». */
  who: HistoryWho | null;
  /** «PR #N» (`round: null`) o «PR #N · correzione K»; `null` fuori da una PR. */
  pr: { number: number; round: number | null } | null;
  /** La PR da aprire, SOLO se http/https (`isSafeWebUrl`). */
  url: string | null;
  tone: HistoryTone;
}

/**
 * Quello che serve di un evento: la forma di `TicketHistoryEvent`, strutturale
 * così da accettare sia la versione letta dall'app (`Reader<…>`, con `UNKNOWN`
 * negli enum) sia quella del web.
 */
export interface HistoryEventInput {
  kind: string;
  detail: string | null;
  fromStatus: string | null;
  actor: { type: string; name: string | null } | null;
  prNumber: number | null;
  prUrl: string | null;
  round: number | null;
}

export function historyToneFor(event: Pick<HistoryEventInput, "kind" | "detail">): HistoryTone {
  switch (event.kind) {
    case "pr_opened":
    case "plan_approved":
    case "ticket_closed":
      return "ok";
    case "review_completed":
      return event.detail === "approve" ? "ok" : event.detail === "request_changes" ? "signal" : "faint";
    case "changes_requested":
      return event.detail === "cancelled" ? "faint" : "signal";
    case "question_asked":
    case "question_answered":
      return "signal";
    case "run_started":
    case "correction_pushed":
      return "sky";
    case "correction_failed":
    case "plan_rejected":
      return "danger";
    default:
      return "faint";
  }
}

export function historyTitleFor(
  event: Pick<HistoryEventInput, "kind" | "detail" | "fromStatus">,
): HistoryTitle {
  const detail = event.detail;
  switch (event.kind) {
    case "run_started":
    case "question_asked":
    case "question_answered":
    case "plan_rejected":
    case "pr_opened":
    case "correction_pushed":
    case "correction_failed":
      return { key: event.kind };
    case "plan_approved":
      return { key: detail === "pre_approved" ? "plan_pre_approved" : "plan_approved" };
    case "review_completed":
      return {
        key: "review_completed",
        verdict: detail === "approve" ? "approve" : detail === "request_changes" ? "requestChanges" : "other",
      };
    case "changes_requested":
      return { key: detail === "cancelled" ? "changes_requested_cancelled" : "changes_requested" };
    case "ticket_closed":
      return { key: "ticket_closed", status: detail ?? "" };
    case "status_changed":
      if (detail === null) return { key: "unknown" };
      return event.fromStatus === null
        ? { key: "status_changed_to", to: detail }
        : { key: "status_changed", from: event.fromStatus, to: detail };
    default:
      return { key: "unknown" };
  }
}

export function historyWhoFor(actor: HistoryEventInput["actor"]): HistoryWho | null {
  if (actor === null) return null;
  switch (actor.type) {
    case "ai":
      return { key: "agent" };
    case "provider":
      return actor.name === null ? { key: "someone" } : { key: "provider", name: actor.name };
    case "user":
      return actor.name === null ? { key: "someone" } : { key: "name", name: actor.name };
    // `system` e un tipo che questa build non conosce: il nome com'è, se c'è.
    default:
      return actor.name === null ? null : { key: "name", name: actor.name };
  }
}

export function historyLineSpec(event: HistoryEventInput): HistoryLineSpec {
  return {
    title: historyTitleFor(event),
    who: historyWhoFor(event.actor),
    pr: event.prNumber === null ? null : { number: event.prNumber, round: event.round },
    url: event.prUrl !== null && isSafeWebUrl(event.prUrl) ? event.prUrl : null,
    tone: historyToneFor(event),
  };
}
