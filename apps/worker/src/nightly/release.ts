import { commitSummaries, docPages, nightlyItems, repositories, type Db } from "@stubwise/db";
import {
  buildReleasePrompt,
  mapAffectedPages,
  parseReleaseNotes,
  type ExistingPage,
  type ReleaseNotes,
} from "@stubwise/docs-engine";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { runAgentTextRaw, textFromRun } from "../agent/text.js";
import { limitTextOfRun, runWithProviders, type EmptyReason } from "../providers/select.js";
import { isNoise } from "./noise.js";
import { loadPageRefs, type DocsPlan } from "./plan.js";
import { enqueueItems, type NightlyItem } from "./queue.js";
import { buildRelatedLinks, uniqueReleaseSlug } from "./release-page.js";
import type { NightlyDeps, NightlyRepo } from "./types.js";

/**
 * La nota di rilascio del giro notturno (Piano B, Task B6): UNA pagina
 * `releases` per intervallo, scritta dai riassunti dei commit (non legge
 * codice: run di solo testo, `runAgentTextRaw`, nessun tool di scrittura) col
 * modello `RELEASE_NOTES_MODEL`.
 *
 * La nota ha il SUO punto di partenza (D5): il `toSha` dell'ultimo elemento
 * `release` del repository, qualunque stato, altrimenti il segnalibro dei Docs.
 * Così una nota scritta non si riscrive mentre il segnalibro aspetta, e una
 * nota fallita si riprova la notte dopo sul SUO intervallo (payload
 * `{ fromSha, toSha, commits }`), mentre i commit nuovi vanno in una seconda.
 *
 * Si scrive PRIMA delle pagine per orientarle (`planPages` legge i suoi
 * `affectedSlugs`); i link «related» alle pagine aggiornate o create li
 * completa la fine della fase 4 (`appendRelatedLinks`, Task B7).
 *
 * PROMPT INJECTION: subject e riassunti sono input NON FIDATO; il run è di solo
 * testo (plan mode, cwd temporanea vuota): il caso peggiore è una nota
 * fuorviante, non un'azione.
 */

const DAY_MS = 24 * 60 * 60_000;

/** Turni del run della nota: è solo testo. */
const RELEASE_MAX_TURNS = 3;

export type ReleaseItemOutcome =
  /** Nota scritta, elemento chiuso nella stessa transazione dell'inserimento. `notes`/`pageId` null: solo rumore, nessuna pagina. */
  | { status: "done"; notes: ReleaseNotes | null; pageId: string | null }
  | { status: "unavailable"; reason: EmptyReason | "all_limited_now" }
  | { status: "failed"; error: string };

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function stringOrNull(v: unknown): string | null {
  return typeof v === "string" && v !== "" ? v : null;
}

/**
 * Accoda l'elemento `release` della notte, se c'è un intervallo nuovo: chiave
 * `<releaseFrom>..<toSha>` (D1), payload coi SOLI commit dell'intervallo.
 * DENTRO il serializer (legge il mirror con `skipFetch` quando la nota parte
 * da un punto diverso dal segnalibro). Nessun commit → nessun elemento.
 * Restituisce la chiave accodata (anche se c'era già), o null.
 */
export async function enqueueReleaseItem(
  deps: NightlyDeps,
  repo: NightlyRepo,
  plan: DocsPlan,
  night: string,
): Promise<string | null> {
  const [last] = await deps.db
    .select({ payload: nightlyItems.payload })
    .from(nightlyItems)
    .where(and(eq(nightlyItems.repositoryId, repo.repositoryId), eq(nightlyItems.phase, "release")))
    .orderBy(desc(nightlyItems.createdAt))
    .limit(1);
  const releaseFrom = stringOrNull(last?.payload.toSha) ?? plan.fromSha;
  if (releaseFrom === plan.toSha) return null;

  let commits = plan.commits;
  if (releaseFrom !== plan.fromSha) {
    const now = deps.now?.() ?? new Date();
    const since = new Date(now.getTime() - deps.config.summaryWindowDays * DAY_MS);
    const listed = await deps.mirrors.listDefaultBranchCommitsSince(repo.project, releaseFrom, since, {
      skipFetch: true,
    });
    if (listed.fallback) {
      deps.log(
        `[stubwise-worker] notte: l'ultima nota di rilascio di ${repo.repositoryName} (${releaseFrom}) non è più nel branch di default: la nota copre i commit degli ultimi ${deps.config.summaryWindowDays} giorni`,
      );
    }
    commits = listed.commits;
  }
  if (commits.length === 0) return null;

  const key = `${releaseFrom ?? ""}..${plan.toSha}`;
  await enqueueItems(
    deps.db,
    [
      {
        repositoryId: repo.repositoryId,
        projectId: repo.projectId,
        phase: "release",
        key,
        payload: { fromSha: releaseFrom, toSha: plan.toSha, commits },
      },
    ],
    night,
  );
  return key;
}

async function loadExistingPages(db: Db, repositoryId: string) {
  const [row] = await db
    .select({ generationId: repositories.currentDocGenerationId })
    .from(repositories)
    .where(eq(repositories.id, repositoryId));
  return row?.generationId ? loadPageRefs(db, row.generationId) : [];
}

/**
 * Scrive la nota di un elemento `release` GIÀ reclamato. `done` → la pagina
 * `releases` è inserita (slug unico, `generationId` null) e l'elemento chiuso
 * nella STESSA transazione (col `pageId` nel payload, per completare i link a
 * fine fase 4). `unavailable`/`failed` non toccano la coda: `releaseItem` /
 * `failItem` li decide il chiamante (un limite dell'auth del container è
 * un'attesa di quota, R1). Un intervallo di solo rumore chiude l'elemento senza
 * run né pagina.
 */
export async function runReleaseItem(
  deps: NightlyDeps,
  repo: NightlyRepo,
  item: NightlyItem,
): Promise<ReleaseItemOutcome> {
  const toSha = stringOrNull(item.payload.toSha);
  const commits = Array.isArray(item.payload.commits)
    ? item.payload.commits.filter((c): c is string => typeof c === "string")
    : [];
  if (toSha === null || commits.length === 0) return { status: "failed", error: "payload della nota non valido" };

  const rows = await deps.db
    .select({
      sha: commitSummaries.sha,
      subject: commitSummaries.subject,
      summary: commitSummaries.summary,
      files: commitSummaries.files,
      noise: commitSummaries.noise,
    })
    .from(commitSummaries)
    .where(and(eq(commitSummaries.repositoryId, repo.repositoryId), inArray(commitSummaries.sha, commits)));
  if (rows.length === 0) return { status: "failed", error: "nessun riassunto per i commit della nota" };
  if (rows.length < commits.length) {
    deps.log(
      `[stubwise-worker] notte: nota di ${repo.repositoryName} ${item.key}: ${commits.length - rows.length} commit senza riassunto, esclusi`,
    );
  }
  const bySha = new Map(rows.map((r) => [r.sha, r]));
  const material = commits
    .map((sha) => bySha.get(sha))
    .filter((r): r is NonNullable<typeof r> => r !== undefined && !r.noise)
    .map((r) => ({ ...r, files: r.files.filter((f) => !isNoise(f)) }))
    .filter((r) => r.files.length > 0);

  if (material.length === 0) {
    await completeWith(deps.db, item.id, item.payload, null);
    deps.log(`[stubwise-worker] notte: nota di ${repo.repositoryName} ${item.key}: solo rumore, nessuna pagina`);
    return { status: "done", notes: null, pageId: null };
  }

  const changedFiles = [...new Set(material.flatMap((r) => r.files))];
  const refs = await loadExistingPages(deps.db, repo.repositoryId);
  const existingPages: ExistingPage[] = refs.map((p) => ({ slug: p.slug, title: p.title, sourcePath: p.sourcePath }));
  const { newAreas } = mapAffectedPages(changedFiles, refs, Number.MAX_SAFE_INTEGER);
  const prompt = buildReleasePrompt({
    changedFiles,
    commitSubjects: material.map((r) => r.subject),
    existingPages,
    newAreas,
    commitSummaries: material.map((r) => ({ sha: r.sha, subject: r.subject, summary: r.summary })),
  });

  let run;
  try {
    run = await runWithProviders(
      deps.select,
      { projectId: repo.projectId, workClass: "background" },
      (provider) =>
        runAgentTextRaw(deps.runner, {
          prompt,
          model: deps.config.releaseNotesModel,
          maxTurns: RELEASE_MAX_TURNS,
          timeoutMs: deps.config.docAgentTimeoutMs,
          ...(provider !== undefined ? { provider } : {}),
        }),
      limitTextOfRun,
    );
  } catch (err) {
    return { status: "failed", error: `run della nota fallito: ${errText(err)}` };
  }
  if (run.kind === "legacy_limited") return { status: "unavailable", reason: "all_limited_now" };
  if (run.kind === "unavailable") return { status: "unavailable", reason: run.reason };

  const text = textFromRun(run.value);
  const notes = text === null ? null : parseReleaseNotes(text);
  if (notes === null) {
    deps.log(`[stubwise-worker] notte: nota di ${repo.repositoryName} ${item.key}: output non valido`);
    return {
      status: "failed",
      error:
        text === null
          ? `run della nota senza testo utile (exit ${run.value.exitCode})`
          : "output della nota senza i marcatori del contratto",
    };
  }

  const now = deps.now?.() ?? new Date();
  const slug = await uniqueReleaseSlug(deps.db, repo.repositoryId, toSha, now);
  const links = buildRelatedLinks(notes.affectedSlugs, existingPages);
  const pageId = await deps.db.transaction(async (tx) => {
    const [page] = await tx
      .insert(docPages)
      .values({
        repositoryId: repo.repositoryId,
        generationId: null,
        kind: "releases",
        isManual: false,
        slug,
        title: notes.title,
        parentId: null,
        position: -Math.floor(now.getTime() / 1000),
        sourcePath: null,
        body: notes.body,
        significant: notes.significant,
        links: links.length > 0 ? links : null,
      })
      .returning({ id: docPages.id });
    await completeWith(tx as unknown as Db, item.id, item.payload, page!.id);
    return page!.id;
  });
  deps.log(
    `[stubwise-worker] notte: nota di rilascio '${slug}' di ${repo.repositoryName} (${material.length} commit, significant=${notes.significant})`,
  );
  return { status: "done", notes, pageId };
}

/** Chiude l'elemento `release` registrando la pagina scritta (null: nessuna). */
async function completeWith(
  db: Db,
  id: string,
  payload: Record<string, unknown>,
  pageId: string | null,
): Promise<void> {
  await db
    .update(nightlyItems)
    .set({ status: "done", claimedAt: null, payload: { ...payload, pageId }, updatedAt: sql`now()` })
    .where(eq(nightlyItems.id, id));
}
