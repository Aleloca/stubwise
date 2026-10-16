import { activityReports, commitSummaries, decrypt, docGenerations, gitAccounts, nightlyItems, projects, repositories } from "@stubwise/db";
import type { ReleaseNotes } from "@stubwise/docs-engine";
import { publishDocsNightlyAttention } from "@stubwise/notifications";
import { and, asc, eq, inArray, or, sql } from "drizzle-orm";
import { z } from "zod";
import type { CommitWithFiles, MirrorProject } from "../git/mirrors.js";
import { isQuotaWait, type EmptyReason } from "../providers/select.js";
import { previousUtcDay } from "../reports/daily-report-poller.js";
import { nightOf, romeMinutes, startMinutes } from "./clock.js";
import { summarizeCommit } from "./commit-summary.js";
import { advanceBookmarkIfDone, runPageUpdateItem } from "./page-update.js";
import { runPageCreateItem } from "./page-create.js";
import { isPlanSkip, planDocs, planPages, type DocsPlan } from "./plan.js";
import {
  claimNext,
  completeItem,
  enqueueItems,
  failItem,
  NIGHTLY_ITEM_LEASE_MS,
  pendingCount,
  releaseItem,
  type NewNightlyItem,
  type NightlyItem,
  type NightlyPhase,
} from "./queue.js";
import { enqueueReleaseItem, runReleaseItem } from "./release.js";
import { nightNeedsResume, type NightlyDeps, type NightlyRepo, type NightResult } from "./types.js";

/**
 * Il giro notturno (Piano B, Task B9): orchestratore e orario.
 *
 * Una notte (design 2026-10-15 §3). Per i repository dei progetti con almeno
 * uno dei due interruttori accesi (daily report, Docs notturni):
 *  0. i `daily_report` della notte: un elemento per progetto col report acceso
 *     (sul suo primo repository per `created_at`, chiave = giorno UTC appena
 *     chiuso), consumati TUTTI SUBITO con UNA insert di righe `activity_reports`
 *     `queued` (D7). Tutte insieme e non a turno: il rollup per sviluppatore
 *     scatta su un giorno appena tutte le sue righe sono `done`, e una riga
 *     arrivata dopo resterebbe fuori. Il report lo scrive il poller del daily
 *     report (unico consumatore), che riassume da sé i commit che il giro non
 *     ha ancora riassunto. Un report già presente non si tocca.
 *  1. pianifica (enqueue idempotente) DENTRO `serializer.run(projectId)`:
 *     `ensureMirror` (l'unico fetch), elementi `summary` per i commit recenti
 *     senza riassunto; coi Docs notturni `planDocs`, i `summary` dei commit
 *     del piano fuori finestra (D24) e l'elemento `release`.
 *  2. consuma la coda A TURNO: un elemento per repository per giro, così un
 *     repository con molti commit non si prende tutto il margine. Dentro un
 *     repository l'ordine è summary → release (poi `planPages`) →
 *     page_update/page_create → segnalibro.
 *  3. Esiti: `unavailable` di quota (`isQuotaWait`, R1: anche il limite
 *     dell'auth del container) ferma TUTTO il giro (gli abbonamenti sono
 *     condivisi), salvo che il progetto sia «solo questo» (R3): allora salta
 *     solo quel progetto (`provider_quota`), ripreso con lo stesso ritmo. Un
 *     motivo di configurazione salta il progetto per la notte
 *     (`provider_config`). In entrambi i casi l'elemento torna libero senza
 *     contare un fallimento. `failed` → `failItem`; all'escalation una card.
 *
 * Ogni repository è isolato: un repository irraggiungibile (credenziali,
 * mirror) si salta (`unreachable`) con una riga di log, gli altri proseguono.
 * Serializer per-progetto per fetch, elenchi e worktree (D6); i run `claude`
 * stanno fuori. Un repository con una generazione completa `running`/`paused`
 * salta le fasi Docs (`generation_running`) e il fetch (il worktree della
 * generazione è su un branch `stubwise/*`), non i riassunti.
 *
 * Nessuno stato del giro vive solo in memoria, salvo i worktree e il flag «un
 * giro alla volta»: la coda è in tabella, un elemento reclamato da un processo
 * morto torna disponibile alla scadenza della lease, e un elemento già fallito
 * stanotte non si riprova nella stessa notte (`claimNext` con `notFailedOn`).
 */

/** Ritmo della ripresa dopo uno stop per quota (o un progetto «solo questo» al limite). */
export const NIGHTLY_RESUME_MS = 15 * 60_000;

/** Lunghezza massima di `lastError` nella card di escalation. */
const MAX_CARD_ERROR_CHARS = 500;

const DAY_MS = 24 * 60 * 60_000;

/** Giorni UTC (ieri compreso) per cui un `daily_report` mancante si recupera. */
export const DAILY_REPORT_CATCHUP_DAYS = 3;

/** Forma attesa delle credenziali git decifrate (come negli altri poller). */
const credentialsSchema = z.object({
  username: z.string().min(1).optional(),
  email: z.string().min(1).optional(),
  token: z.string().min(1),
});

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Un repository del giro, con ciò che serve all'orchestratore oltre a `NightlyRepo`. */
interface LoadedRepo {
  repo: NightlyRepo | null;
  repositoryId: string;
  repositoryName: string;
  projectId: string;
  dailyReport: boolean;
  /** «Solo questo» con un id valorizzato (R3). */
  exclusive: boolean;
}

async function loadRepos(deps: NightlyDeps, repositoryId: string | undefined): Promise<LoadedRepo[]> {
  const rows = await deps.db
    .select({
      repositoryId: repositories.id,
      repositoryName: repositories.name,
      provider: repositories.provider,
      repoUrl: repositories.repoUrl,
      defaultBranch: repositories.defaultBranch,
      currentGenerationId: repositories.currentDocGenerationId,
      projectId: projects.id,
      projectName: projects.name,
      dailyReport: projects.dailyReportEnabled,
      docsNightly: projects.docAutoUpdate,
      exclusive: sql<boolean>`(${projects.aiProviderExclusive} AND ${projects.aiProviderId} IS NOT NULL)`,
      encryptedCredentials: gitAccounts.encryptedCredentials,
    })
    .from(repositories)
    .innerJoin(projects, eq(repositories.projectId, projects.id))
    .innerJoin(gitAccounts, eq(repositories.gitAccountId, gitAccounts.id))
    .where(
      and(
        or(eq(projects.dailyReportEnabled, true), eq(projects.docAutoUpdate, true)),
        repositoryId === undefined ? undefined : eq(repositories.id, repositoryId),
      ),
    )
    .orderBy(asc(repositories.createdAt), asc(repositories.id));

  return rows.map((r) => {
    const base = {
      repositoryId: r.repositoryId,
      repositoryName: r.repositoryName,
      projectId: r.projectId,
      dailyReport: r.dailyReport,
      exclusive: r.exclusive === true,
    };
    let credentials: z.infer<typeof credentialsSchema>;
    try {
      credentials = credentialsSchema.parse(JSON.parse(decrypt(r.encryptedCredentials, deps.select.encryptionKey)));
    } catch {
      return { ...base, repo: null };
    }
    const project: MirrorProject = {
      provider: r.provider,
      repoUrl: r.repoUrl,
      defaultBranch: r.defaultBranch,
      credentials,
    };
    return {
      ...base,
      repo: {
        repositoryId: r.repositoryId,
        repositoryName: r.repositoryName,
        projectId: r.projectId,
        projectName: r.projectName,
        project,
        dailyReport: r.dailyReport,
        docsNightly: r.docsNightly,
        currentGenerationId: r.currentGenerationId,
      },
    };
  });
}

/**
 * Fase 0 (D7): accoda e consuma SUBITO i `daily_report` della notte. Un
 * elemento per progetto col report acceso, sul suo primo repository; le righe
 * `activity_reports` `queued` nascono tutte con UNA insert (`ON CONFLICT DO
 * NOTHING`: un report già presente, manuale o generato, non si tocca). I
 * progetti SENZA repository li accoda il poller del daily report.
 */
async function queueDailyReports(deps: NightlyDeps, loaded: LoadedRepo[], now: Date, night: string): Promise<number> {
  const firstRepoOf = new Map<string, LoadedRepo>();
  for (const l of loaded) if (l.dailyReport && !firstRepoOf.has(l.projectId)) firstRepoOf.set(l.projectId, l);
  if (firstRepoOf.size === 0) return 0;
  const { date } = previousUtcDay(now);
  // Recupero: i giorni UTC prima di ieri (fino a DAILY_REPORT_CATCHUP_DAYS in
  // tutto) il cui elemento `daily_report` MANCA — una notte saltata (worker giù
  // all'orario, crash loop). Conta l'elemento, non la riga `activity_reports`:
  // un report presente o cancellato a mano non si rigenera mai da solo. E solo
  // per un repository che era già nel giro prima di quel giorno (ha un elemento
  // più vecchio): un progetto appena acceso, o il primo giro dopo il rilascio,
  // non si ritrova report di giorni passati.
  const pastDates = Array.from({ length: DAILY_REPORT_CATCHUP_DAYS - 1 }, (_, i) =>
    new Date(Date.parse(`${date}T00:00:00Z`) - (i + 1) * DAY_MS).toISOString().slice(0, 10),
  );
  const repoIds = [...firstRepoOf.values()].map((l) => l.repositoryId);
  const oldest = await deps.db
    .select({ repositoryId: nightlyItems.repositoryId, key: sql<string>`min(${nightlyItems.key})` })
    .from(nightlyItems)
    .where(and(inArray(nightlyItems.repositoryId, repoIds), eq(nightlyItems.phase, "daily_report")))
    .groupBy(nightlyItems.repositoryId);
  const oldestOf = new Map(oldest.map((o) => [o.repositoryId, o.key]));
  const items: NewNightlyItem[] = [];
  for (const l of firstRepoOf.values()) {
    const first = oldestOf.get(l.repositoryId);
    const keys = [date, ...pastDates.filter((d) => first !== undefined && first < d)];
    for (const key of keys) items.push({ repositoryId: l.repositoryId, projectId: l.projectId, phase: "daily_report", key });
  }
  await enqueueItems(deps.db, items, night);

  // Consuma TUTTI i pendenti (anche di notti prima) dei repository del giro.
  const claimed: NightlyItem[] = [];
  for (const l of firstRepoOf.values()) {
    for (;;) {
      const item = await claimNext(deps.db, l.repositoryId, "daily_report");
      if (!item) break;
      claimed.push(item);
    }
  }
  if (claimed.length === 0) return 0;
  try {
    const values = new Map<string, { projectId: string; date: string; status: "queued" }>();
    for (const i of claimed) values.set(`${i.projectId}|${i.key}`, { projectId: i.projectId, date: i.key, status: "queued" });
    await deps.db
      .insert(activityReports)
      .values([...values.values()])
      .onConflictDoNothing({ target: [activityReports.projectId, activityReports.date] });
  } catch (err) {
    deps.log(`[stubwise-worker] notte: report giornalieri non accodati (${errText(err)})`);
    for (const i of claimed) await releaseItem(deps.db, i.id);
    return 0;
  }
  for (const i of claimed) await completeItem(deps.db, i.id);
  return claimed.length;
}

/** Elementi `summary` per gli sha senza riassunto, col commit (e i suoi file) nel payload. */
async function enqueueSummaries(
  deps: NightlyDeps,
  repo: NightlyRepo,
  commits: CommitWithFiles[],
  night: string,
): Promise<number> {
  if (commits.length === 0) return 0;
  const existing = await deps.db
    .select({ sha: commitSummaries.sha })
    .from(commitSummaries)
    .where(
      and(
        eq(commitSummaries.repositoryId, repo.repositoryId),
        inArray(
          commitSummaries.sha,
          commits.map((c) => c.sha),
        ),
      ),
    );
  const have = new Set(existing.map((e) => e.sha));
  const todo = commits.filter((c) => !have.has(c.sha));
  return enqueueItems(
    deps.db,
    todo.map((c) => ({
      repositoryId: repo.repositoryId,
      projectId: repo.projectId,
      phase: "summary" as const,
      key: c.sha,
      payload: { commit: c },
    })),
    night,
  );
}

/** `last_error` del `summary` di un commit che il mirror non sa più leggere. */
export const COMMIT_UNREADABLE = "commit_unreadable";

/**
 * Il commit di uno sha fuori finestra, letto dal mirror (DENTRO il serializer,
 * `skipFetch`). Uno sha non leggibile (sparito dopo un force-push e un gc) NON
 * resta senza elemento: nasce un `summary` già `escalated` (`commit_unreadable`),
 * così la nota lo esclude come un riassunto in escalation e il segnalibro non
 * lo aspetta, invece di fermare nota e Docs ogni notte.
 */
async function commitsBySha(
  deps: NightlyDeps,
  repo: NightlyRepo,
  shas: string[],
  night: string,
): Promise<CommitWithFiles[]> {
  const out: CommitWithFiles[] = [];
  for (const sha of shas) {
    try {
      out.push(await deps.mirrors.getCommitWithFiles(repo.project, sha, { skipFetch: true }));
    } catch (err) {
      deps.log(
        `[stubwise-worker] notte: commit ${sha.slice(0, 7)} di ${repo.repositoryName} non leggibile (${errText(err)}): escluso da nota e Docs`,
      );
      await deps.db
        .insert(nightlyItems)
        .values({
          repositoryId: repo.repositoryId,
          projectId: repo.projectId,
          phase: "summary",
          key: sha,
          status: "escalated",
          lastError: COMMIT_UNREADABLE,
          payload: {},
          night,
        })
        .onConflictDoNothing();
    }
  }
  return out;
}

/** Lo stato in memoria di un repository durante il giro. */
interface RepoRun {
  repo: NightlyRepo;
  exclusive: boolean;
  stage: "summary" | "release" | "pages" | "done";
  /** Il piano dei Docs della notte; null = niente fasi Docs. */
  plan: DocsPlan | null;
  notes: ReleaseNotes[];
  /** Note che hanno già aspettato i riassunti in questo giro (una seconda attesa ferma i Docs). */
  releaseWaits: Set<string>;
  pagesReady: boolean;
  worktree: { dir: string; remove: () => Promise<void> } | null;
}

/** Come finisce un passo di un repository. */
type StepResult =
  | "progress"
  | "idle"
  | { stop: "quota" }
  | { skipProject: "provider_config" | "provider_quota" };

function readCommit(payload: Record<string, unknown>): CommitWithFiles | null {
  const c = payload.commit as Partial<CommitWithFiles> | undefined;
  if (!c || typeof c.sha !== "string" || !Array.isArray(c.files)) return null;
  return c as CommitWithFiles;
}

/**
 * Esegue una notte. `opts.repositoryId`: un giro su un solo repository (lo
 * script di rollout del Task B11). `opts.night`: la notte da usare (la ripresa
 * dello scheduler passa quella dell'avvio, così una ripresa dopo la mezzanotte
 * di Roma conta ancora per la notte iniziata); assente = la data di Roma di
 * `now`. Non lancia (un errore inatteso fuori dai repository si logga).
 */
let nightRunning = false;

export async function runNight(
  deps: NightlyDeps,
  now: Date,
  opts: { repositoryId?: string; night?: string } = {},
): Promise<NightResult> {
  const night = opts.night ?? nightOf(now);
  const result: NightResult = {
    night,
    repositories: 0,
    itemsDone: 0,
    itemsPending: 0,
    stoppedForQuota: false,
    skipped: [],
  };
  // Il worker è UN processo: un flag in memoria basta (la lease della coda
  // coprirebbe comunque un doppio claim).
  if (nightRunning) {
    deps.log(`[stubwise-worker] notte ${night}: un giro è già in corso, salto`);
    return { ...result, busy: true };
  }
  nightRunning = true;
  const runs: RepoRun[] = [];
  try {
    const loaded = await loadRepos(deps, opts.repositoryId);
    result.repositories = loaded.length;
    if (loaded.length === 0) return result;

    try {
      await queueDailyReports(deps, loaded, now, night);
    } catch (err) {
      deps.log(`[stubwise-worker] notte ${night}: report giornalieri non accodati (${errText(err)})`);
    }

    // 1. Pianificazione, repository per repository, nel serializer del progetto.
    for (const l of loaded) {
      if (l.repo === null) {
        deps.log(
          `[stubwise-worker] notte ${night}: credenziali git di ${l.repositoryName} non decifrabili, repository saltato`,
        );
        result.skipped.push({ repositoryId: l.repositoryId, reason: "unreachable" });
        continue;
      }
      const repo = l.repo;
      try {
        const plan = await deps.serializer.run(repo.projectId, () => planRepository(deps, repo, now, night));
        if (plan === "generation_running") {
          result.skipped.push({ repositoryId: repo.repositoryId, reason: "generation_running" });
        }
        runs.push({
          repo,
          exclusive: l.exclusive,
          stage: "summary",
          plan: plan === null || plan === "generation_running" ? null : plan,
          notes: [],
          releaseWaits: new Set(),
          pagesReady: false,
          worktree: null,
        });
      } catch (err) {
        deps.log(
          `[stubwise-worker] notte ${night}: ${repo.repositoryName} irraggiungibile (${errText(err)}), repository saltato`,
        );
        result.skipped.push({ repositoryId: repo.repositoryId, reason: "unreachable" });
      }
    }

    // 2. Consumo a turno: un passo (al più un elemento) per repository per giro.
    let active = [...runs];
    outer: while (active.length > 0) {
      for (const run of [...active]) {
        if (!active.includes(run)) continue;
        let step: StepResult;
        try {
          step = await stepRepository(deps, run, night, result);
        } catch (err) {
          deps.log(
            `[stubwise-worker] notte ${night}: ${run.repo.repositoryName} interrotto (${errText(err)}), gli altri proseguono`,
          );
          step = "idle";
        }
        if (step === "progress") continue;
        if (step === "idle") {
          active = active.filter((r) => r !== run);
          await closeWorktree(deps, run);
          continue;
        }
        if ("stop" in step) {
          result.stoppedForQuota = true;
          deps.log(`[stubwise-worker] notte ${night}: quota esaurita, giro fermo (ripresa ogni 15 minuti)`);
          break outer;
        }
        const projectId = run.repo.projectId;
        const reason = step.skipProject;
        deps.log(
          `[stubwise-worker] notte ${night}: progetto ${run.repo.projectName} saltato per la notte (${reason === "provider_quota" ? "il suo account esclusivo è al limite" : "nessun account utilizzabile"})`,
        );
        for (const r of active.filter((x) => x.repo.projectId === projectId)) {
          result.skipped.push({ repositoryId: r.repo.repositoryId, reason });
          await closeWorktree(deps, r);
        }
        active = active.filter((r) => r.repo.projectId !== projectId);
      }
    }

    for (const run of runs) result.itemsPending += await pendingCount(deps.db, run.repo.repositoryId);
    deps.log(
      `[stubwise-worker] notte ${night}: ${result.itemsDone} elementi fatti, ${result.itemsPending} in attesa, ${result.skipped.length} repository saltati${result.stoppedForQuota ? ", fermo per quota" : ""}`,
    );
    return result;
  } catch (err) {
    deps.log(`[stubwise-worker] notte ${night}: giro interrotto (${errText(err)})`);
    return result;
  } finally {
    for (const run of runs) await closeWorktree(deps, run);
    nightRunning = false;
  }
}

/**
 * Pianificazione di un repository, DENTRO il serializer del progetto: l'unico
 * fetch della notte e ogni elenco dei commit (D6). Ritorna il piano dei Docs,
 * `generation_running`, o null (niente Docs stanotte).
 */
async function planRepository(
  deps: NightlyDeps,
  repo: NightlyRepo,
  now: Date,
  night: string,
): Promise<DocsPlan | "generation_running" | null> {
  // Una generazione completa in corso tiene aperto il suo worktree sul branch
  // `stubwise/docs-generation` FUORI dal serializer: un `fetch --prune` ne
  // poterebbe il ref. Niente fetch stanotte su quel repository: i riassunti
  // lavorano sul mirror com'è (aggiornato dalla generazione stessa).
  const generationRunning = await hasRunningGeneration(deps, repo.repositoryId);
  if (generationRunning) {
    deps.log(
      `[stubwise-worker] notte ${night}: generazione completa in corso su ${repo.repositoryName}: niente fetch, niente Docs, solo i riassunti`,
    );
  } else {
    await deps.mirrors.ensureMirror(repo.project);
  }
  const since = new Date(now.getTime() - deps.config.summaryWindowDays * DAY_MS);
  const recent = await deps.mirrors.listRecentCommits(repo.project, since, { skipFetch: true });
  await enqueueSummaries(deps, repo, recent, night);
  if (!repo.docsNightly) return null;
  if (generationRunning) return "generation_running";

  const plan = await planDocs(deps, repo);
  if (isPlanSkip(plan)) return plan.skipped === "generation_running" ? "generation_running" : null;
  if (plan.missingSummaries.length > 0) {
    const listed = new Set(recent.map((c) => c.sha));
    const outside = plan.missingSummaries.filter((s) => !listed.has(s));
    await enqueueSummaries(deps, repo, await commitsBySha(deps, repo, outside, night), night);
  }
  await enqueueReleaseItem(deps, repo, plan, night);
  return plan;
}

async function hasRunningGeneration(deps: NightlyDeps, repositoryId: string): Promise<boolean> {
  const [row] = await deps.db
    .select({ id: docGenerations.id })
    .from(docGenerations)
    .where(
      and(
        eq(docGenerations.repositoryId, repositoryId),
        inArray(docGenerations.status, ["running", "paused"]),
      ),
    )
    .limit(1);
  return row !== undefined;
}

async function closeWorktree(deps: NightlyDeps, run: RepoRun): Promise<void> {
  const wt = run.worktree;
  if (!wt) return;
  run.worktree = null;
  try {
    await deps.serializer.run(run.repo.projectId, () => wt.remove());
  } catch (err) {
    deps.log(`[stubwise-worker] notte: worktree di ${run.repo.repositoryName} non rimosso (${errText(err)})`);
  }
}

/** Un `unavailable`: l'elemento torna libero, poi stop globale o salto del progetto. */
async function onUnavailable(
  deps: NightlyDeps,
  run: RepoRun,
  item: NightlyItem,
  reason: EmptyReason | "all_limited_now",
): Promise<StepResult> {
  await releaseItem(deps.db, item.id);
  if (!isQuotaWait(reason)) return { skipProject: "provider_config" };
  return run.exclusive ? { skipProject: "provider_quota" } : { stop: "quota" };
}

/** Un fallimento contato; all'escalation la card in inbox. */
async function onFailed(
  deps: NightlyDeps,
  run: RepoRun,
  item: NightlyItem,
  error: string,
  night: string,
): Promise<StepResult> {
  const outcome = await failItem(deps.db, item.id, error, night);
  deps.log(
    `[stubwise-worker] notte ${night}: ${item.phase} ${item.key} di ${run.repo.repositoryName} fallito (${error})${outcome === "escalated" ? ": escalation" : ""}`,
  );
  if (outcome === "escalated") {
    await publishDocsNightlyAttention(
      deps.db,
      {
        reason: "item_failing",
        repositoryId: run.repo.repositoryId,
        repositoryName: run.repo.repositoryName,
        projectId: run.repo.projectId,
        projectName: run.repo.projectName,
        night,
        phase: item.phase,
        key: item.key,
        lastError: error.length > MAX_CARD_ERROR_CHARS ? `${error.slice(0, MAX_CARD_ERROR_CHARS)}…` : error,
        publicUrl: deps.publicUrl,
      },
      deps.publish ? { publish: deps.publish } : {},
    );
  }
  return "progress";
}

async function claim(deps: NightlyDeps, run: RepoRun, phase: NightlyPhase, night: string) {
  return claimNext(deps.db, run.repo.repositoryId, phase, { notFailedOn: night });
}

/**
 * Un passo di un repository: al più UN elemento consumato (gli stadi senza
 * lavoro si attraversano nello stesso passo). `idle` = il repository ha finito.
 */
async function stepRepository(
  deps: NightlyDeps,
  run: RepoRun,
  night: string,
  result: NightResult,
): Promise<StepResult> {
  const { repo } = run;
  for (;;) {
    if (run.stage === "summary") {
      const item = await claim(deps, run, "summary", night);
      if (!item) {
        run.stage = run.plan ? "release" : "done";
        continue;
      }
      const commit = readCommit(item.payload);
      if (commit === null) return onFailed(deps, run, item, "payload del riassunto non valido", night);
      const out = await summarizeCommit(
        {
          db: deps.db,
          mirrors: deps.mirrors,
          runner: deps.runner,
          select: deps.select,
          model: deps.config.commitSummaryModel,
          diffMaxChars: deps.config.diffMaxChars,
          log: deps.log,
        },
        repo,
        commit,
      );
      if (out.status === "done") {
        await completeItem(deps.db, item.id);
        result.itemsDone++;
        return "progress";
      }
      if (out.status === "unavailable") return onUnavailable(deps, run, item, out.reason);
      return onFailed(deps, run, item, out.error, night);
    }

    if (run.stage === "release") {
      const plan = run.plan!;
      const item = await claim(deps, run, "release", night);
      if (!item) {
        await planPages(deps, repo, plan, run.notes, night);
        run.stage = "pages";
        continue;
      }
      const out = await runReleaseItem(deps, repo, item);
      if (out.status === "done") {
        // runReleaseItem ha già chiuso l'elemento.
        if (out.notes) run.notes.push(out.notes);
        result.itemsDone++;
        return "progress";
      }
      if (out.status === "waiting") {
        await releaseItem(deps.db, item.id);
        if (run.releaseWaits.has(item.id)) {
          // Ha già aspettato in questo giro e i riassunti non sono arrivati
          // (falliti stanotte): nota e pagine aspettano la notte dopo.
          deps.log(
            `[stubwise-worker] notte ${night}: la nota ${item.key} di ${repo.repositoryName} aspetta ancora i riassunti: Docs rimandati`,
          );
          run.stage = "done";
          return "idle";
        }
        run.releaseWaits.add(item.id);
        // Un commit della nota può non avere il suo elemento `summary` (es. dopo
        // il ripiego di un force-push): lo si accoda, o la nota aspetterebbe per sempre.
        await deps.serializer.run(repo.projectId, async () =>
          enqueueSummaries(deps, repo, await commitsBySha(deps, repo, out.missing, night), night),
        );
        run.stage = "summary";
        return "progress";
      }
      if (out.status === "unavailable") return onUnavailable(deps, run, item, out.reason);
      return onFailed(deps, run, item, out.error, night);
    }

    if (run.stage === "pages") {
      const plan = run.plan!;
      if (!run.pagesReady) {
        run.pagesReady = true;
        const pending =
          (await pendingCount(deps.db, repo.repositoryId, "page_update")) +
          (await pendingCount(deps.db, repo.repositoryId, "page_create"));
        if (pending > 0) {
          try {
            run.worktree = await deps.serializer.run(repo.projectId, () =>
              deps.mirrors.openWorktreeAtSha(repo.project, plan.toSha, { skipFetch: true }),
            );
          } catch (err) {
            deps.log(
              `[stubwise-worker] notte ${night}: worktree di ${repo.repositoryName} a ${plan.toSha} non apribile (${errText(err)}): pagine rimandate`,
            );
            run.stage = "done";
            return "idle";
          }
        }
      }
      const update = await claim(deps, run, "page_update", night);
      const item = update ?? (await claim(deps, run, "page_create", night));
      if (!item) {
        await advanceBookmarkIfDone(deps, repo, plan);
        run.stage = "done";
        return "idle";
      }
      if (!run.worktree) {
        // Nessun pendente quando il worktree si sarebbe aperto: l'elemento
        // aspetta il prossimo giro.
        await releaseItem(deps.db, item.id);
        run.stage = "done";
        return "idle";
      }
      if (item.phase === "page_update") {
        const out = await runPageUpdateItem(deps, repo, run.worktree.dir, item);
        // updated/unchanged: l'elemento è già chiuso (con le righe D31).
        if (out === "updated" || out === "unchanged") {
          result.itemsDone++;
          return "progress";
        }
        if ("unavailable" in out) return onUnavailable(deps, run, item, out.unavailable);
        return onFailed(deps, run, item, out.failed, night);
      }
      const out = await runPageCreateItem(deps, repo, run.worktree.dir, item);
      // created/skipped: l'elemento è già chiuso.
      if (out === "created" || out === "skipped") {
        result.itemsDone++;
        return "progress";
      }
      if ("unavailable" in out) return onUnavailable(deps, run, item, out.unavailable);
      return onFailed(deps, run, item, out.failed, night);
    }

    return "idle";
  }
}

/**
 * C'è lavoro del giro che una ripresa POTREBBE fare, per la notte `night`?
 * Solo elementi reclamabili: `pending`, lease libera, non già falliti in quella
 * notte (`claimNext` li salterebbe) e di un progetto con almeno un interruttore
 * acceso (`loadRepos` li ignorerebbe). Altrimenti quasi ogni riavvio di giorno
 * lancerebbe un giro intero per niente.
 */
export async function hasPendingNightWork(deps: Pick<NightlyDeps, "db">, night: string): Promise<boolean> {
  const [row] = await deps.db
    .select({ id: nightlyItems.id })
    .from(nightlyItems)
    .innerJoin(projects, eq(projects.id, nightlyItems.projectId))
    .where(
      and(
        eq(nightlyItems.status, "pending"),
        sql`(${nightlyItems.claimedAt} IS NULL OR ${nightlyItems.claimedAt} < now() - ${NIGHTLY_ITEM_LEASE_MS} * interval '1 millisecond')`,
        sql`(${nightlyItems.lastFailedNight} IS NULL OR ${nightlyItems.lastFailedNight} <> ${night}::date)`,
        or(eq(projects.dailyReportEnabled, true), eq(projects.docAutoUpdate, true)),
      ),
    )
    .limit(1);
  return row !== undefined;
}

/**
 * La notte `night` è già partita? Lo dice la coda, non la memoria del processo:
 * partita se esiste un elemento con quella notte (ogni giro ne scrive almeno
 * uno appena c'è un progetto col report acceso o un commit nuovo). Un giro che
 * non ha scritto nulla si rifà al riavvio, e non costa niente.
 */
export async function nightStarted(deps: Pick<NightlyDeps, "db">, night: string): Promise<boolean> {
  const [row] = await deps.db
    .select({ id: nightlyItems.id })
    .from(nightlyItems)
    .where(sql`${nightlyItems.night} = ${night}::date`)
    .limit(1);
  return row !== undefined;
}

/** Stato in memoria dello scheduler. */
export interface SchedulerState {
  /** Ultima notte avviata all'orario. */
  lastStartedNight: string | null;
  /** Ripresa in attesa: la notte da riprendere e quando. */
  resume: { night: string; at: number } | null;
}

export type SchedulerAction = { kind: "start"; night: string } | { kind: "resume"; night: string } | null;

/**
 * Cosa fare a un tick. All'orario (`NIGHTLY_START`, ora di Roma) parte la
 * notte nuova, una volta per data; altrimenti, se c'è una ripresa scaduta, la
 * ripresa. Il confronto è `>=`: un orario saltato dal cambio dell'ora (02:30
 * il giorno in cui le 02:00 diventano 03:00) parte al primo tick dopo.
 */
export function schedulerAction(state: SchedulerState, now: Date, start: string): SchedulerAction {
  const night = nightOf(now);
  if (romeMinutes(now) >= startMinutes(start) && state.lastStartedNight !== night) {
    return { kind: "start", night };
  }
  if (state.resume && now.getTime() >= state.resume.at) return { kind: "resume", night: state.resume.night };
  return null;
}

/** La notte più recente il cui orario è passato (oggi, o ieri prima dell'orario). */
export function lastNightOf(now: Date, start: string): string {
  return romeMinutes(now) >= startMinutes(start) ? nightOf(now) : nightOf(new Date(now.getTime() - DAY_MS));
}

/**
 * Lo stato all'avvio del processo. Dopo l'orario, la notte di oggi conta come
 * avviata SOLO se la coda lo dice (`todayStarted`): un worker giù alle 02:00, un
 * crash loop o un deploy a cavallo dell'orario fanno partire la notte subito,
 * invece di perderla (e con lei i daily report). Se c'è lavoro reclamabile,
 * una ripresa al primo tick per la notte più recente, che poi continua ogni
 * 15′ solo se si ferma di nuovo per quota.
 */
export function initialSchedulerState(
  now: Date,
  start: string,
  boot: { todayStarted: boolean; pendingWork: boolean },
): SchedulerState {
  const afterStart = romeMinutes(now) >= startMinutes(start);
  return {
    lastStartedNight: afterStart && boot.todayStarted ? nightOf(now) : null,
    resume: boot.pendingWork ? { night: lastNightOf(now, start), at: now.getTime() } : null,
  };
}

export interface NightlySchedulerOptions {
  signal: AbortSignal;
  /** Intervallo dei tick (default 60 s). */
  tickMs?: number;
  /** Iniettabile nei test. */
  runNightFn?: typeof runNight;
}

/**
 * Lo scheduler del giro: un tick al minuto decide (`schedulerAction`) se
 * partire all'orario o riprendere. Una notte che termina ferma per quota (o con
 * un progetto «solo questo» al limite) si riprende ogni 15 minuti, finché non
 * torna margine o arriva il `NIGHTLY_START` successivo (che riparte da capo).
 * Mai due giri insieme (`runNight` stesso lo garantisce, e qui un tick non ne
 * avvia un altro finché il precedente non è finito). Ritorna lo stop.
 */
export function startNightlyScheduler(deps: NightlyDeps & NightlySchedulerOptions): () => void {
  const { signal, tickMs = 60_000, runNightFn = runNight, ...nightly } = deps;
  const clock = () => nightly.now?.() ?? new Date();
  let state: SchedulerState | null = null;
  let ticking = false;

  const tick = async (): Promise<void> => {
    if (ticking || signal.aborted) return;
    ticking = true;
    try {
      const now = clock();
      state ??= initialSchedulerState(now, nightly.config.start, {
        todayStarted: await nightStarted(nightly, nightOf(now)),
        pendingWork: await hasPendingNightWork(nightly, lastNightOf(now, nightly.config.start)),
      });
      const action = schedulerAction(state, now, nightly.config.start);
      if (action === null) return;
      if (action.kind === "start") state.lastStartedNight = action.night;
      state.resume = null;
      const result = await runNightFn(nightly, now, { night: action.night });
      if (nightNeedsResume(result)) {
        state.resume = { night: action.night, at: clock().getTime() + NIGHTLY_RESUME_MS };
      }
    } catch (err) {
      nightly.log(`[stubwise-worker] notte: tick dello scheduler fallito (${errText(err)})`);
    } finally {
      ticking = false;
    }
  };

  void tick();
  const timer = setInterval(() => void tick(), tickMs);
  if (typeof timer.unref === "function") timer.unref();
  const stop = (): void => clearInterval(timer);
  signal.addEventListener("abort", stop, { once: true });
  return stop;
}
