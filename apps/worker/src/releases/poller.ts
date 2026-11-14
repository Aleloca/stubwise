import { gitAccounts, releaseCiRuns, releases, repositories, ticketRepositories, tickets, type Db } from "@stubwise/db";
import { getProvider, type CommitRuns, type ProjectGitConfig } from "@stubwise/git";
import { decryptGitCredentials, productionForStatus, publishNotification, releaseProductionOf, type NotificationEvent } from "@stubwise/notifications";
import { releaseStatusOf, sameCommit, type MandatoryReason, type ReleaseStatus } from "@stubwise/shared";
import { and, eq, gte, isNull, lt, ne, sql } from "drizzle-orm";

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
    // A turno (review F1): prima i mai guardati, poi i guardati da più tempo.
    // Con più di BATCH rilasci aperti nessuno resta indietro per sempre.
    .orderBy(sql`${releases.lastPolledAt} asc nulls first`, releases.mergedAt)
    .limit(BATCH);
  for (const row of rows) {
    await deps.db.update(releases).set({ lastPolledAt: now }).where(eq(releases.id, row.release.id));
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
      // L'esito dell'ULTIMA lettura, per il server: illeggibile → «non leggibile».
      await deps.db.update(releases).set({ ciUnreadableAt: runsRead.status === "ok" ? null : now }).where(eq(releases.id, release.id));
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
      await deps.db.update(releases).set({ ciUnreadableAt: now }).where(eq(releases.id, release.id));
    }
  }

  // 2) Il commit in produzione: il server di produzione di QUESTA repository (R-L2).
  const production = await releaseProductionOf(deps.db, release.projectId, release.repositoryId);
  let seenInProductionAt = release.seenInProductionAt;
  if (!seenInProductionAt && production.serverId && production.services.some((s) => sameCommit(s.commitSha, release.mergeSha))) {
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
    production: productionForStatus(production),
  });

  // 4) Gli avvisi del catalogo (area 8, F2): `release.failed` al primo
  //    fallimento, `release.succeeded` alla prima riuscita, una volta sola
  //    ciascuno (il segno lo prende chi avvisa; se la pubblicazione non va a
  //    buon fine si toglie e il rilascio non si sistema: il giro dopo riprova).
  if (status.kind === "failed" && !release.failedNotifiedAt) {
    const failedRun = saved.find((r) => r.status === "failed")?.name ?? null;
    await notifyOnce(deps, release, now, "failed", (url) => ({
      kind: "release.failed",
      projectId: release.projectId,
      releaseId: release.id,
      releaseCode: release.code,
      title: release.title,
      failedRun,
      url,
    }));
  }
  if (status.kind === "succeeded" && !release.succeededNotifiedAt) {
    await notifyOnce(deps, release, now, "succeeded", (url) => ({
      kind: "release.succeeded",
      projectId: release.projectId,
      releaseId: release.id,
      releaseCode: release.code,
      title: release.title,
      url,
    }));
  }

  // 5) Sistemato quando lo stato è concluso.
  if (status.kind === "succeeded" || status.kind === "failed" || status.kind === "in_production") {
    await deps.db.update(releases).set({ runsSettledAt: now }).where(eq(releases.id, release.id));
  }
}

/**
 * I destinatari OBBLIGATORI di un rilascio: chi l'ha mergiato (`merged`, una
 * persona di Stubwise), o — se il merge l'ha fatto un'identità non collegata —
 * l'autore della task della PR (`task_author`). Il catalogo tiene solo i motivi
 * che il tipo prevede (`release.succeeded` non ne ha).
 */
async function releaseMandatory(db: ReleasePollerDeps["db"], release: typeof releases.$inferSelect): Promise<{ userId: string; reason: MandatoryReason }[]> {
  if (release.mergedBy) return [{ userId: release.mergedBy, reason: "merged" }];
  if (release.prNumber === null) return [];
  const [author] = await db
    .select({ userId: tickets.requestedByUserId })
    .from(ticketRepositories)
    .innerJoin(tickets, eq(tickets.id, ticketRepositories.ticketId))
    .where(and(eq(ticketRepositories.repositoryId, release.repositoryId), eq(ticketRepositories.prNumber, release.prNumber), ne(tickets.type, "review")))
    .limit(1);
  return author?.userId ? [{ userId: author.userId, reason: "task_author" }] : [];
}

/** Un avviso del rilascio, una volta sola (`failed_notified_at` / `succeeded_notified_at`). */
async function notifyOnce(
  deps: ReleasePollerDeps,
  release: typeof releases.$inferSelect,
  now: Date,
  which: "failed" | "succeeded",
  eventOf: (url: string) => NotificationEvent,
): Promise<void> {
  const column = which === "failed" ? releases.failedNotifiedAt : releases.succeededNotifiedAt;
  const mark = which === "failed" ? { failedNotifiedAt: now } : { succeededNotifiedAt: now };
  const unmark = which === "failed" ? { failedNotifiedAt: null } : { succeededNotifiedAt: null };
  const [claimed] = await deps.db.update(releases).set(mark).where(and(eq(releases.id, release.id), isNull(column))).returning({ id: releases.id });
  if (!claimed) return;
  const [proj] = await deps.db.execute<{ code: string }>(sql`select code from projects where id = ${release.projectId}`);
  const base = (deps.publicUrl ?? "").replace(/\/+$/, "");
  // Senza radice pubblica il link resta RELATIVO (`/app/#/…`): l'app lo apre lo stesso (94).
  const url = `${base}/app/#/p/${proj?.code ?? ""}/releases/${release.code}`;
  const out = await publishNotification(deps.db, eventOf(url), { projectId: release.projectId, mandatory: await releaseMandatory(deps.db, release) });
  // `publishNotification` non lancia: su un errore risponde `failed`. Si
  // riprova SOLO allora: «nessun destinatario» (tutti l'hanno spento, o un tipo
  // spento di partenza) è un esito, e il segno resta — altrimenti il rilascio
  // non si sistemerebbe mai (review F2, 46).
  if (out.failed === true) {
    await deps.db.update(releases).set(unmark).where(eq(releases.id, release.id));
    throw new Error(`avviso release.${which} non pubblicato: si riprova al giro dopo`);
  }
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
