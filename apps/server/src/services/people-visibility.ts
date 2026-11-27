import { projectAccess, projectAccessRowCounts, type Db } from "@stubwise/db";
import { userIdsWithPermission } from "@stubwise/notifications";
import { and, inArray } from "drizzle-orm";
import { isAllProjects, visibleProjectIds } from "../auth/access.js";
import type { SessionUser } from "../auth/session.js";

/**
 * Le persone che `viewer` vede: tutte per un full admin; altrimenti sé stesso,
 * i membri dei progetti che vede e i full admin (membri impliciti di ogni
 * progetto, la regola di `projectViewerIds`). È la regola di `GET /api/people`,
 * in UN posto: la usano anche la foto del profilo (area 9, F1) e chi ne avrà
 * bisogno, mai una copia.
 */
export async function visiblePersonIds(db: Db, viewer: Pick<SessionUser, "id" | "instancePermissions">): Promise<"all" | string[]> {
  const visible = await visibleProjectIds(db, viewer);
  // Un full admin vede tutte le persone: l'archivio di un progetto non toglie nessuno.
  if (isAllProjects(visible)) return "all";
  const rows =
    visible.length > 0
      ? // Membri espliciti e persone di workspace dei progetti visti (0238).
        await db.selectDistinct({ userId: projectAccess.userId }).from(projectAccess).where(and(inArray(projectAccess.projectId, visible), projectAccessRowCounts))
      : [];
  const admins = visible.length > 0 ? await userIdsWithPermission(db, null, null) : [];
  return [...new Set([viewer.id, ...rows.map((r) => r.userId), ...admins])];
}

export async function canSeePerson(db: Db, viewer: Pick<SessionUser, "id" | "instancePermissions">, personId: string): Promise<boolean> {
  const ids = await visiblePersonIds(db, viewer);
  return ids === "all" || ids.includes(personId);
}
