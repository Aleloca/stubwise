/**
 * Visibilità dei server di monitoraggio (permessi per progetto, design
 * `docs/plans/2026-10-22-permessi-progetto-design.md`).
 *
 * Un server si LEGGE con `monitor.view`, oppure se è collegato
 * (`server_projects`) a un progetto che l'utente vede. La rotta dichiara
 * `{ kind: "user" }` e filtra qui: non è un solo permesso, quindi l'hook
 * globale non può deciderlo da sé. Le SCRITTURE restano `monitor.manage`.
 */
import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "@stubwise/db";
import { serverProjects } from "@stubwise/db";
import { visibleProjectIds } from "./access.js";
import type { SessionUser } from "./session.js";

/**
 * I server leggibili da `user`: `"all"` con `monitor.view`, altrimenti gli id
 * dei server collegati a un progetto visibile.
 */
export async function visibleServerIds(db: Db, user: SessionUser): Promise<"all" | string[]> {
  if (user.instancePermissions.has("monitor.view")) return "all";
  const projectIds = await visibleProjectIds(db, user);
  if (projectIds === "all") return "all";
  if (projectIds.length === 0) return [];
  const rows = await db
    .selectDistinct({ serverId: serverProjects.serverId })
    .from(serverProjects)
    .where(inArray(serverProjects.projectId, projectIds));
  return rows.map((r) => r.serverId);
}

/** `user` può leggere il server `serverId`? (un server inesistente: no). */
export async function canViewServer(db: Db, user: SessionUser, serverId: string): Promise<boolean> {
  if (user.instancePermissions.has("monitor.view")) return true;
  const projectIds = await visibleProjectIds(db, user);
  if (projectIds === "all") return true;
  if (projectIds.length === 0) return false;
  const [row] = await db
    .select({ id: serverProjects.id })
    .from(serverProjects)
    .where(
      and(eq(serverProjects.serverId, serverId), inArray(serverProjects.projectId, projectIds)),
    )
    .limit(1);
  return row !== undefined;
}
