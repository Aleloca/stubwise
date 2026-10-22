import { and, eq, ne, sql } from "drizzle-orm";
import { agentSessionInputs, agentSessions, backlogItems, backlogRefineSessions, type Db } from "@stubwise/db";
import {
  AGENT_SESSION_EVENTS_CHANNEL,
  AGENT_SESSION_INPUT_CHANNEL,
  BACKLOG_REFINE_CLOSED_CHANNEL,
  type RefineCloseReason,
  type RefineSessionView,
} from "@stubwise/shared";
import type { Actor } from "./jobs.js";

/**
 * Sessioni di refinement del backlog, lato server (design 2026-10-14 §3, §5).
 * Il server apre, chiude e riapre la sessione e scrive gli input; il turno lo
 * decide e lo esegue il worker. Chi può: chiunque possa lavorare sul backlog
 * (`backlog.edit` nel progetto, verificato dalla rotta), quindi `actor` serve
 * solo come autore.
 *
 * ORDINE DEI LOCK, in OGNI funzione qui: prima la riga di `backlog_items`, poi
 * quella di `backlog_refine_sessions`. È lo stesso del ponte del worker
 * (`apps/worker/src/backlog/refine/bridge.ts`) e dei percorsi che chiudono la
 * voce (conversione, archiviazione, fusione: aggiornano la voce, poi chiamano
 * `closeRefineSessionForItem` nella STESSA transazione). L'ordine inverso in
 * un punto solo basta per un deadlock con gli altri.
 */
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
type DbOrTx = Db | Tx;

const isClosedItem = (status: string) => status === "converted" || status === "archived";

async function notify(tx: DbOrTx, channel: string, payload: Record<string, string>): Promise<void> {
  await tx.execute(sql`select pg_notify(${channel}, ${JSON.stringify(payload)})`);
}

/**
 * `new → refining` al PRIMO MESSAGGIO di una sessione di refinement (decisione
 * 6, docs/plans/2026-10-19-backlog-solo-sessioni.md): dismessa la chat della
 * voce, è l'unico passaggio automatico a `refining`. Solo da `new`: una voce
 * `ready` (o già `refining`) resta com'è. Il chiamante ha GIÀ la voce in lock
 * (`FOR UPDATE`), quindi lo stato letto è quello vero.
 */
async function promoteNewItem(tx: DbOrTx, itemId: string, status: string): Promise<void> {
  if (status !== "new") return;
  await tx.update(backlogItems).set({ status: "refining" }).where(eq(backlogItems.id, itemId));
}

export async function startRefineSession(
  db: Db,
  actor: Actor,
  itemId: string,
  message?: string,
): Promise<
  { ok: true; agentSessionId: string; inputId: string | null } | { ok: false; error: "not_found" | "item_closed" }
> {
  return db.transaction(async (tx) => {
    const [item] = await tx
      .select({
        id: backlogItems.id,
        projectId: backlogItems.projectId,
        title: backlogItems.title,
        status: backlogItems.status,
      })
      .from(backlogItems)
      .where(eq(backlogItems.id, itemId))
      .for("update");
    if (!item) return { ok: false as const, error: "not_found" as const };
    if (isClosedItem(item.status)) return { ok: false as const, error: "item_closed" as const };
    // Una sola sessione per voce, per sempre: `owner_key` unico, quindi un
    // secondo avvio (anche dopo «Chiudi») riprende la STESSA sessione.
    const [session] = await tx
      .insert(agentSessions)
      .values({
        ownerKey: `backlog_refine:${itemId}`,
        kind: "backlog_refine",
        title: item.title,
        projectId: item.projectId,
        backlogItemId: itemId,
      })
      .onConflictDoUpdate({ target: agentSessions.ownerKey, set: { title: item.title } })
      .returning({ id: agentSessions.id });
    const agentSessionId = session!.id;
    await tx
      .insert(backlogRefineSessions)
      .values({ itemId, agentSessionId, startedByUserId: actor.id })
      .onConflictDoUpdate({
        target: backlogRefineSessions.itemId,
        set: { agentSessionId, status: "active", closedAt: null, closedReason: null, lastActivityAt: sql`now()` },
      });
    let inputId: string | null = null;
    if (message !== undefined) {
      // Il primo messaggio porta una voce `new` in `refining` (decisione 6 del
      // 19 ott 2026): con la voce già in lock, prima della sessione.
      await promoteNewItem(tx, itemId, item.status);
      const [input] = await tx
        .insert(agentSessionInputs)
        .values({ sessionId: agentSessionId, authorUserId: actor.id, text: message })
        .returning({ id: agentSessionInputs.id });
      inputId = input!.id;
      await notify(tx, AGENT_SESSION_INPUT_CHANNEL, { sessionId: agentSessionId });
    }
    await notify(tx, AGENT_SESSION_EVENTS_CHANNEL, { sessionId: agentSessionId });
    return { ok: true as const, agentSessionId, inputId };
  });
}

/**
 * Chiude la sessione ATTIVA della voce (se c'è) e avvisa il worker. Nella
 * transazione del chiamante, che ha GIÀ in lock la voce: l'UPDATE qui prende il
 * lock della sessione, quella che il ponte del worker legge `FOR UPDATE`.
 */
async function closeActive(tx: DbOrTx, itemId: string, reason: RefineCloseReason): Promise<void> {
  const [closed] = await tx
    .update(backlogRefineSessions)
    .set({ status: "closed", closedReason: reason, closedAt: sql`now()` })
    .where(and(eq(backlogRefineSessions.itemId, itemId), eq(backlogRefineSessions.status, "active")))
    .returning({ agentSessionId: backlogRefineSessions.agentSessionId });
  if (!closed) return;
  await tx
    .update(agentSessionInputs)
    .set({ status: "undelivered", reason: "session_not_live", deliveredAt: null })
    .where(and(eq(agentSessionInputs.sessionId, closed.agentSessionId), eq(agentSessionInputs.status, "pending")));
  // Al commit: il worker annulla il turno, revoca i segreti, smonta i worktree.
  await notify(tx, BACKLOG_REFINE_CLOSED_CHANNEL, { agentSessionId: closed.agentSessionId });
  await notify(tx, AGENT_SESSION_EVENTS_CHANNEL, { sessionId: closed.agentSessionId });
}

/** «Chiudi»: idempotente — ok anche senza sessione o con la sessione già chiusa. */
export async function closeRefineSession(
  db: Db,
  _actor: Actor,
  itemId: string,
): Promise<{ ok: true } | { ok: false; error: "not_found" }> {
  return db.transaction(async (tx) => {
    // Lock della voce PRIMA della sessione (ordine dei lock, vedi in testa).
    const [item] = await tx
      .select({ id: backlogItems.id })
      .from(backlogItems)
      .where(eq(backlogItems.id, itemId))
      .for("update");
    if (!item) return { ok: false as const, error: "not_found" as const };
    await closeActive(tx, itemId, "user");
    return { ok: true as const };
  });
}

/**
 * Voce convertita, archiviata o assorbita: nella transazione di chi la chiude,
 * DOPO l'UPDATE della voce (che ne tiene il lock). Una sessione attiva si
 * chiude come sempre; una GIÀ chiusa (dall'utente o per inattività) cambia
 * solo motivo, `item_closed`, perché il motivo dice che non si riprende più.
 * Lì nessuna NOTIFY al worker: non c'è un turno da annullare. `closed_at`
 * resta la chiusura vera.
 */
export async function closeRefineSessionForItem(tx: DbOrTx, itemId: string): Promise<void> {
  await closeActive(tx, itemId, "item_closed");
  await tx
    .update(backlogRefineSessions)
    .set({ closedReason: "item_closed" })
    .where(
      and(
        eq(backlogRefineSessions.itemId, itemId),
        eq(backlogRefineSessions.status, "closed"),
        ne(backlogRefineSessions.closedReason, "item_closed"),
      ),
    );
}

/**
 * Nella transazione dell'input (Task 12): riapre la sessione se era chiusa e
 * tocca SEMPRE `last_activity_at` (lo sweep non chiude una sessione a cui si è
 * appena scritto). Mai su una voce chiusa. Con `withMessage` (un input con
 * testo, non un «Ferma» vuoto) porta anche una voce `new` in `refining`
 * ({@link promoteNewItem}), col lock della voce che questa funzione prende già.
 */
export async function reopenRefineSessionIfClosed(
  tx: DbOrTx,
  agentSessionId: string,
  opts: { withMessage?: boolean } = {},
): Promise<"active" | "item_closed" | "not_refine"> {
  const [ref] = await tx
    .select({ itemId: backlogRefineSessions.itemId })
    .from(backlogRefineSessions)
    .where(eq(backlogRefineSessions.agentSessionId, agentSessionId));
  if (!ref) return "not_refine";
  // Ordine dei lock: la voce, poi la sessione. Con la voce in lock una
  // conversione concorrente o è già committata (e qui la vediamo) o aspetta.
  const [item] = await tx
    .select({ status: backlogItems.status })
    .from(backlogItems)
    .where(eq(backlogItems.id, ref.itemId))
    .for("update");
  // La voce sparita si porta via la sessione (cascade): non c'è più niente.
  if (!item) return "not_refine";
  if (isClosedItem(item.status)) return "item_closed";
  const reopened = await tx
    .update(backlogRefineSessions)
    .set({ status: "active", closedAt: null, closedReason: null, lastActivityAt: sql`now()` })
    .where(eq(backlogRefineSessions.agentSessionId, agentSessionId))
    .returning({ id: backlogRefineSessions.id });
  if (reopened.length === 0) return "not_refine";
  if (opts.withMessage === true) await promoteNewItem(tx, ref.itemId, item.status);
  return "active";
}

export async function loadRefineSessionView(db: DbOrTx, itemId: string): Promise<RefineSessionView | null> {
  const [row] = await db.select().from(backlogRefineSessions).where(eq(backlogRefineSessions.itemId, itemId));
  if (!row) return null;
  return {
    agentSessionId: row.agentSessionId,
    status: row.status,
    closedReason: row.closedReason ?? null,
    lastActivityAt: row.lastActivityAt.toISOString(),
  };
}
