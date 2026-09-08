/**
 * Modifica di un ticket con audit: il diff campo per campo che alimenta
 * `ticket_events` e le validazioni che lo precedono.
 *
 * PERCHÉ UN SERVIZIO: la PATCH del ticket è la mutazione più ricca del
 * dominio — otto campi, tre validazioni, un diff che deve finire in UN solo
 * INSERT di eventi con l'attore giusto — ed è esattamente quella che una
 * seconda superficie non può permettersi di reimplementare. Oggi la chiama
 * `PATCH /api/tickets/:id`; dalla fase 6 la chiamerà la conferma di una
 * proposta nata dalla posta (assegnare, cambiare priorità, chiudere), con una
 * transazione già aperta e un attore che è il proprietario della casella.
 *
 * L'ATTORE È UN PARAMETRO ESPLICITO, non `request.user`: questo modulo non
 * conosce Fastify, e chi scrive gli eventi deve poter dire CHI li ha causati
 * anche quando non c'è una richiesta HTTP dietro.
 *
 * IL `tx` LO PASSA IL CHIAMANTE. `patchTicket` non apre transazioni: SELECT
 * della riga corrente, validazione della milestone, diff, UPDATE e INSERT degli
 * eventi devono essere atomici, ma chi chiama può avere una transazione più
 * grande da rispettare (la stessa che chiude la proposta).
 *
 * ⚠️ LA VIOLAZIONE DI FK SULL'ASSEGNATARIO NON È CATTURATA QUI, di proposito.
 * `assigneeId` è pre-verificato con una SELECT, ma resta una finestra TOCTOU:
 * l'utente può sparire fra la verifica e l'UPDATE. Quell'errore ABORTA la
 * transazione, quindi catturarlo dentro non servirebbe a niente — chi apre la
 * transazione lo cattura FUORI (`isForeignKeyViolation` → `assignee_not_found`),
 * come faceva la rotta.
 */

import { eq } from "drizzle-orm";
import type { Db } from "@stubwise/db";
import { milestones, ticketEvents, tickets, users } from "@stubwise/db";
import type { Ticket } from "../db/tickets.js";

/** `Db` o una transazione drizzle già aperta dal chiamante. */
type DbOrTx = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];

/** Forma minimale dell'evento da inserire, prima di aggiungere ticketId/actorId. */
export type PendingEvent = Pick<typeof ticketEvents.$inferInsert, "kind" | "payload">;

/** I campi di un ticket modificabili da una PATCH, tutti opzionali. */
export type TicketPatch = Partial<
  Pick<
    Ticket,
    "title" | "body" | "type" | "priority" | "status" | "assigneeId" | "milestoneId" | "labels"
  >
>;

export type PatchTicketError = "assignee_not_found" | "ticket_not_found" | "milestone_cross_project";

export type PatchTicketResult =
  | { ok: true; ticket: Ticket; events: PendingEvent[] }
  | { ok: false; error: PatchTicketError };

export interface PatchTicketInput {
  ticketId: string;
  /** Chi sta modificando: finisce in `ticket_events.actor_id`. */
  actorId: string;
  patch: TicketPatch;
}

/** True se l'id corrisponde a un utente esistente (per validare assigneeId). */
export async function userExists(db: DbOrTx, userId: string): Promise<boolean> {
  const [row] = await db.select({ id: users.id }).from(users).where(eq(users.id, userId));
  return row !== undefined;
}

/**
 * True se due liste di label rappresentano lo stesso insieme: l'ordine non
 * conta (riordinare le label in un PATCH non è una modifica reale), ma i
 * duplicati sì — confronto come multiset ordinato.
 */
function sameLabels(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sa = [...a].sort();
  const sb = [...b].sort();
  return sa.every((value, index) => value === sb[index]);
}

/**
 * Diffa i campi richiesti nel PATCH contro la riga corrente e produce un
 * evento `ticket_events` per OGNI campo effettivamente cambiato. I payload
 * restano piccoli: per title/body si segna solo che è cambiato (mai il testo
 * lungo), per gli altri si tiene { from, to }.
 */
export function diffTicketEvents(current: Ticket, updates: Partial<Ticket>): PendingEvent[] {
  const events: PendingEvent[] = [];
  if (updates.title !== undefined && updates.title !== current.title) {
    events.push({ kind: "title_changed", payload: { changed: true } });
  }
  if (updates.body !== undefined && updates.body !== current.body) {
    events.push({ kind: "body_changed", payload: { changed: true } });
  }
  if (updates.type !== undefined && updates.type !== current.type) {
    events.push({ kind: "type_changed", payload: { from: current.type, to: updates.type } });
  }
  if (updates.priority !== undefined && updates.priority !== current.priority) {
    events.push({
      kind: "priority_changed",
      payload: { from: current.priority, to: updates.priority },
    });
  }
  // NB: la transizione di stato NON passa da `recordTicketStatusChange`
  // (`@stubwise/db`), che è l'helper delle transizioni di SISTEMA (webhook e
  // worker, `actorId: null`). Qui l'evento nasce dentro un diff multi-campo che
  // finisce in UN solo INSERT con l'attore umano: spezzarlo in due scritture
  // per riusare l'helper renderebbe il codice peggiore, non migliore. Il
  // payload è identico — `{ from, to }` — ed è quello su cui la timeline conta.
  if (updates.status !== undefined && updates.status !== current.status) {
    events.push({ kind: "status_changed", payload: { from: current.status, to: updates.status } });
  }
  if (updates.assigneeId !== undefined && updates.assigneeId !== current.assigneeId) {
    events.push({
      kind: "assignee_changed",
      payload: { from: current.assigneeId, to: updates.assigneeId },
    });
  }
  if (updates.labels !== undefined && !sameLabels(updates.labels, current.labels)) {
    events.push({
      kind: "labels_changed",
      payload: { from: current.labels, to: updates.labels },
    });
  }
  if (updates.milestoneId !== undefined && updates.milestoneId !== current.milestoneId) {
    events.push({
      kind: "milestone_changed",
      payload: { from: current.milestoneId, to: updates.milestoneId },
    });
  }
  return events;
}

/**
 * Applica una PATCH a un ticket e registra gli eventi del diff.
 *
 * L'ORDINE DEI CONTROLLI È PARTE DEL CONTRATTO e replica quello della rotta:
 * prima l'assegnatario (un assegnatario inesistente su un ticket inesistente
 * resta `assignee_not_found`, non `ticket_not_found`), poi l'esistenza del
 * ticket, poi la milestone. Una PATCH vuota è una pura lettura: nessun UPDATE,
 * nessun evento, la riga corrente com'è.
 */
export async function patchTicket(
  tx: DbOrTx,
  { ticketId, actorId, patch }: PatchTicketInput,
): Promise<PatchTicketResult> {
  if (typeof patch.assigneeId === "string" && !(await userExists(tx, patch.assigneeId))) {
    return { ok: false, error: "assignee_not_found" };
  }

  const updates: Partial<Ticket> = {};
  if (patch.title !== undefined) updates.title = patch.title;
  if (patch.body !== undefined) updates.body = patch.body;
  if (patch.type !== undefined) updates.type = patch.type;
  if (patch.priority !== undefined) updates.priority = patch.priority;
  if (patch.status !== undefined) updates.status = patch.status;
  if (patch.assigneeId !== undefined) updates.assigneeId = patch.assigneeId;
  if (patch.milestoneId !== undefined) updates.milestoneId = patch.milestoneId;
  if (patch.labels !== undefined) updates.labels = patch.labels;

  const [current] = await tx.select().from(tickets).where(eq(tickets.id, ticketId));
  if (!current) return { ok: false, error: "ticket_not_found" };

  // Una milestone non-null deve esistere ed appartenere allo STESSO progetto
  // del ticket: assegnare ticket a milestone di altri progetti romperebbe
  // l'avanzamento (counts per progetto). Azzerare (null) è sempre lecito.
  if (patch.milestoneId !== undefined && patch.milestoneId !== null) {
    const [ms] = await tx
      .select({ projectId: milestones.projectId })
      .from(milestones)
      .where(eq(milestones.id, patch.milestoneId));
    if (!ms || ms.projectId !== current.projectId) {
      return { ok: false, error: "milestone_cross_project" };
    }
  }

  if (Object.keys(updates).length === 0) return { ok: true, ticket: current, events: [] };

  const events = diffTicketEvents(current, updates);

  const [updated] = await tx.update(tickets).set(updates).where(eq(tickets.id, ticketId)).returning();
  // L'id è già stato verificato dalla SELECT nella stessa transazione: l'update
  // tocca sempre la riga.
  if (events.length > 0) {
    await tx
      .insert(ticketEvents)
      .values(events.map((event) => ({ ...event, ticketId, actorId })));
  }
  return { ok: true, ticket: updated!, events };
}
