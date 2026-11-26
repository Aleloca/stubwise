import { releaseStatusOf, type ReleaseStatus } from "@stubwise/shared";
import type { ProjectEnvironment, Release, Repository } from "../../data/model";
import { environmentServerFor } from "./environmentServer";

// Lo stato di un rilascio si DERIVA, non si salva (spec «Lo stato del
// rilascio»). La regola sta in `@stubwise/shared` (`releaseStatusOf`, area 8
// F1), la stessa del server e del worker: qui il prototipo le passa i suoi
// fatti, col server della produzione già scelto per la repository (R-L2).

export {
  MIN_SHA_PREFIX,
  NO_PIPELINE_AFTER_MIN,
  sameCommit,
  type ReleaseStatus,
  type ReleaseStatusKind,
} from "@stubwise/shared";

export function releaseStatus(
  r: Release,
  ctx: {
    now: string;
    production: ProjectEnvironment | null;
    pipeline: Repository["releasePipeline"];
  },
): ReleaseStatus {
  const server = ctx.production ? environmentServerFor(ctx.production, r.repositoryId) : null;
  return releaseStatusOf({
    runs: r.runs,
    mergedAt: r.mergedAt,
    mergeSha: r.mergeSha,
    seenInProductionAt: r.seenInProductionAt,
    now: ctx.now,
    pipeline: ctx.pipeline,
    production: ctx.production
      ? {
          hasServers: ctx.production.servers.length > 0,
          server: server
            ? { reportedSha: server.reportedSha, reportedAt: server.reportedAt }
            : null,
        }
      : null,
  });
}
