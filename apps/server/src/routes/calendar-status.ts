import { calendarEvents } from "@stubwise/db";
import { sql } from "drizzle-orm";

/**
 * Lo stato NORMALIZZATO di una riga `calendar_events`, condiviso da
 * `me-mail.ts` (pagina Posta fusa) e `me-calendar.ts` (fase 7b, pagina
 * Calendario dedicata) — un solo posto, non due copie che poi divergono, a
 * differenza della duplicazione fra server e worker (quella attraversa un
 * confine di pacchetto/deploy reale; questa no).
 *
 * La regola replica `isReadyForProposal` (`apps/worker/src/google/calendar.ts`)
 * e `outcome.type` scritto da `google-proposal.ts`: se quelle cambiano, questa
 * CASE va aggiornata insieme — i tre punti sono commentati l'uno sull'altro
 * apposta, e non c'è un test di parità automatico.
 *
 * ⚠️ **Questo stato NON sa nulla del RIFIUTO, ed è deliberato** (15 set 2026,
 * §1 — decisione del maintainer). Il cancello del rifiuto vive in tre punti
 * (`isReadyForProposal`, la `where` del propose phase, il conteggio
 * `stats.ready`) e questa CASE **non è il quarto**: risponde a un'altra
 * domanda — «in che stato è questa riga da mostrare» — e insegnarglielo
 * vorrebbe dire rifare `hasDeclinedInvitation` in SQL su OGNI lettura di
 * `/mail` e `/calendar`, cioè un quinto posto da tenere allineato per
 * guadagnare un'etichetta.
 *
 * La conseguenza, da conoscere: **un appuntamento rifiutato che non ha mai
 * avuto una proposta resta `new` per sempre**, e non diventerà mai
 * `proposed`. Va bene perché l'etichetta di quello stato è «Nuova», neutra:
 * non promette «da proporre», quindi non dice una bugia. Ma chi un domani ci
 * appoggia un FILTRO o un CONTATORE («quante ne restano da proporre?»)
 * starebbe promettendo qualcosa che per quelle righe non succederà mai — e
 * quello sì sarebbe un difetto. Chi ne ha bisogno guardi `attendees` più
 * l'indirizzo della casella con `hasDeclinedInvitation` (`@stubwise/shared`),
 * che è l'unico posto in cui «quali risposte bloccano» è scritto.
 *
 * Il RIFIUTO SOPRAVVENUTO invece sì, passa di qui: quando un appuntamento
 * con una proposta APERTA viene rifiutato, il poller chiude la riga con
 * `outcome.type = 'declined'` (`CALENDAR_DECLINED_OUTCOME`), e quel tipo va
 * mappato qui sotto — senza, cadrebbe nell'`else` e la riga si mostrerebbe
 * «Eseguita», che è falso: non è stato eseguito niente. È mappato su
 * `ignored` — «chiusa senza azione» — e NON su un valore nuovo:
 * `mailItemStatusSchema` è un enum che l'app mobile legge, e non lo si paga
 * per un'etichetta. Da COSA è stata chiusa lo dice `outcome.type`, come per
 * `superseded_by_message` nella posta.
 *
 * Restituisce una NUOVA espressione a ogni chiamata: Postgres non permette di
 * riferire un alias di SELECT nel WHERE della stessa query, quindi la CASE si
 * ripete fra proiezione e filtro, e il builder `sql` non è riusabile fra due
 * punti della stessa query.
 */
export function calendarStatusCaseSql() {
  return sql<string>`case
    when ${calendarEvents.status} = 'cancelled' then 'cancelled'
    when ${calendarEvents.outcome} is null and ${calendarEvents.proposalNotificationId} is null then 'new'
    when ${calendarEvents.outcome} is null then 'proposed'
    when ${calendarEvents.outcome}->>'type' = 'failed' then 'failed'
    when ${calendarEvents.outcome}->>'type' = 'ignored' then 'ignored'
    -- Rifiutato (15 set 2026, §1): chiusa senza azione, NON eseguita.
    when ${calendarEvents.outcome}->>'type' = 'declined' then 'ignored'
    when ${calendarEvents.outcome}->>'type' = 'cancelled' then 'cancelled'
    else 'actioned'
  end`;
}

/**
 * Riproponibile: SOLO `failed`/`ignored`, come `isReadyForProposal` per il
 * resto del cancello.
 *
 * ⚠️ Una riga chiusa da un RIFIUTO ha `outcome.type = 'declined'`, che non è
 * in questo elenco: non è riproponibile, ed è giusto — riproporre un
 * appuntamento a cui hai detto di no rifarebbe nascere la card che il
 * rifiuto ha appena chiuso. Il bottone quindi non compare. Il caso che il
 * bottone lo mostra ancora è un altro — una riga chiusa PRIMA come
 * `failed`/`ignored` e rifiutata DOPO — e lo ferma la rotta di repropose in
 * `me-mail.ts`, con un 409 parlante invece di un ok che non fa niente. `coalesce(..., false)`: `outcome->>'type' in (...)` è
 * SQL a tre valori — con `outcome` `NULL` (nessuna azione ancora presa) il
 * confronto vale `NULL`, non `false`, e senza il coalesce lo schema di
 * risposta (`reproposable: z.boolean()`) rifiuterebbe la riga.
 */
export function calendarReproposableSql() {
  return sql<boolean>`coalesce(${calendarEvents.outcome}->>'type' in ('failed', 'ignored'), false)`;
}

/** Il GIORNO di un istante in ISO (`YYYY-MM-DD`), per il link al calendario. */
export function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** Link alla giornata dell'evento sul calendario Google della casella. */
export function calendarDayUrl(mailboxEmail: string, startsAt: Date): string {
  const [year, month, day] = isoDay(startsAt).split("-");
  return `https://calendar.google.com/calendar/u/${encodeURIComponent(mailboxEmail)}/r/day/${year}/${Number(month)}/${Number(day)}`;
}
