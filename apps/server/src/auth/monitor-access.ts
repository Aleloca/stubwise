/**
 * Visibilità dei server di monitoraggio (area 8, F4a: dagli AMBIENTI).
 *
 * Un server si LEGGE con `monitor.view` (o `monitor.manage`, che lo
 * implica), oppure se un ambiente di un progetto che l'utente vede lo usa
 * (`environment_servers`, per repository). `server_projects` NON conta più
 * (F4a-4 = b del maintainer): un server collegato solo dal web è invisibile a
 * chi non ha `monitor.view`. La rotta dichiara `{ kind: "user" }` e filtra
 * qui: non è un solo permesso. Le SCRITTURE restano `monitor.manage`. UN
 * posto: elenco, dettaglio, controlli e metriche passano tutti da qui.
 */
import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "@stubwise/db";
import { environmentServers, projectEnvironments } from "@stubwise/db";
import { isAllProjects, visibleProjectIds } from "./access.js";
import type { SessionUser } from "./session.js";

const seesAll = (user: SessionUser) => user.instancePermissions.has("monitor.view") || user.instancePermissions.has("monitor.manage");

/** Gli id dei server usati dagli ambienti dei progetti dati. */
export async function serverIdsOfProjects(db: Db, projectIds: readonly string[]): Promise<string[]> {
  if (projectIds.length === 0) return [];
  const rows = await db
    .selectDistinct({ serverId: environmentServers.serverId })
    .from(environmentServers)
    .innerJoin(projectEnvironments, eq(projectEnvironments.id, environmentServers.environmentId))
    .where(inArray(projectEnvironments.projectId, [...projectIds]));
  return rows.map((r) => r.serverId);
}

/**
 * I server leggibili da `user`: `"all"` con `monitor.view`/`monitor.manage`,
 * altrimenti gli id dei server degli ambienti dei progetti visibili.
 */
export async function visibleServerIds(db: Db, user: SessionUser): Promise<"all" | string[]> {
  if (seesAll(user)) return "all";
  const projectIds = await visibleProjectIds(db, user);
  // Un full admin vede i server di tutti (`seesAll` lo copre già prima).
  if (isAllProjects(projectIds)) return "all";
  return serverIdsOfProjects(db, projectIds);
}

/** `user` può leggere il server `serverId`? (un server inesistente: no). */
export async function canViewServer(db: Db, user: SessionUser, serverId: string): Promise<boolean> {
  if (seesAll(user)) return true;
  const projectIds = await visibleProjectIds(db, user);
  if (isAllProjects(projectIds)) return true;
  if (projectIds.length === 0) return false;
  const [row] = await db
    .select({ serverId: environmentServers.serverId })
    .from(environmentServers)
    .innerJoin(projectEnvironments, eq(projectEnvironments.id, environmentServers.environmentId))
    .where(and(eq(environmentServers.serverId, serverId), inArray(projectEnvironments.projectId, [...projectIds])))
    .limit(1);
  return row !== undefined;
}
