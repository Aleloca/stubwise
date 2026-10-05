import { isSafeWebUrl, isUnknown } from "@stubwise/shared";
import type { Reader, TicketHistoryEvent } from "@stubwise/shared";
import type { TFunction } from "i18next";
import { TICKET_STATUSES } from "./ticket-labels";

/**
 * Una riga della «Storia del lavoro» in parole (piano
 * `2026-10-05-ticket-history-and-replies`, B3). Il server decide QUALI eventi
 * ci sono e cosa significano (`buildTicketHistory`, `@stubwise/notifications`);
 * qui si mettono solo in parole — nessuna regola ricopiata.
 *
 * Tre scelte decise dal maintainer (D3), da non «migliorare»:
 *
 * - `ticket_closed` si legge come chiusura: «Ticket chiuso (done)». Lo stato
 *   fra parentesi è il valore del server, come nell'esempio del maintainer.
 * - `status_changed` dice il cambio di stato e basta: «Stato: in review →
 *   triage». MAI «PR chiusa senza merge»: la stessa riga la scrive anche il
 *   triage che parcheggia un rilancio, e il dato non distingue i due casi.
 * - `actor: null` non ha nome e non diventa «automatico» (può essere un
 *   utente eliminato); una persona senza nome (`user` con `name: null`) è
 *   «qualcuno».
 *
 * Un `kind` che questa build non conosce è una riga generica
 * («Aggiornamento»), mai scartata: il server può aggiungere eventi prima che
 * l'app si aggiorni dagli store.
 */
export interface HistoryLine {
  title: string;
  /** Chi l'ha fatto, o `null` se nessuna persona è registrata. */
  who: string | null;
  /** «PR #4» o «PR #4 · correzione 3», o `null` se l'evento non è su una PR. */
  pr: string | null;
  /** La PR da aprire, SOLO se http/https (`isSafeWebUrl` di shared). */
  url: string | null;
}

const KNOWN_STATUSES: ReadonlySet<string> = new Set(TICKET_STATUSES);

/** Uno stato del ticket in parole; uno ignoto non esce grezzo. */
function statusWord(status: string, t: TFunction): string {
  return KNOWN_STATUSES.has(status)
    ? t(`mobile.search.ticketStatus.${status}`)
    : t("mobile.search.ticketStatus.unknown");
}

function titleFor(event: Reader<TicketHistoryEvent>, t: TFunction): string {
  const detail = event.detail;
  switch (event.kind) {
    case "run_started":
    case "question_asked":
    case "question_answered":
    case "plan_rejected":
    case "pr_opened":
    case "correction_pushed":
    case "correction_failed":
      return t(`mobile.work.history.kinds.${event.kind}`);
    case "plan_approved":
      return detail === "pre_approved"
        ? t("mobile.work.history.kinds.plan_pre_approved")
        : t("mobile.work.history.kinds.plan_approved");
    case "review_completed": {
      const verdict =
        detail === "approve"
          ? t("mobile.work.history.verdict.approve")
          : detail === "request_changes"
            ? t("mobile.work.history.verdict.requestChanges")
            : t("mobile.work.history.verdict.other");
      return t("mobile.work.history.kinds.review_completed", { verdict });
    }
    case "changes_requested":
      return detail === "cancelled"
        ? t("mobile.work.history.kinds.changes_requested_cancelled")
        : t("mobile.work.history.kinds.changes_requested");
    case "ticket_closed":
      return t("mobile.work.history.kinds.ticket_closed", { status: detail ?? "" });
    case "status_changed":
      if (detail === null) return t("mobile.work.history.kinds.unknown");
      return event.fromStatus === null
        ? t("mobile.work.history.kinds.status_changed_to", { to: statusWord(detail, t) })
        : t("mobile.work.history.kinds.status_changed", {
            from: statusWord(event.fromStatus, t),
            to: statusWord(detail, t),
          });
    default:
      return t("mobile.work.history.kinds.unknown");
  }
}

function whoFor(actor: Reader<TicketHistoryEvent>["actor"], t: TFunction): string | null {
  if (actor === null) return null;
  if (isUnknown(actor.type)) return actor.name;
  switch (actor.type) {
    case "ai":
      return t("mobile.work.history.who.agent");
    case "system":
      return actor.name;
    case "provider":
      return actor.name === null
        ? t("mobile.work.history.who.someone")
        : t("mobile.work.history.who.provider", { name: actor.name });
    case "user":
      return actor.name ?? t("mobile.work.history.who.someone");
  }
}

export function historyLineFor(event: Reader<TicketHistoryEvent>, t: TFunction): HistoryLine {
  const pr =
    event.prNumber === null
      ? null
      : event.round === null
        ? t("mobile.work.history.pr", { number: event.prNumber })
        : t("mobile.work.history.prCorrection", { number: event.prNumber, round: event.round });
  return {
    title: titleFor(event, t),
    who: whoFor(event.actor, t),
    pr,
    url: event.prUrl !== null && isSafeWebUrl(event.prUrl) ? event.prUrl : null,
  };
}
