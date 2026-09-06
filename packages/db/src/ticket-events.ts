import type { Db } from "./client.js";
import { ticketEvents } from "./schema.js";

/** `Db` o una transazione drizzle: l'audit va scritto dove sta l'UPDATE. */
type DbOrTx = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];

/**
 * Registra in `ticket_events` la transizione di stato di un ticket.
 *
 * Esiste perché fino alla fase 5 l'unico a lasciare traccia era
 * `PATCH /api/tickets/:id`: le transizioni fatte dal webhook git (PR mergiata →
 * `done`, PR chiusa → `triaged`) e dal worker (`in_progress`, `in_review`,
 * chiusura all'intake del backlog) cambiavano `tickets.status` in silenzio. La
 * timeline di progetto ha bisogno di un evento DATATO per collocare "ticket
 * chiuso", e `tickets.updated_at` non lo è: dice quando la riga è cambiata
 * l'ultima volta, non quando è passata a `done`.
 *
 * `actorId: null` è il valore giusto — non un ripiego — per le transizioni di
 * SISTEMA: nessuna persona le ha decise, e la timeline le rende come tali.
 *
 * Va chiamata NELLA STESSA transazione dell'UPDATE che descrive: un audit che
 * sopravvive a un UPDATE annullato racconterebbe una transizione mai avvenuta.
 *
 * `from === to` è un no-op: non è una transizione, e registrarla riempirebbe la
 * timeline di righe che non dicono nulla (i chiamanti fanno UPDATE guardati che
 * a volte non toccano niente).
 */
export async function recordTicketStatusChange(
  db: DbOrTx,
  params: { ticketId: string; from: string; to: string; actorId: string | null },
): Promise<void> {
  if (params.from === params.to) return;
  await db.insert(ticketEvents).values({
    ticketId: params.ticketId,
    actorId: params.actorId,
    kind: "status_changed",
    payload: { from: params.from, to: params.to },
  });
}
