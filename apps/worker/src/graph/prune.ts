import { repositories, type Db, type GraphJob } from "@stubwise/db";
import { mirrorSlug } from "@stubwise/shared/mirror-slug";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import type { MirrorManager } from "../git/mirrors.js";

/**
 * Area 9, F6 (D-8): un repository eliminato non lascia il suo codice sul
 * volume. Il job `prune` (accodato dal DELETE nella sua transazione) toglie il
 * grafo (`<graphsDir>/<repositoryId>`) e il mirror, ma il mirror solo se
 * nessun repository vivo usa lo stesso URL: il mirror è per URL, non per
 * repository. Idempotente: rifarlo su cartelle che non ci sono non sbaglia.
 */
export interface GraphPruneDeps {
  db: Db;
  graphsDir: string;
  mirrors: Pick<MirrorManager, "removeMirror">;
}

export async function runGraphPrune(deps: GraphPruneDeps, job: GraphJob): Promise<void> {
  await rm(join(deps.graphsDir, job.repositoryId), { recursive: true, force: true });
  if (!job.repoUrl) return;
  const slug = mirrorSlug(job.repoUrl);
  const live = await deps.db.select({ repoUrl: repositories.repoUrl }).from(repositories);
  if (live.some((r) => mirrorSlug(r.repoUrl) === slug)) return;
  await deps.mirrors.removeMirror(job.repoUrl);
}
