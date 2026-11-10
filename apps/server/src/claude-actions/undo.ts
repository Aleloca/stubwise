import { backlogItems, claudeActionGroups, claudeActions, comments, taskFilters, ticketEvents, type Db } from "@stubwise/db";
import type { ClaudeActionFn } from "@stubwise/shared";
import { and, asc, desc, eq, gt, inArray, isNull, notInArray, or } from "drizzle-orm";
import type { SessionUser } from "../auth/session.js";
import type { ActionObject } from "./catalog.js";
import type { ActionEffects } from "./effects.js";
import { executeGroup, type ExecuteResult, type PlannedAction } from "./execute.js";

/**
 * «Annulla» di un gruppo eseguito da Claude (chat, fetta 3), le regole del
 * prototipo (`data/claude/actions.ts`):
 * - solo chi l'ha chiesto, una volta;
 * - solo se OGNI azione ha un inverso;
 * - solo se nessuno ha scritto DOPO sugli stessi oggetti (`changed_after`):
 *   una scrittura che non sia del gruppo stesso;
 * - gli inversi girano in ordine inverso, coi permessi di ADESSO, tutti o
 *   nessuno, col segno «via Claude» (e `undo_of_group_id`);
 * - un inverso che avviserebbe altre persone non parte da solo: diventa una
 *   scheda B da confermare (`needs_confirmation`).
 */

export type UndoState =
  | { state: "available"; inverses: PlannedAction[] }
  | { state: "changed_after"; byUserId: string | null }
  | { state: "not_undoable" }
  | { state: "undone" }
  | { state: "not_yours" }
  | { state: "not_found" };

type Group = typeof claudeActionGroups.$inferSelect;

/** La prima scrittura sugli oggetti del gruppo dopo di lui, che non sia sua. `undefined`: nessuna. */
async function laterChangeOf(
  db: Db,
  group: Group,
  actionIds: string[],
  objects: ActionObject[],
): Promise<{ byUserId: string | null } | undefined> {
  // Richieste e filtri: il loro `updated_at` è andato oltre quello scritto
  // dall'azione (`stamp`). Chi l'ha cambiato non si sa: `byUserId` null.
  for (const o of objects) {
    if ((o.kind !== "request" && o.kind !== "filter") || !o.stamp) continue;
    const table = o.kind === "request" ? backlogItems : taskFilters;
    const [row] = await db.select({ at: table.updatedAt }).from(table).where(eq(table.id, o.id));
    if (row && row.at.toISOString() > o.stamp) return { byUserId: null };
  }
  const taskIds = objects.filter((o) => o.kind === "task").map((o) => o.id);
  if (taskIds.length === 0) return undefined;
  const notOurs = (column: typeof ticketEvents.viaClaudeActionId | typeof comments.viaClaudeActionId) =>
    actionIds.length > 0 ? or(isNull(column), notInArray(column, actionIds)) : undefined;
  const [event] = await db
    .select({ by: ticketEvents.actorId })
    .from(ticketEvents)
    .where(
      and(
        inArray(ticketEvents.ticketId, taskIds),
        gt(ticketEvents.createdAt, group.executedAt),
        notOurs(ticketEvents.viaClaudeActionId),
      ),
    )
    .orderBy(asc(ticketEvents.createdAt))
    .limit(1);
  if (event) return { byUserId: event.by };
  const [comment] = await db
    .select({ by: comments.authorId })
    .from(comments)
    .where(
      and(inArray(comments.ticketId, taskIds), gt(comments.createdAt, group.executedAt), notOurs(comments.viaClaudeActionId)),
    )
    .orderBy(asc(comments.createdAt))
    .limit(1);
  return comment ? { byUserId: comment.by } : undefined;
}

/** Lo stato di «Annulla» di un gruppo per chi guarda, coi dati di adesso. */
export async function undoStateOf(db: Db, viewerId: string, groupId: string): Promise<UndoState> {
  const [group] = await db.select().from(claudeActionGroups).where(eq(claudeActionGroups.id, groupId));
  if (!group) return { state: "not_found" };
  if (group.requesterId !== viewerId) return { state: "not_yours" };
  if (group.undoneAt) return { state: "undone" };
  const actions = await db
    .select()
    .from(claudeActions)
    .where(eq(claudeActions.groupId, groupId))
    .orderBy(desc(claudeActions.seq));
  if (actions.length === 0 || actions.some((a) => a.inverse === null)) return { state: "not_undoable" };
  const later = await laterChangeOf(
    db,
    group,
    actions.map((a) => a.id),
    actions.flatMap((a) => a.objects as ActionObject[]),
  );
  if (later) return { state: "changed_after", byUserId: later.byUserId };
  return {
    state: "available",
    inverses: actions.map((a) => ({ fn: a.inverse!.fn as ClaudeActionFn, args: a.inverse!.args })),
  };
}

export type UndoResult =
  | { ok: true; kind: "undone"; groupId: string }
  | { ok: true; kind: "needs_confirmation"; inverses: PlannedAction[]; notified: string[] }
  | { ok: false; error: Exclude<UndoState["state"], "available"> }
  | { ok: false; error: "refused"; failure: Extract<ExecuteResult, { ok: false }>["failure"] };

/**
 * «Annulla»: le regole rilette adesso; gli inversi prima a secco (chi
 * avviserebbero), poi davvero se non avvisano nessuno — altrimenti chi chiama
 * ne fa una scheda (`needs_confirmation`). `confirmed`: la scheda è già stata
 * confermata, si esegue comunque.
 */
export async function undoGroup(
  db: Db,
  user: SessionUser,
  groupId: string,
  opts: { confirmed?: boolean; effects?: ActionEffects } = {},
): Promise<UndoResult> {
  const state = await undoStateOf(db, user.id, groupId);
  if (state.state !== "available") return { ok: false, error: state.state };
  const [group] = await db.select().from(claudeActionGroups).where(eq(claudeActionGroups.id, groupId));
  const sessionId = group!.sessionId;
  if (!sessionId) return { ok: false, error: "not_found" };
  if (!opts.confirmed) {
    const dry = await executeGroup(db, user, { sessionId, actions: state.inverses, undoOfGroupId: groupId, dryRun: true });
    if (!dry.ok) return { ok: false, error: "refused", failure: dry.failure };
    if (dry.notified.length > 0) return { ok: true, kind: "needs_confirmation", inverses: state.inverses, notified: dry.notified };
  }
  // Una volta sola: si RECLAMA la riga prima degli inversi (due «Annulla»
  // insieme: uno solo passa); se gli inversi falliscono, la riga torna libera.
  const claimed = await db
    .update(claudeActionGroups)
    .set({ undoneAt: new Date(), undoneBy: user.id })
    .where(and(eq(claudeActionGroups.id, groupId), isNull(claudeActionGroups.undoneAt)))
    .returning({ id: claudeActionGroups.id });
  if (claimed.length === 0) return { ok: false, error: "undone" };
  const done = await executeGroup(db, user, {
    sessionId,
    actions: state.inverses,
    undoOfGroupId: groupId,
    ...(opts.effects ? { effects: opts.effects } : {}),
  });
  if (!done.ok) {
    await db.update(claudeActionGroups).set({ undoneAt: null, undoneBy: null }).where(eq(claudeActionGroups.id, groupId));
    return { ok: false, error: "refused", failure: done.failure };
  }
  return { ok: true, kind: "undone", groupId: done.groupId };
}
