import {
  environmentServers,
  gitAccounts,
  projectEnvironments,
  releaseCiRuns,
  releases,
  repositories,
  serverMetrics,
  type Db,
} from "@stubwise/db";
import { getProvider, type CommitRuns, type ProjectGitConfig } from "@stubwise/git";
import { decryptGitCredentials, publishNotification } from "@stubwise/notifications";
import { releaseStatusOf, sameCommit, type DiscoveredService, type ReleaseStatus } from "@stubwise/shared";
import { and, desc, eq, gte, inArray, isNull, lt, sql } from "drizzle-orm";

/**
 * LO STATO DI UN RILASCIO DOPO IL MERGE (area 8, F1, S4). Un giro rilegge i
 * rilasci non ancora «sistemati» (`runs_settled_at` null) delle ultime
 * {@link RELEASE_WATCH_HOURS} ore:
 *
 * - le run di CI del commit di merge, col token dell'account git del
 *   repository (S-2 = a), se il repository ha un provider di CI
 *   (`ci_provider`): `getCommitRuns`, filtrate dalla pipeline del repository
 *   (`release_pipeline`) nella regola condivisa, e scritte in
 *   `release_ci_runs`. Una lettura illeggibile non tocca le righe già lette e
 *   NON fa dire «riuscito» (`releaseStatusOf` con `unknown`);
 * - il commit in produzione: l'ultimo campione dell'agente sul server di
 *   produzione della repository (`environment_servers`, R-L2), con
 *   `sameCommit`; la prima volta si scrive `seen_in_production_at` (un fatto
 *   osservato, resta);
 * - lo stato si DERIVA con `releaseStatusOf` (shared), mai salvato. Al primo
 *   `failed`, l'avviso `release.failed` (destinatari: chi ha `release.merge`
 *   nel progetto, routing di oggi; la F2 lo porta nel catalogo), una volta
 *   sola (`failed_notified_at`);
 * - il rilascio si sistema quando lo stato è concluso (riuscito, fallito, in
 *   produzione) o è passata la finestra.
 *
 * Stubwise LEGGE: nessuna pipeline lanciata, nessun deploy (CLAUDE.md, «il
 * merge è il confine»).
 */

export const RELEASE_WATCH_HOURS = 24;
const BATCH = 50;

export interface ReleasePollerDeps {
  db: Db;
  encryptionKey: Buffer;
  publicUrl: string | null;
  now?: () => Date;
  /** Solo nei test: il provider del repository. */
  providerFor?: (kind: "github" | "bitbucket") => { getCommitRuns: (p: ProjectGitConfig, sha: string) => Promise<CommitRuns> };
  log?: (msg: string) => void;
}

/** Un giro; ritorna quanti rilasci ha guardato. Non lancia per un rilascio solo (lo salta col log). */
export async function pollReleasesOnce(deps: ReleasePollerDeps): Promise<number> {
  const now = deps.now?.() ?? new Date();
  const log = deps.log ?? (() => {});
  const rows = await deps.db
    .select({ release: releases, repository: repositories, account: gitAccounts })
    .from(releases)
    .innerJoin(repositories, eq(repositories.id, releases.repositoryId))
    .innerJoin(gitAccounts, eq(gitAccounts.id, repositories.gitAccountId))
    .where(and(isNull(releases.runsSettledAt), gte(releases.mergedAt, new Date(now.getTime() - RELEASE_WATCH_HOURS * 3_600_000))))
    .orderBy(releases.mergedAt)
    .limit(BATCH);
  for (const row of rows) {
    try {
      await pollOne(deps, row, now);
    } catch (err) {
      log(`[releases] ${row.release.code}: giro saltato (${err instanceof Error ? err.message : String(err)})`);
    }
  }
  // Fuori finestra e non sistemati: si sistemano così come sono (lo stato derivato resta quello che le righe dicono).
  await deps.db
    .update(releases)
    .set({ runsSettledAt: now })
    .where(and(isNull(releases.runsSettledAt), lt(releases.mergedAt, new Date(now.getTime() - RELEASE_WATCH_HOURS * 3_600_000))));
  return rows.length;
}

type Row = {
  release: typeof releases.$inferSelect;
  repository: typeof repositories.$inferSelect;
  account: typeof gitAccounts.$inferSelect;
};

async function pollOne(deps: ReleasePollerDeps, row: Row, now: Date): Promise<void> {
  const { release, repository, account } = row;
  // 1) Le run di CI, se il repository ne ha.
  let runsRead: CommitRuns | null = null;
  if (repository.ciProvider) {
    const credentials = decryptGitCredentials(account.encryptedCredentials, deps.encryptionKey);
    if (credentials) {
      const provider = deps.providerFor?.(repository.provider) ?? getProvider(repository.provider);
      runsRead = await provider.getCommitRuns({ repoUrl: repository.repoUrl, defaultBranch: repository.defaultBranch, credentials }, release.mergeSha);
      if (runsRead.status === "ok") {
        for (const r of runsRead.runs) {
          await deps.db
            .insert(releaseCiRuns)
            .values({
              releaseId: release.id,
              providerRunId: r.id,
              name: r.name,
              status: r.status,
              url: r.url,
              failedStep: r.failedStep,
              startedAt: r.startedAt ? new Date(r.startedAt) : null,
              endedAt: r.endedAt ? new Date(r.endedAt) : null,
            })
            .onConflictDoUpdate({
              target: [releaseCiRuns.releaseId, releaseCiRuns.providerRunId],
              set: { name: r.name, status: r.status, url: r.url, failedStep: r.failedStep, endedAt: r.endedAt ? new Date(r.endedAt) : null, updatedAt: now },
            });
        }
      }
    } else {
      runsRead = { status: "unknown" };
    }
  }

  // 2) Il commit in produzione: il server di produzione di QUESTA repository (R-L2).
  const production = await productionOf(deps.db, release.projectId, release.repositoryId);
  let seenInProductionAt = release.seenInProductionAt;
  if (!seenInProductionAt && production.server && production.services.some((s) => sameCommit(s.commitSha, release.mergeSha))) {
    seenInProductionAt = now;
    await deps.db.update(releases).set({ seenInProductionAt: now }).where(and(eq(releases.id, release.id), isNull(releases.seenInProductionAt)));
  }

  // 3) Lo stato derivato, dalle righe salvate (anche quelle di un giro prima) e dalla lettura di adesso.
  const saved = await deps.db.select().from(releaseCiRuns).where(eq(releaseCiRuns.releaseId, release.id));
  const status: ReleaseStatus = releaseStatusOf({
    runs:
      repository.ciProvider === null
        ? []
        : runsRead?.status === "unknown" && saved.length === 0
          ? "unknown"
          : saved.map((r) => ({ name: r.name, status: r.status, startedAt: (r.startedAt ?? r.updatedAt).toISOString(), endedAt: r.endedAt?.toISOString() ?? null })),
    mergedAt: release.mergedAt.toISOString(),
    mergeSha: release.mergeSha,
    seenInProductionAt: seenInProductionAt?.toISOString() ?? null,
    now: now.toISOString(),
    pipeline: repository.ciProvider === null ? null : repository.releasePipeline,
    production: production.environment
      ? { hasServers: production.server !== null, server: production.server ? { reportedSha: production.reportedSha, reportedAt: production.reportedAt } : null }
      : null,
  });

  // 4) L'avviso al primo fallimento, una volta sola.
  if (status.kind === "failed" && !release.failedNotifiedAt) {
    const [claimed] = await deps.db
      .update(releases)
      .set({ failedNotifiedAt: now })
      .where(and(eq(releases.id, release.id), isNull(releases.failedNotifiedAt)))
      .returning({ id: releases.id });
    if (claimed) {
      const failedRun = saved.find((r) => r.status === "failed")?.name ?? null;
      const [proj] = await deps.db.execute<{ code: string }>(sql`select code from projects where id = ${release.projectId}`);
      const base = (deps.publicUrl ?? "").replace(/\/+$/, "");
      await publishNotification(
        deps.db,
        {
          kind: "release.failed",
          projectId: release.projectId,
          releaseId: release.id,
          releaseCode: release.code,
          title: release.title,
          failedRun,
          url: base ? `${base}/app/#/p/${proj?.code ?? ""}/releases/${release.code}` : "",
        },
        { projectId: release.projectId },
      );
    }
  }

  // 5) Sistemato quando lo stato è concluso.
  if (status.kind === "succeeded" || status.kind === "failed" || status.kind === "in_production") {
    await deps.db.update(releases).set({ runsSettledAt: now }).where(eq(releases.id, release.id));
  }
}

/** L'ambiente di produzione del progetto e il server della repository, con l'ultimo campione dell'agente. */
async function productionOf(
  db: Db,
  projectId: string,
  repositoryId: string,
): Promise<{ environment: boolean; server: string | null; services: DiscoveredService[]; reportedSha: string | null; reportedAt: string | null }> {
  const [env] = await db.select({ id: projectEnvironments.id }).from(projectEnvironments).where(and(eq(projectEnvironments.projectId, projectId), eq(projectEnvironments.kind, "production")));
  if (!env) return { environment: false, server: null, services: [], reportedSha: null, reportedAt: null };
  const [link] = await db.select({ serverId: environmentServers.serverId }).from(environmentServers).where(and(eq(environmentServers.environmentId, env.id), eq(environmentServers.repositoryId, repositoryId)));
  if (!link) return { environment: true, server: null, services: [], reportedSha: null, reportedAt: null };
  const [sample] = await db
    .select({ services: serverMetrics.services, ts: serverMetrics.ts })
    .from(serverMetrics)
    .where(inArray(serverMetrics.serverId, [link.serverId]))
    .orderBy(desc(serverMetrics.ts))
    .limit(1);
  const services = (sample?.services ?? []) as DiscoveredService[];
  const reported = services.find((s) => s.commitSha)?.commitSha ?? null;
  return { environment: true, server: link.serverId, services, reportedSha: reported, reportedAt: sample?.ts.toISOString() ?? null };
}

export interface StartReleasePollerOptions extends ReleasePollerDeps {
  intervalSeconds: number;
  signal: AbortSignal;
}

/** Il poller: un giro ogni `intervalSeconds`, mai due insieme; si ferma sul segnale. */
export function startReleasePoller(opts: StartReleasePollerOptions): () => void {
  if (opts.intervalSeconds <= 0) return () => {};
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await pollReleasesOnce(opts);
    } catch (err) {
      console.error(`[stubwise-worker] releases: giro fallito: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => void tick(), opts.intervalSeconds * 1000);
  const stop = () => clearInterval(timer);
  opts.signal.addEventListener("abort", stop, { once: true });
  return stop;
}
