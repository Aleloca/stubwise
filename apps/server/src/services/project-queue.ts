import { automationRuns, automations, projects, type Db } from "@stubwise/db";
import { and, eq, sql } from "drizzle-orm";
import { recordChange } from "./change-log.js";
import { RoleRuleError } from "./roles.js";

/**
 * Area 9, F4: la pausa della coda di un progetto (D-7 = a, J-1 = a). Agisce
 * SOLO sulla coda di Stubwise: le colonne di `projects` che il claim di ogni
 * coda legge (`projectQueueRunnable`). Nessun server, ambiente o processo; il
 * lavoro già partito finisce; niente si cancella.
 */

type Actor = { id: string; email: string };
const queueObject = (p: { id: string; code: string }) => ({ type: "project", id: p.id, label: p.code });

export async function pauseProjectQueue(db: Db, actor: Actor, projectId: string): Promise<void> {
  await db.transaction(async (tx) => {
    const [p] = await tx.select({ id: projects.id, code: projects.code, pausedAt: projects.queuePausedAt }).from(projects).where(eq(projects.id, projectId)).for("update");
    if (!p) throw new RoleRuleError(404, "not_found", "Project not found");
    if (p.pausedAt) throw new RoleRuleError(409, "already_paused", "The queue is already paused");
    await tx.update(projects).set({ queuePausedAt: new Date(), queuePausedByUserId: actor.id }).where(eq(projects.id, projectId));
    await recordChange(tx, { type: "queue.paused", actor, projectId, data: { object: queueObject(p) } });
  });
}

export async function resumeProjectQueue(db: Db, actor: Actor, projectId: string): Promise<void> {
  await db.transaction(async (tx) => {
    const [p] = await tx.select({ id: projects.id, code: projects.code, pausedAt: projects.queuePausedAt }).from(projects).where(eq(projects.id, projectId)).for("update");
    if (!p) throw new RoleRuleError(404, "not_found", "Project not found");
    if (!p.pausedAt) throw new RoleRuleError(409, "not_paused", "The queue is not paused");
    await tx.update(projects).set({ queuePausedAt: null, queuePausedByUserId: null }).where(eq(projects.id, projectId));
    // Valori stabili (encodeQueue del prototipo): «paused:<da quando>» → «running».
    await recordChange(tx, { type: "queue.resumed", actor, projectId, data: { object: queueObject(p), before: `paused:${p.pausedAt.toISOString()}`, after: "running" } });
    // Le esecuzioni delle automazioni del progetto ferme per la PAUSA ripartono
    // subito, nell'ordine (quelle ferme per il budget no: le libera il budget).
    await tx
      .update(automationRuns)
      .set({ dueAt: sql`now()` })
      .where(
        and(
          eq(automationRuns.status, "running"),
          sql`${automationRuns.cursor} -> 'aiWaiting' ->> 'reason' = 'queue_paused'`,
          sql`${automationRuns.automationId} IN (SELECT ${automations.id} FROM ${automations} WHERE ${automations.projectId} = ${projectId})`,
        ),
      );
  });
}
