import { applyActions } from "../api-mutations";
import { now, state } from "../store";
import type { CalendarEvent, MailProposal } from "../types";
import { deadlineProposal, seriesProposal } from "./proposals";
import { canSeeEvent, inWindow } from "./visibility";

// Le proposte che nascono dal Calendario (area 6): le scadenze e le date
// delle serie accese. Le scrive l'allineamento (tutto il calendario di chi
// si allinea) e la configurazione di una serie (solo le sue date).

/**
 * Una proposta di una serie con «Agisci da solo»: nasce già confermata, da
 * Stubwise (`decidedById: null`), eseguita a nome di chi ha il calendario
 * (`actor`) con i suoi permessi. Non avvia mai il lavoro di Claude: le
 * azioni di una serie non comprendono `startRun`. Se l'esecuzione fallisce
 * resta `failed`, col codice.
 */
function settleAutomatically(actor: string, p: MailProposal): void {
  const result = applyActions(actor, p.actions);
  p.decidedAt = now();
  if (result.ok) {
    p.status = "confirmed";
    p.resultCodes = result.codes;
  } else {
    p.status = "failed";
    p.error = result.code;
  }
}

/**
 * Le proposte nuove degli eventi che `actor` vede nella finestra (solo
 * quelli che passano `only`, se c'è): le scadenze e le date delle serie
 * accese entrate nei giorni di anticipo. Mai per una data passata, quindi
 * accendere una serie non crea nulla all'indietro. Una per evento (o data):
 * una già nata non si rifà.
 */
export function proposeFromCalendar(actor: string, only?: (e: CalendarEvent) => boolean): void {
  const at = now();
  for (const e of state.calendarEvents) {
    if ((only && !only(e)) || !canSeeEvent(actor, e) || !inWindow(e)) continue;
    const series = state.calendarSeries.find((s) => s.id === e.seriesId);
    const fromSeries = series ? seriesProposal(series, e, at) : null;
    for (const p of [deadlineProposal(e, at), fromSeries]) {
      if (!p || state.mailProposals.some((x) => x.id === p.id)) continue;
      if (p === fromSeries && series!.auto) settleAutomatically(actor, p);
      state.mailProposals.push(p);
    }
  }
}
