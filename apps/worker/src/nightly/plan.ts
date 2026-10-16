import {
  commitSummaries,
  docGenerations,
  docPagePendingCommits,
  docPages,
  nightlyItems,
  repositories,
  type Db,
} from "@stubwise/db";
import { aggregateNewAreas, mapAffectedPages, pathCovers, type PageRef, type ReleaseNotes } from "@stubwise/docs-engine";
import { publishDocsNightlyAttention } from "@stubwise/notifications";
import { and, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { isNoise } from "./noise.js";
import { upsertTargetItems, type TargetItem } from "./queue.js";
import type { NightlyDeps, NightlyRepo } from "./types.js";

/**
 * Fase 3 del giro notturno (Piano B, Task B6), in due tempi (D3):
 *
 * 1. {@link planDocs}, in testa, DENTRO il serializer dopo l'`ensureMirror`
 *    (ogni git con `skipFetch`): la rete di sicurezza di D32, i commit entrati
 *    nel branch di default dal segnalibro dei Docs (`doc_generations.commit_sha`
 *    della generazione corrente) e la mappa file → pagine. I commit senza
 *    riassunto (branch vecchi mergiati tardi, fuori dalla finestra dei
 *    riassunti) tornano in `missingSummaries`: l'orchestratore accoda per loro
 *    elementi `summary` (D24), che la fase 1 consuma prima della nota.
 * 2. dopo il tentativo della nota (`release.ts`), {@link planPages}: candidate =
 *    mappa ∪ pagine della nota, un `page_update` per candidata e un
 *    `page_create` per area nuova, e l'allarme del piano sopra soglia.
 *
 * Il segnalibro NON si muove qui: lo avanza `advanceBookmarkIfDone` (Task B7)
 * quando non resta lavoro di pagina pendente.
 */

export interface DocsPlan {
  generationId: string;
  /** Il segnalibro dei Docs (`commit_sha` della generazione corrente). */
  fromSha: string | null;
  /** La head del branch di default al momento del piano. */
  toSha: string;
  /** Commit (non merge) entrati nel branch di default dopo `fromSha`, dal più recente. */
  commits: string[];
  /** File non rumore dei riassunti dei commit (unione, ordine stabile). */
  changedFiles: string[];
  /** Pagine toccate dalla mappa (`mapAffectedPages`, nessun tetto). */
  mapped: PageRef[];
  /** File non coperti da nessuna pagina. */
  newAreas: string[];
  /** Commit del piano senza riassunto: l'orchestratore accoda i loro `summary`. */
  missingSummaries: string[];
}

/** Perché un repository salta nota e pagine stanotte (Disc. 14). */
export type DocsPlanSkip = { skipped: "no_generation" | "generation_running" };

export function isPlanSkip(plan: DocsPlan | DocsPlanSkip): plan is DocsPlanSkip {
  return "skipped" in plan;
}

/** `last_error` di un elemento chiuso perché la sua generazione è stata sostituita (D32). */
export const SUPERSEDED_BY_GENERATION = "superseded_by_generation";

const DAY_MS = 24 * 60 * 60_000;

/** Pagine della generazione (forma della mappa). */
export async function loadPageRefs(db: Db, generationId: string): Promise<PageRef[]> {
  return db
    .select({
      id: docPages.id,
      slug: docPages.slug,
      title: docPages.title,
      sourcePath: docPages.sourcePath,
      parentId: docPages.parentId,
    })
    .from(docPages)
    .where(eq(docPages.generationId, generationId));
}

interface PlanSummary {
  sha: string;
  /** File non rumore del commit. */
  files: string[];
}

/**
 * Riassunti dei commit del piano, nell'ordine dei commit, coi soli file non
 * rumore. Un commit senza riga non c'è (lo dice `missing`).
 */
async function loadPlanSummaries(
  db: Db,
  repositoryId: string,
  commits: string[],
): Promise<{ summaries: PlanSummary[]; missing: string[] }> {
  if (commits.length === 0) return { summaries: [], missing: [] };
  const rows = await db
    .select({ sha: commitSummaries.sha, files: commitSummaries.files, noise: commitSummaries.noise })
    .from(commitSummaries)
    .where(and(eq(commitSummaries.repositoryId, repositoryId), inArray(commitSummaries.sha, commits)));
  const bySha = new Map(rows.map((r) => [r.sha, r]));
  const summaries: PlanSummary[] = [];
  const missing: string[] = [];
  for (const sha of commits) {
    const row = bySha.get(sha);
    if (!row) {
      missing.push(sha);
      continue;
    }
    summaries.push({ sha, files: row.noise ? [] : row.files.filter((f) => !isNoise(f)) });
  }
  return { summaries, missing };
}

function unionFiles(summaries: PlanSummary[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const s of summaries) {
    for (const f of s.files) {
      if (seen.has(f)) continue;
      seen.add(f);
      out.push(f);
    }
  }
  return out;
}

/** `on_default_branch = true` sui riassunti dei commit (idempotente). */
async function markOnDefaultBranch(db: Db, repositoryId: string, commits: string[]): Promise<void> {
  if (commits.length === 0) return;
  await db
    .update(commitSummaries)
    .set({ onDefaultBranch: true })
    .where(
      and(
        eq(commitSummaries.repositoryId, repositoryId),
        inArray(commitSummaries.sha, commits),
        eq(commitSummaries.onDefaultBranch, false),
      ),
    );
}

/**
 * Rete di sicurezza di D32, a ogni piano (idempotente): chiude `done` senza run
 * i `page_update`/`page_create` `pending` di una generazione che non è più la
 * corrente, e marca `documented_at` sui riassunti dei commit raggiungibili dal
 * `commit_sha` corrente per ascendenza ESATTA (`merge-base --is-ancestor` per
 * sha sul mirror: copre anche un commit vecchio mergiato tardi, che la data
 * non dice). Il git gira prima, le scritture in UNA transazione.
 */
async function realignToGeneration(
  deps: NightlyDeps,
  repo: NightlyRepo,
  generationId: string,
  commitSha: string | null,
): Promise<{ closed: number; documented: number }> {
  const reachable: string[] = [];
  if (commitSha !== null) {
    const undocumented = await deps.db
      .select({ sha: commitSummaries.sha })
      .from(commitSummaries)
      .where(
        and(
          eq(commitSummaries.repositoryId, repo.repositoryId),
          eq(commitSummaries.onDefaultBranch, true),
          isNull(commitSummaries.documentedAt),
        ),
      );
    for (const { sha } of undocumented) {
      try {
        if (await deps.mirrors.isAncestor(repo.project, sha, commitSha, { skipFetch: true })) reachable.push(sha);
      } catch {
        // Uno sha che il mirror non ha più (force-push potato): non è raggiungibile.
      }
    }
  }

  return deps.db.transaction(async (tx) => {
    const closed = await tx
      .update(nightlyItems)
      .set({ status: "done", lastError: SUPERSEDED_BY_GENERATION, claimedAt: null, updatedAt: sql`now()` })
      .where(
        and(
          eq(nightlyItems.repositoryId, repo.repositoryId),
          inArray(nightlyItems.phase, ["page_update", "page_create"]),
          eq(nightlyItems.status, "pending"),
          sql`(${nightlyItems.payload} ->> 'generationId') IS DISTINCT FROM ${generationId}`,
        ),
      )
      .returning({ id: nightlyItems.id });
    let documented = 0;
    if (reachable.length > 0) {
      const rows = await tx
        .update(commitSummaries)
        .set({ documentedAt: sql`now()` })
        .where(
          and(
            eq(commitSummaries.repositoryId, repo.repositoryId),
            inArray(commitSummaries.sha, reachable),
            isNull(commitSummaries.documentedAt),
          ),
        )
        .returning({ sha: commitSummaries.sha });
      documented = rows.length;
    }
    return { closed: closed.length, documented };
  });
}

/**
 * Il piano dei Docs di un repository (D3). DENTRO il serializer, dopo
 * l'`ensureMirror` dell'orchestratore: ogni lettura del mirror è `skipFetch`.
 * Salta (con il motivo) senza generazione corrente o con una generazione
 * completa `running`/`paused` sul repository (D29).
 */
export async function planDocs(deps: NightlyDeps, repo: NightlyRepo): Promise<DocsPlan | DocsPlanSkip> {
  const [repoRow] = await deps.db
    .select({ currentGenerationId: repositories.currentDocGenerationId })
    .from(repositories)
    .where(eq(repositories.id, repo.repositoryId));
  const generationId = repoRow?.currentGenerationId ?? null;
  if (generationId === null) return { skipped: "no_generation" };
  const [generation] = await deps.db
    .select({ commitSha: docGenerations.commitSha })
    .from(docGenerations)
    .where(eq(docGenerations.id, generationId));
  if (!generation) return { skipped: "no_generation" };

  const [running] = await deps.db
    .select({ id: docGenerations.id })
    .from(docGenerations)
    .where(
      and(
        eq(docGenerations.repositoryId, repo.repositoryId),
        or(eq(docGenerations.status, "running"), eq(docGenerations.status, "paused")),
      ),
    )
    .limit(1);
  if (running) return { skipped: "generation_running" };

  const fromSha = generation.commitSha;
  const realigned = await realignToGeneration(deps, repo, generationId, fromSha);
  if (realigned.closed > 0 || realigned.documented > 0) {
    deps.log(
      `[stubwise-worker] notte: ${repo.repositoryName} riallineato alla generazione ${generationId} (${realigned.closed} elementi chiusi senza run, ${realigned.documented} commit documentati)`,
    );
  }

  const now = deps.now?.() ?? new Date();
  const since = new Date(now.getTime() - deps.config.summaryWindowDays * DAY_MS);
  const listed = await deps.mirrors.listDefaultBranchCommitsSince(repo.project, fromSha, since, { skipFetch: true });
  if (listed.fallback) {
    deps.log(
      `[stubwise-worker] notte: il segnalibro dei Docs ${fromSha ?? "-"} di ${repo.repositoryName} non è più nel branch di default: ripiego sui commit degli ultimi ${deps.config.summaryWindowDays} giorni`,
    );
  }

  await markOnDefaultBranch(deps.db, repo.repositoryId, listed.commits);
  const map = await mapPlanFiles(deps.db, repo.repositoryId, generationId, listed.commits);
  return {
    generationId,
    fromSha,
    toSha: listed.headSha,
    commits: listed.commits,
    changedFiles: map.changedFiles,
    mapped: map.mapped,
    newAreas: map.newAreas,
    missingSummaries: map.missing,
  };
}

/** La mappa file → pagine dei commit, dai riassunti che ci sono ORA. */
async function mapPlanFiles(db: Db, repositoryId: string, generationId: string, commits: string[]) {
  const { summaries, missing } = await loadPlanSummaries(db, repositoryId, commits);
  const changedFiles = unionFiles(summaries);
  const pages = await loadPageRefs(db, generationId);
  const { affected, newAreas } = mapAffectedPages(changedFiles, pages, Number.MAX_SAFE_INTEGER);
  return { summaries, missing, changedFiles, pages, mapped: affected, newAreas };
}

type Via = "map" | "note" | "parent";

/**
 * File leggibili da una pagina (D13): quelli coperti dal suo `sourcePath`; per
 * un genitore-overview l'unione di quelli coperti dai figli; per una pagina che
 * entra solo dalla nota e non copre niente, tutti i file.
 */
function scopeFiles(page: PageRef, via: Via, files: string[], children: PageRef[]): string[] {
  const covered = files.filter(
    (f) =>
      (page.sourcePath !== null && pathCovers(page.sourcePath, f)) ||
      (via === "parent" && children.some((c) => c.sourcePath !== null && pathCovers(c.sourcePath, f))),
  );
  if (covered.length === 0 && via === "note") return files;
  return covered;
}

/**
 * Dopo il tentativo della nota (riuscito, fallito o assente): accoda le pagine
 * della notte e valuta l'allarme. Ricalcola la mappa dai riassunti che ci sono
 * ORA (i `missingSummaries` del piano possono essere stati scritti nel
 * frattempo) e la unisce a `plan.mapped`; marca anche `on_default_branch` sui
 * loro riassunti. Una pagina con commit pendenti di un'escalation (D31) li
 * riceve nel payload SOLO se è candidata stanotte.
 */
export async function planPages(
  deps: NightlyDeps,
  repo: NightlyRepo,
  plan: DocsPlan,
  notes: ReleaseNotes | null,
  night: string,
): Promise<{ candidates: number; newAreas: number; alarm: boolean }> {
  await markOnDefaultBranch(deps.db, repo.repositoryId, plan.commits);
  const map = await mapPlanFiles(deps.db, repo.repositoryId, plan.generationId, plan.commits);
  const pagesById = new Map(map.pages.map((p) => [p.id, p]));
  const childrenOf = (id: string) => map.pages.filter((p) => p.parentId === id);

  // Candidate: mappa (di ora ∪ del piano, solo pagine che esistono ancora) ∪ nota.
  const candidates = new Map<string, { page: PageRef; via: Via }>();
  for (const ref of [...map.mapped, ...plan.mapped]) {
    const page = pagesById.get(ref.id);
    if (!page || candidates.has(page.id)) continue;
    const coversOwn = page.sourcePath !== null && map.changedFiles.some((f) => pathCovers(page.sourcePath!, f));
    // Una pagina della mappa che non copre file suoi è entrata come genitore-overview.
    candidates.set(page.id, { page, via: coversOwn ? "map" : "parent" });
  }
  if (notes) {
    const bySlug = new Map(map.pages.map((p) => [p.slug, p]));
    for (const slug of notes.affectedSlugs) {
      const page = bySlug.get(slug);
      if (!page || candidates.has(page.id)) continue;
      candidates.set(page.id, { page, via: "note" });
    }
  }

  // Commit pendenti delle escalation (D31), solo per le candidate.
  const pendingByPage = new Map<string, { sha: string; files: string[] }[]>();
  if (candidates.size > 0) {
    const rows = await deps.db
      .select({
        pageId: docPagePendingCommits.pageId,
        sha: docPagePendingCommits.sha,
        files: commitSummaries.files,
        noise: commitSummaries.noise,
      })
      .from(docPagePendingCommits)
      .innerJoin(
        commitSummaries,
        and(
          eq(commitSummaries.repositoryId, docPagePendingCommits.repositoryId),
          eq(commitSummaries.sha, docPagePendingCommits.sha),
        ),
      )
      .where(inArray(docPagePendingCommits.pageId, [...candidates.keys()]));
    for (const r of rows) {
      const list = pendingByPage.get(r.pageId) ?? [];
      list.push({ sha: r.sha, files: r.noise ? [] : r.files.filter((f) => !isNoise(f)) });
      pendingByPage.set(r.pageId, list);
    }
  }

  const updates: TargetItem[] = [];
  for (const { page, via } of candidates.values()) {
    const children = childrenOf(page.id);
    const files = scopeFiles(page, via, map.changedFiles, children);
    const fileSet = new Set(files);
    const commits = map.summaries.filter((s) => s.files.some((f) => fileSet.has(f))).map((s) => s.sha);
    for (const pending of pendingByPage.get(page.id) ?? []) {
      if (!commits.includes(pending.sha)) commits.push(pending.sha);
      for (const f of scopeFiles(page, via, pending.files, children)) {
        if (!fileSet.has(f)) {
          fileSet.add(f);
          files.push(f);
        }
      }
    }
    updates.push({
      repositoryId: repo.repositoryId,
      projectId: repo.projectId,
      phase: "page_update",
      target: page.id,
      toSha: plan.toSha,
      payload: {
        generationId: plan.generationId,
        pageId: page.id,
        fromSha: plan.fromSha,
        toSha: plan.toSha,
        files,
        commits,
        via,
      },
    });
  }

  const areas = aggregateNewAreas(map.newAreas);
  const creates: TargetItem[] = areas.map((area) => ({
    repositoryId: repo.repositoryId,
    projectId: repo.projectId,
    phase: "page_create",
    target: area.path,
    toSha: plan.toSha,
    payload: { generationId: plan.generationId, toSha: plan.toSha, area: area.path, files: area.files },
  }));

  const touched = await upsertTargetItems(deps.db, [...updates, ...creates], night);

  // Allarme (per repository): run Sonnet pianificati = nota della notte +
  // pagine da aggiornare + aree. Solo se QUESTA chiamata ha inserito o
  // riallineato qualcosa: rieseguire il piano nella stessa notte non ripubblica.
  let alarm = false;
  if (touched > 0) {
    const [release] = await deps.db
      .select({ id: nightlyItems.id })
      .from(nightlyItems)
      .where(
        and(
          eq(nightlyItems.repositoryId, repo.repositoryId),
          eq(nightlyItems.phase, "release"),
          or(eq(nightlyItems.status, "pending"), eq(nightlyItems.night, night)),
        ),
      )
      .limit(1);
    const runs = (release ? 1 : 0) + candidates.size + areas.length;
    if (runs > deps.config.alertRuns) {
      alarm = true;
      deps.log(
        `[stubwise-worker] notte: piano dei Docs di ${repo.repositoryName} sopra soglia (${runs} run > ${deps.config.alertRuns}): avviso pubblicato, si procede`,
      );
      await publishDocsNightlyAttention(
        deps.db,
        {
          reason: "plan_oversized",
          repositoryId: repo.repositoryId,
          repositoryName: repo.repositoryName,
          projectId: repo.projectId,
          projectName: repo.projectName,
          night,
          counts: { commits: plan.commits.length, candidates: candidates.size, newAreas: areas.length },
          runs,
          threshold: deps.config.alertRuns,
          publicUrl: deps.publicUrl,
        },
        deps.publish ? { publish: deps.publish } : {},
      );
    }
  }
  return { candidates: candidates.size, newAreas: areas.length, alarm };
}
