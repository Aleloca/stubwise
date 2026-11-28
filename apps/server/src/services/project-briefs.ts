import { projectBriefs, type Db } from "@stubwise/db";
import type { ProjectBriefWeekly } from "@stubwise/shared";
import { desc, eq } from "drizzle-orm";

/**
 * LETTURA E RIGENERAZIONE del brief settimanale (Fase 5) — il lato HTTP.
 *
 * A generare i brief è il POLLER del worker (`apps/worker/src/briefs/poller.ts`):
 * qui non gira nessun agente. Quello che il server sa fare è leggerli e
 * rimettere una riga in coda, che è tutto ciò che serve al bottone "Rigenera".
 *
 * ⚠️ ACL: nessuna, come per la timeline. Il permesso lo dichiara la rotta
 * (`config.access`).
 */

/** La proiezione pubblica: `error` NON esce mai (vedi `projectBriefWeeklySchema`). */
export function toPublicBrief(row: typeof projectBriefs.$inferSelect): ProjectBriefWeekly {
  return {
    id: row.id,
    projectId: row.projectId,
    periodStart: row.periodStart,
    periodEnd: row.periodEnd,
    status: row.status,
    summary: row.summary,
    sections: row.sections,
    notificationId: row.notificationId,
    createdAt: row.createdAt.toISOString(),
    finishedAt: row.finishedAt?.toISOString() ?? null,
  };
}

/** I brief di un progetto, dal periodo più recente. */
export async function listProjectBriefs(
  db: Db,
  projectId: string,
  limit: number,
): Promise<ProjectBriefWeekly[]> {
  const rows = await db
    .select()
    .from(projectBriefs)
    .where(eq(projectBriefs.projectId, projectId))
    .orderBy(desc(projectBriefs.periodStart))
    .limit(limit);
  return rows.map(toPublicBrief);
}

/** Un brief per id, o null. Il progetto serve al chiamante per l'ACL. */
export async function getBrief(db: Db, briefId: string): Promise<ProjectBriefWeekly | null> {
  const [row] = await db.select().from(projectBriefs).where(eq(projectBriefs.id, briefId));
  return row ? toPublicBrief(row) : null;
}
