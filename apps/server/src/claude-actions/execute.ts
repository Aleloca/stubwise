import {
  claudeActionGroups,
  claudeActions,
  notifications,
  VIA_CLAUDE_SETTING,
  type Db,
} from "@stubwise/db";
import type { ClaudeActionFailure, ClaudeActionFn, ClaudeClassReason } from "@stubwise/shared";
import { and, eq, inArray, ne, sql } from "drizzle-orm";
import { evaluateProjectAccess } from "../auth/access.js";
import type { SessionUser } from "../auth/session.js";
import { declaredClassOf, parseArgs, SERVER_CATALOG, syntheticRequest, type ActionObject } from "./catalog.js";

/**
 * L'ESECUTORE delle azioni di Claude (chat, fetta 3). È l'unico posto in cui
 * un'azione proposta diventa una scrittura, e sempre a nome della PERSONA:
 *
 * 1. ogni `fn` deve essere nel catalogo del server, con argomenti validi per lo
 *    schema della sua rotta (`invalid` prima di ogni scrittura);
 * 2. i permessi si valutano ADESSO, con lo stesso `RouteAccess` della rotta
 *    (`evaluateProjectAccess` su una richiesta sintetica);
 * 3. ogni azione gira dentro la stessa transazione, col segno «via Claude»
 *    acceso (la variabile di transazione che il DEFAULT delle colonne legge):
 *    l'attore resta la persona;
 * 4. tutto o niente: un rifiuto annulla il gruppo e diventa un fallimento in
 *    forma di dato (codice, quale azione, il permesso per il «Who?»).
 *
 * `dryRun`: la stessa esecuzione, poi ROLLBACK. Serve a calcolare la classe
 * sui dati veri (chi riceverebbe una notifica lo decidono le scritture vere,
 * non una copia delle loro regole) e a rifiutare subito ciò che fallirebbe.
 * Le notifiche passano dall'outbox, che il rollback annulla con il resto.
 */

export interface PlannedAction {
  fn: ClaudeActionFn;
  args: Record<string, unknown>;
}

export interface ExecutedAction {
  id: string;
  fn: ClaudeActionFn;
  args: Record<string, unknown>;
  inverse: { fn: ClaudeActionFn; args: Record<string, unknown> } | null;
  objects: ActionObject[];
  codes: string[];
}

export type ExecuteResult =
  | {
      ok: true;
      groupId: string;
      actions: ExecutedAction[];
      /** Chi ha ricevuto (o, a secco, riceverebbe) una notifica, tranne chi chiede. */
      notified: string[];
    }
  | { ok: false; failure: ClaudeActionFailure };

class Abort extends Error {
  constructor(readonly outcome: ExecuteResult) {
    super("abort");
  }
}

const failure = (
  code: ClaudeActionFailure["code"],
  index: number,
  extra: Partial<ClaudeActionFailure> = {},
): ExecuteResult => ({
  ok: false,
  failure: { code, index, permission: null, projectId: null, message: "", ...extra },
});

export async function executeGroup(
  db: Db,
  user: SessionUser,
  input: {
    sessionId: string;
    actions: readonly PlannedAction[];
    proposalId?: string;
    undoOfGroupId?: string;
    dryRun?: boolean;
  },
): Promise<ExecuteResult> {
  try {
    return await db.transaction(async (tx) => {
      const [group] = await tx
        .insert(claudeActionGroups)
        .values({
          sessionId: input.sessionId,
          requesterId: user.id,
          ...(input.proposalId ? { proposalId: input.proposalId } : {}),
          ...(input.undoOfGroupId ? { undoOfGroupId: input.undoOfGroupId } : {}),
        })
        .returning({ id: claudeActionGroups.id });
      const done: ExecutedAction[] = [];
      for (const [index, planned] of input.actions.entries()) {
        const entry = SERVER_CATALOG.get(planned.fn);
        const args = entry ? parseArgs(planned.fn, planned.args) : null;
        if (!entry || !args) throw new Abort(failure("invalid", index, { message: "not in the catalog or invalid arguments" }));
        const access = await evaluateProjectAccess(
          syntheticRequest(tx as unknown as Db, user, entry.request(args)),
          tx as unknown as Db,
          user,
          entry.access,
        );
        if (!access.ok) {
          throw new Abort(
            failure(access.error, index, access.error === "forbidden" ? { permission: entry.access.permission } : {}),
          );
        }
        const [row] = await tx
          .insert(claudeActions)
          .values({ groupId: group!.id, seq: index, fn: planned.fn, args, cls: declaredClassOf(planned.fn) })
          .returning({ id: claudeActions.id });
        // Il segno di QUESTA azione: le righe scritte da qui in poi lo portano (DEFAULT delle colonne).
        await tx.execute(sql`select set_config(${VIA_CLAUDE_SETTING}, ${row!.id}, true)`);
        const ran = await entry.run(tx as unknown as Db, user, args, access.permissions);
        await tx.execute(sql`select set_config(${VIA_CLAUDE_SETTING}, '', true)`);
        if (!ran.ok) {
          throw new Abort(
            failure(ran.refusal.code, index, {
              projectId: access.projectId,
              message: ran.refusal.message,
              ...(ran.refusal.code === "forbidden" ? { permission: entry.access.permission } : {}),
            }),
          );
        }
        await tx
          .update(claudeActions)
          .set({ inverse: ran.result.inverse, objects: ran.result.objects })
          .where(eq(claudeActions.id, row!.id));
        done.push({ id: row!.id, fn: planned.fn, args, ...ran.result });
      }
      const ids = done.map((a) => a.id);
      const notified =
        ids.length === 0
          ? []
          : (
              await tx
                .selectDistinct({ userId: notifications.userId })
                .from(notifications)
                .where(and(inArray(notifications.viaClaudeActionId, ids), ne(notifications.userId, user.id)))
            ).map((r) => r.userId);
      const outcome: ExecuteResult = { ok: true, groupId: group!.id, actions: done, notified };
      // A secco: lo stesso giro, poi indietro tutto (il gruppo, le scritture, le notifiche).
      if (input.dryRun) throw new Abort(outcome);
      return outcome;
    });
  } catch (error) {
    if (error instanceof Abort) return error.outcome;
    throw error;
  }
}

/**
 * La classe di un gruppo sui dati di ADESSO: quella dichiarata, alzata a B se
 * le scritture avviserebbero altre persone o se un'azione non si annulla. Mai
 * più bassa della dichiarata. La C (riconferma) è la fetta 4: qui non c'è.
 */
export function classOfGroup(
  actions: readonly PlannedAction[],
  dry: Extract<ExecuteResult, { ok: true }>,
): { cls: "A" | "B"; reasons: ClaudeClassReason[] } {
  const reasons: ClaudeClassReason[] = [];
  if (dry.notified.length > 0) reasons.push({ kind: "notifies", personIds: [...dry.notified].sort(), more: false });
  if (dry.actions.some((a) => a.inverse === null)) reasons.push({ kind: "irreversible" });
  const declared = actions.some((a) => declaredClassOf(a.fn) === "B") ? "B" : "A";
  return { cls: declared === "B" || reasons.length > 0 ? "B" : "A", reasons };
}
