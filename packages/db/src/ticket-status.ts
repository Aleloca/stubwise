import { getTableColumns, sql, type SQL } from "drizzle-orm";
import { tickets } from "./schema.js";

// Gli stati senza l'enum (blocco T del ritiro del web vecchio, R0;
// `docs/invariants/tasks.md`, `docs/plans/2026-11-28-ritiro-web-vecchio-piano.md`
// §1.2). La colonna `tickets.status` non è più nello schema: chi cambia
// stato scrive `statusId`, chi lo legge lo deriva. La regola resta in SQL, in
// UN posto (`stubwise_status_for_legacy`, `stubwise_ticket_status`): qui
// stanno solo i frammenti che la richiamano.

/** I ruoli di uno stato: i valori dell'enum di prima, che pipeline, MCP e mobile conoscono. */
export type TicketRole = "open" | "triaged" | "in_progress" | "in_review" | "done" | "closed";

/**
 * Il `statusId` in cui un ticket va quando uno scrittore gli dà un ruolo:
 * `stubwise_status_for_legacy(progetto, ruolo, stato corrente)`, la regola di
 * 0108 (resta dov'è se lo stato corrente lo soddisfa già, mai indietro per
 * `in_review`, …). Si usa nell'`UPDATE`: `.set({ statusId: statusIdForRole("done") })`.
 *
 * `triaged` è un ruolo `open` più `triagedAt` (0240): chi lo scrive imposta
 * anche `triagedAt: sql\`now()\``, e il trigger `tickets_triaged_reset` lo
 * azzera quando il ticket esce da todo.
 */
export function statusIdForRole(role: TicketRole): SQL<string> {
  return sql<string>`stubwise_status_for_legacy(${tickets.projectId}, ${role}::"ticket_status", ${tickets.statusId})`;
}

/**
 * Ciò che uno scrittore mette nell'`UPDATE` per dare un ruolo a un ticket:
 * `statusId` dalla regola di 0108 e, per i ruoli di todo, il segno dello
 * smistamento (`triaged` → `triagedAt` adesso, `open` → nessun segno). Fuori
 * da todo il segno lo toglie il trigger. È l'unico modo in cui il codice
 * cambia il ruolo di un ticket: `.set({ ...roleUpdate("done"), updatedAt })`.
 */
export function roleUpdate(role: TicketRole): { statusId: SQL<string>; triagedAt?: SQL<Date> | null } {
  if (role === "triaged") return { statusId: statusIdForRole(role), triagedAt: sql<Date>`now()` };
  if (role === "open") return { statusId: statusIdForRole(role), triagedAt: null };
  return { statusId: statusIdForRole(role) };
}

/**
 * Lo `status` di un ticket, DERIVATO a lettura (0240,
 * `stubwise_ticket_status`): il ruolo dello stato corrente, o `triaged` per un
 * todo già smistato. Si seleziona come una colonna:
 * `.select({ status: ticketStatusSql })`.
 */
export const ticketStatusSql: SQL<TicketRole> = sql<TicketRole>`stubwise_ticket_status(${tickets.statusId}, ${tickets.triagedAt})`;

/** I ruoli chiusi (famiglia `closed`). */
export const CLOSED_ROLES: readonly TicketRole[] = ["done", "closed"];

/**
 * Tutte le colonne di un ticket più lo `status` derivato: la forma di `Ticket`.
 * Per `.select(ticketColumns)` e `.returning(ticketColumns)` (i trigger BEFORE
 * hanno già deciso `status_id` e `triaged_at`, quindi il derivato è quello vero).
 */
export const ticketColumns = { ...getTableColumns(tickets), status: ticketStatusSql };
