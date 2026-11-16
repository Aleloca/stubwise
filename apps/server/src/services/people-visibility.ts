import { projectMembers, type Db } from "@stubwise/db";
import { userIdsWithPermission } from "@stubwise/notifications";
import { inArray } from "drizzle-orm";
import { visibleProjectIds } from "../auth/access.js";
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
  if (visible === "all") return "all";
  const rows =
    visible.length > 0
      ? await db.selectDistinct({ userId: projectMembers.userId }).from(projectMembers).where(inArray(projectMembers.projectId, visible))
      : [];
  const admins = visible.length > 0 ? await userIdsWithPermission(db, null, null) : [];
  return [...new Set([viewer.id, ...rows.map((r) => r.userId), ...admins])];
}

export async function canSeePerson(db: Db, viewer: Pick<SessionUser, "id" | "instancePermissions">, personId: string): Promise<boolean> {
  const ids = await visiblePersonIds(db, viewer);
  return ids === "all" || ids.includes(personId);
}
