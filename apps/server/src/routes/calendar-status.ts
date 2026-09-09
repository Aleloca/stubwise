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
    when ${calendarEvents.outcome}->>'type' = 'cancelled' then 'cancelled'
    else 'actioned'
  end`;
}

/**
 * Riproponibile: SOLO `failed`/`ignored`, come `isReadyForProposal` per il
 * resto del cancello. `coalesce(..., false)`: `outcome->>'type' in (...)` è
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
