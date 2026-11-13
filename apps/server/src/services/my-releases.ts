import { projects, releaseCiRuns, releases, type Db } from "@stubwise/db";
import type { MyReleases, ReleaseRow } from "@stubwise/shared";
import { and, eq, inArray } from "drizzle-orm";
import { projectIdsWithPermission } from "../auth/access.js";
import type { SessionUser } from "../auth/session.js";
import { listOpenPulls } from "./pulls.js";
import { listProjectReleases } from "./releases.js";

type Viewer = Pick<SessionUser, "id" | "instancePermissions">;

/** I progetti in cui chi guarda ha `release.merge` (tutti per un full admin). */
async function mergeProjects(db: Db, viewer: Viewer): Promise<string[]> {
  const ids = await projectIdsWithPermission(db, viewer, "release.merge");
  if (ids !== "all") return ids;
  return (await db.select({ id: projects.id }).from(projects)).map((p) => p.id);
}

/** Chi vede il blocco «Rilasci» della Home: `release.merge` in qualche progetto. */
export async function seesReleasesBlock(db: Db, viewer: Viewer): Promise<boolean> {
  const ids = await projectIdsWithPermission(db, viewer, "release.merge");
  return ids === "all" || ids.length > 0;
}

/**
 * `GET /api/me/releases` (area 8, F1, S10). Le stesse letture delle pagine
 * dei rilasci e delle PR (`listProjectReleases`, `listOpenPulls`): lo stato si
 * deriva lì, mai qui. Solo i progetti con un rilascio che ha una run fallita
 * passano dal calcolo dello stato (gli altri non possono essere «falliti»).
 */
export async function myReleases(db: Db, encryptionKey: Buffer, viewer: Viewer): Promise<MyReleases> {
  const ids = await mergeProjects(db, viewer);
  if (ids.length === 0) return { failed: [], ready: [] };
  const withFailedRun = await db
    .selectDistinct({ projectId: releases.projectId })
    .from(releases)
    .innerJoin(releaseCiRuns, eq(releaseCiRuns.releaseId, releases.id))
    .where(and(inArray(releases.projectId, ids), eq(releaseCiRuns.status, "failed")));
  const failed: ReleaseRow[] = [];
  for (const { projectId } of withFailedRun) {
    for (const row of await listProjectReleases(db, viewer, projectId)) {
      if (row.status.kind !== "failed") continue;
      if (row.fixTask && row.fixTask.open === false) continue;
      failed.push(row);
    }
  }
  failed.sort((a, b) => (a.mergedAt < b.mergedAt ? 1 : a.mergedAt > b.mergedAt ? -1 : 0));
  const ready = [];
  for (const projectId of ids) {
    for (const pull of await listOpenPulls(db, encryptionKey, viewer, projectId)) if (pull.ready) ready.push(pull);
  }
  return { failed, ready };
}
