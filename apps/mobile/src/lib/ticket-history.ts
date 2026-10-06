import { historyLineSpec } from "@stubwise/shared";
import type { HistoryTitle, HistoryTone, HistoryWho, Reader, TicketHistoryEvent } from "@stubwise/shared";
import type { TFunction } from "i18next";
import { TICKET_STATUSES } from "./ticket-labels";

/**
 * Una riga della «Storia del lavoro» in parole (piano
 * `2026-10-05-ticket-history-and-replies`, B3). Il server decide QUALI eventi
 * ci sono e cosa significano (`buildTicketHistory`, `@stubwise/notifications`);
 * qui si mettono solo in parole — nessuna regola ricopiata. Anche la regola di
 * PRESENTAZIONE (quale titolo, chi, quale PR, che colore) non sta qui: è
 * `historyLineSpec` di `@stubwise/shared`, la stessa che usa il web
 * (`apps/web/src/components/ticket-history.tsx`). Qui restano le parole.
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
  /** Il colore del pallino: vedi `historyToneFor` di shared. */
  tone: HistoryTone;
}

/** Il colore del pallino: la regola è `historyToneFor` di shared. */
export type { HistoryTone };

const KNOWN_STATUSES: ReadonlySet<string> = new Set(TICKET_STATUSES);

/** Uno stato del ticket in parole; uno ignoto non esce grezzo. */
function statusWord(status: string, t: TFunction): string {
  return KNOWN_STATUSES.has(status)
    ? t(`mobile.search.ticketStatus.${status}`)
    : t("mobile.search.ticketStatus.unknown");
}

function titleWords(title: HistoryTitle, t: TFunction): string {
  switch (title.key) {
    case "review_completed":
      return t("mobile.work.history.kinds.review_completed", {
        verdict: t(`mobile.work.history.verdict.${title.verdict}`),
      });
    case "ticket_closed":
      return t("mobile.work.history.kinds.ticket_closed", { status: title.status });
    case "status_changed":
      return t("mobile.work.history.kinds.status_changed", {
        from: statusWord(title.from, t),
        to: statusWord(title.to, t),
      });
    case "status_changed_to":
      return t("mobile.work.history.kinds.status_changed_to", { to: statusWord(title.to, t) });
    default:
      return t(`mobile.work.history.kinds.${title.key}`);
  }
}

function whoWords(who: HistoryWho | null, t: TFunction): string | null {
  if (who === null) return null;
  switch (who.key) {
    case "name":
      return who.name;
    case "agent":
      return t("mobile.work.history.who.agent");
    case "someone":
      return t("mobile.work.history.who.someone");
    case "provider":
      return t("mobile.work.history.who.provider", { name: who.name });
  }
}

export function historyLineFor(event: Reader<TicketHistoryEvent>, t: TFunction): HistoryLine {
  const spec = historyLineSpec(event);
  const pr =
    spec.pr === null
      ? null
      : spec.pr.round === null
        ? t("mobile.work.history.pr", { number: spec.pr.number })
        : t("mobile.work.history.prCorrection", { number: spec.pr.number, round: spec.pr.round });
  return {
    title: titleWords(spec.title, t),
    who: whoWords(spec.who, t),
    pr,
    url: spec.url,
    tone: spec.tone,
  };
}
