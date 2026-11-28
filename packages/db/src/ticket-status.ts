import { getTableColumns, sql, type SQL } from "drizzle-orm";
import { tickets } from "./schema.js";

// Gli stati senza l'enum (blocco T del ritiro del web vecchio, R0;
// `docs/invariants/tasks.md`, `docs/plans/2026-11-28-ritiro-web-vecchio-piano.md`
// §1.2). La colonna `tickets.status` non c'è più (0245, R3): chi cambia
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
 * anche `triagedAt: sql\`now()\``, e il trigger `tickets_state` lo azzera
 * quando il ticket esce da todo.
 */
export function statusIdForRole(role: TicketRole): SQL<string> {
  return sql<string>`stubwise_status_for_legacy(${tickets.projectId}, ${roleLiteral(role)}, ${tickets.statusId})`;
}

/**
 * Il ruolo come LETTERALE SQL senza tipo (`'done'`): Postgres lo risolve sul
 * tipo del parametro della funzione, che è l'enum `ticket_status` prima della
 * 0245 (R3) e `text` dopo. Un cast esplicito legherebbe il codice a uno dei
 * due schemi, e dopo R3 si deve poter scendere a R2 (deploy-log, «R3»). Il
 * valore viene da un elenco chiuso, e si controlla.
 */
export function roleLiteral(role: TicketRole): SQL {
  if (!ALL_ROLES.includes(role)) throw new Error(`ruolo sconosciuto: ${String(role)}`);
  return sql.raw(`'${role}'`);
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

const ALL_ROLES: readonly TicketRole[] = ["open", "triaged", "in_progress", "in_review", "done", "closed"];

/**
 * Il filtro «il ticket ha uno di questi ruoli», scritto in modo che usi gli
 * indici su `status_id`: `status_id IN (gli stati del ruolo)` più, se serve,
 * la condizione su `triaged_at` (che fuori da todo è sempre NULL, lo
 * garantisce il trigger). Dà lo stesso esito di
 * `inArray(ticketStatusSql, roles)`, che invece calcola la funzione riga per riga.
 */
export function ticketRoleIn(roles: readonly TicketRole[]): SQL {
  const wanted = new Set(roles);
  const legacy = [...new Set([...wanted].map((r) => (r === "triaged" ? "open" : r)))];
  if (legacy.length === 0) return sql`false`;
  // `legacy_status::text`: regge l'enum di prima della 0245 e il text di dopo.
  const inStates = sql`${tickets.statusId} in (select "id" from "project_statuses" where "legacy_status"::text = any(array[${sql.join(
    legacy.map((r) => sql`${r}`),
    sql`, `,
  )}]::text[]))`;
  if (wanted.has("open") && !wanted.has("triaged")) return sql`(${inStates} and ${tickets.triagedAt} is null)`;
  if (wanted.has("triaged") && !wanted.has("open"))
    return sql`(${inStates} and (${tickets.triagedAt} is not null or ${tickets.statusId} not in (select "id" from "project_statuses" where "legacy_status"::text = 'open')))`;
  return inStates;
}

/** Il contrario di `ticketRoleIn`: il ticket NON ha nessuno di questi ruoli. */
export function ticketRoleNotIn(roles: readonly TicketRole[]): SQL {
  return ticketRoleIn(ALL_ROLES.filter((r) => !roles.includes(r)));
}

/** I ruoli chiusi (famiglia `closed`). */
export const CLOSED_ROLES: readonly TicketRole[] = ["done", "closed"];

/**
 * Tutte le colonne di un ticket più lo `status` derivato: la forma di `Ticket`.
 * Per `.select(ticketColumns)` e `.returning(ticketColumns)` (i trigger BEFORE
 * hanno già deciso `status_id` e `triaged_at`, quindi il derivato è quello vero).
 */
export const ticketColumns = { ...getTableColumns(tickets), status: ticketStatusSql };
