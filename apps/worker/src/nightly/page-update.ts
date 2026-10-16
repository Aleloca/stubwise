import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  commitSummaries,
  docChunks,
  docGenerations,
  docPagePendingCommits,
  docPages,
  nightlyItems,
  repositories,
  type Db,
} from "@stubwise/db";
import {
  buildRefreshPagePrompt,
  buildSecretsAuditPrompt,
  parseProductGuideOutput,
  parseRefreshedPage,
  parseSecretsAuditOutput,
  PRODUCT_PAGE_END_MARKER,
  PRODUCT_PAGE_START_MARKER,
  REFRESH_NO_CHANGE_MARKER,
  type BriefConfidentialFact,
  type ProjectBrief,
} from "@stubwise/docs-engine";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { ruleSafeFiles, scopedFileReadTools, sensitiveReadDenyRules } from "../agent/read-scope.js";
import { runAgentTextRaw, textFromRun } from "../agent/text.js";
import { EMBED_BATCH_SIZE, embedAndStoreChunks } from "../docs/embed.js";
import { limitTextOfRun, runWithProviders, type EmptyReason } from "../providers/select.js";
import { SUPERSEDED_BY_GENERATION, type DocsPlan } from "./plan.js";
import type { NightlyItem } from "./queue.js";
import { appendRelatedLinks } from "./release-page.js";
import type { NightlyDeps, NightlyRepo } from "./types.js";

/**
 * Fase 4 del giro notturno (Piano B, Task B7): l'aggiornamento di UNA pagina
 * candidata (`page_update`) e l'avanzamento del segnalibro dei Docs.
 *
 * Riscrive per un elemento singolo i pezzi di `docs/auto-update.ts`
 * (`refreshAffectedPagesInWorktree`, `guardRefreshedProductBody`,
 * `loadConfidentialFacts`), che resta com'è fino alla rimozione (B11). Le
 * differenze, tutte volute:
 *
 * - **Allowlist CHIUSA per file** (D13): l'agente legge SOLO i file del payload,
 *   calcolati da `planPages`. `permissionMode: "default"`, NON la plan mode (il
 *   golden `refine-read-plan` ha misurato che in plan mode la restrizione di
 *   lettura non regge); `allowedTools` = una regola `Read`/`Grep` per file
 *   (`scopedFileReadTools`), `disallowedTools` = `sensitiveReadDenyRules()`,
 *   nessun tool di scrittura (l'output è il corpo a marcatori). Il run gira in
 *   una cwd VUOTA a parte, non nel worktree: il CLI concede senza regole le
 *   letture sotto la cwd, e con la cwd nel worktree l'allowlist per file non
 *   chiuderebbe niente.
 * - **Account**: `runWithProviders` `background` sulla scelta del progetto
 *   (R18: il pin della generazione non vale qui); un limite dell'auth del
 *   container (`legacy_limited`) è un'attesa di quota (R1), mai un fallimento.
 * - **Un output senza marcatori è un fallimento**, non un «nessun cambiamento»:
 *   qui chiudere l'elemento vuol dire dichiarare la pagina allineata ai commit
 *   (cancella le righe `doc_page_pending_commits`, D31, e lascia avanzare il
 *   segnalibro), quindi l'esito ambiguo si riprova invece di passare per buono.
 *   Stessa ragione per la guardia `product`: bocciata → fallimento contato (alla
 *   terza notte escalation, e l'avviso «superata» resta sulla pagina), non
 *   un'uscita silenziosa come nell'auto-update.
 */

export type PageUpdateOutcome =
  | "updated"
  | "unchanged"
  | { unavailable: EmptyReason | "all_limited_now" }
  | { failed: string };

/** Turni del run di audit dei segreti: è solo testo. */
const AUDIT_MAX_TURNS = 3;

interface PageUpdatePayload {
  generationId: string | null;
  pageId: string;
  toSha: string | null;
  files: string[];
  commits: string[];
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function stringList(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

function readPayload(payload: Record<string, unknown>): PageUpdatePayload | null {
  const pageId = payload.pageId;
  if (typeof pageId !== "string" || pageId === "") return null;
  return {
    generationId: typeof payload.generationId === "string" ? payload.generationId : null,
    pageId,
    toSha: typeof payload.toSha === "string" ? payload.toSha : null,
    files: stringList(payload.files),
    commits: stringList(payload.commits),
  };
}

/**
 * Chiude l'elemento `done` e, nella STESSA transazione, cancella le righe
 * `doc_page_pending_commits` della pagina con sha fra i commit del payload (D31):
 * solo ciò che questo run ha visto, un'escalation arrivata dopo la
 * pianificazione resta. `outcome` e `resultPageId` finiscono nel payload: la fine
 * della fase legge da lì quali pagine linkare dalla nota (`appendRelatedLinks`).
 */
async function closeItem(
  tx: Db,
  item: NightlyItem,
  p: PageUpdatePayload,
  outcome: "updated" | "unchanged",
): Promise<void> {
  if (p.commits.length > 0) {
    await tx
      .delete(docPagePendingCommits)
      .where(and(eq(docPagePendingCommits.pageId, p.pageId), inArray(docPagePendingCommits.sha, p.commits)));
  }
  await tx
    .update(nightlyItems)
    .set({
      status: "done",
      claimedAt: null,
      payload: { ...item.payload, outcome, ...(outcome === "updated" ? { resultPageId: p.pageId } : {}) },
      updatedAt: sql`now()`,
    })
    .where(eq(nightlyItems.id, item.id));
}

/** Chiude l'elemento senza run e senza toccare pagina né righe pendenti (motivo in `last_error`). */
async function closeWithoutRun(db: Db, item: NightlyItem, reason: string): Promise<void> {
  await db
    .update(nightlyItems)
    .set({ status: "done", claimedAt: null, lastError: reason, updatedAt: sql`now()` })
    .where(eq(nightlyItems.id, item.id));
}

/** I fatti riservati del brief della generazione (vuoto se assenti o illeggibili). */
async function loadConfidentialFacts(db: Db, generationId: string): Promise<BriefConfidentialFact[]> {
  try {
    const [row] = await db
      .select({ brief: docGenerations.brief })
      .from(docGenerations)
      .where(eq(docGenerations.id, generationId));
    const brief = (row?.brief ?? null) as ProjectBrief | null;
    return brief?.confidentialFacts ?? [];
  } catch {
    return [];
  }
}

/** Una GUIDA product ha le due sezioni cardine (`### Goal`, `### Steps`). */
function looksLikeProductGuide(body: string): boolean {
  const lines = body.split("\n");
  const has = (heading: string): boolean => lines.some((l) => l.trim() === heading);
  return has("### Goal") && has("### Steps");
}

/**
 * Guardia di una pagina `product` rinfrescata (come l'auto-update): una guida si
 * ri-valida con gli ancoraggi di navigazione; coi fatti riservati del brief il
 * corpo passa dall'audit dei segreti (run di solo testo, cwd vuota sua). Senza
 * fatti non c'è violazione definibile: si logga e si procede (fail-open
 * dichiarato, come oggi). Un audit non eseguibile è fail-closed.
 */
async function guardProductBody(
  deps: NightlyDeps,
  repo: NightlyRepo,
  page: { slug: string; title: string; generationId: string | null },
  body: string,
): Promise<"ok" | { rejected: string } | { unavailable: EmptyReason | "all_limited_now" }> {
  if (looksLikeProductGuide(body)) {
    const wrapped = [PRODUCT_PAGE_START_MARKER, body, PRODUCT_PAGE_END_MARKER].join("\n");
    if (!("body" in parseProductGuideOutput(wrapped))) {
      return { rejected: "guida product rinfrescata senza ancoraggi di navigazione validi" };
    }
  }
  const facts = page.generationId ? await loadConfidentialFacts(deps.db, page.generationId) : [];
  if (facts.length === 0) {
    deps.log(
      `[stubwise-worker] notte: pagina product '${page.slug}' di ${repo.repositoryName} rinfrescata SENZA verifica segreti (nessun fatto riservato nel brief)`,
    );
    return "ok";
  }
  let run;
  try {
    run = await runWithProviders(
      deps.select,
      { projectId: repo.projectId, workClass: "background" },
      (provider) =>
        runAgentTextRaw(deps.runner, {
          prompt: buildSecretsAuditPrompt({ pageTitle: page.title, body, confidentialFacts: facts }),
          model: deps.config.docsNightlyModel,
          maxTurns: AUDIT_MAX_TURNS,
          timeoutMs: deps.config.docAgentTimeoutMs,
          ...(provider !== undefined ? { provider } : {}),
        }),
      limitTextOfRun,
    );
  } catch (err) {
    return { rejected: `audit dei segreti non eseguibile (${errText(err)})` };
  }
  if (run.kind === "legacy_limited") return { unavailable: "all_limited_now" };
  if (run.kind === "unavailable") return { unavailable: run.reason };
  const text = textFromRun(run.value);
  if (text === null) return { rejected: `audit dei segreti senza esito (exit ${run.value.exitCode})` };
  const verdict = parseSecretsAuditOutput(text);
  if (verdict.verdict !== "clean") return { rejected: `bocciata dal verificatore segreti (${verdict.detail})` };
  return "ok";
}

/**
 * Aggiorna la pagina di un elemento `page_update` GIÀ reclamato, leggendo dal
 * worktree `worktreeDir` (aperto al `toSha` dall'orchestratore, riusato da tutte
 * le pagine del repository). `updated`/`unchanged` chiudono l'elemento (e
 * cancellano le righe pendenti della pagina viste dal run, D31) nella stessa
 * transazione che, per `updated`, salva il corpo e ri-embedda i chunk.
 * `unavailable`/`failed` non toccano la coda: `releaseItem`/`failItem` li decide
 * il chiamante.
 *
 * Chiusi senza run: un elemento di una generazione che non è più la corrente
 * (`superseded_by_generation`, D32), una pagina sparita, e un payload senza file
 * né commit (niente da leggere né da raccontare: `unchanged`).
 */
export async function runPageUpdateItem(
  deps: NightlyDeps,
  repo: NightlyRepo,
  worktreeDir: string,
  item: NightlyItem,
): Promise<PageUpdateOutcome> {
  const p = readPayload(item.payload);
  if (p === null) return { failed: "payload del page_update non valido" };

  const [repoRow] = await deps.db
    .select({ currentGenerationId: repositories.currentDocGenerationId })
    .from(repositories)
    .where(eq(repositories.id, repo.repositoryId));
  if ((repoRow?.currentGenerationId ?? null) !== p.generationId) {
    await closeWithoutRun(deps.db, item, SUPERSEDED_BY_GENERATION);
    return "unchanged";
  }

  const [page] = await deps.db
    .select({
      id: docPages.id,
      slug: docPages.slug,
      title: docPages.title,
      body: docPages.body,
      kind: docPages.kind,
      sourcePath: docPages.sourcePath,
      generationId: docPages.generationId,
    })
    .from(docPages)
    .where(eq(docPages.id, p.pageId));
  // Una pagina sparita, o non più di una generazione (manuale): niente da aggiornare.
  if (!page || page.generationId === null) {
    await closeWithoutRun(deps.db, item, "page_gone");
    return "unchanged";
  }
  const generationId = page.generationId;

  if (p.files.length === 0 && p.commits.length === 0) {
    await deps.db.transaction(async (tx) => closeItem(tx as unknown as Db, item, p, "unchanged"));
    return "unchanged";
  }

  // Riassunti dei commit del payload, nell'ordine del payload (dal più recente).
  const rows =
    p.commits.length > 0
      ? await deps.db
          .select({ sha: commitSummaries.sha, subject: commitSummaries.subject, summary: commitSummaries.summary })
          .from(commitSummaries)
          .where(and(eq(commitSummaries.repositoryId, repo.repositoryId), inArray(commitSummaries.sha, p.commits)))
      : [];
  const bySha = new Map(rows.map((r) => [r.sha, r]));
  const summaries = p.commits.map((s) => bySha.get(s)).filter((r): r is NonNullable<typeof r> => r !== undefined);

  const readable = ruleSafeFiles(p.files);
  const prompt = buildRefreshPagePrompt({
    title: page.title,
    sourcePath: page.sourcePath,
    currentBody: page.body,
    changedFiles: p.files,
    commitSubjects: summaries.map((s) => s.subject),
    commitSummaries: summaries,
    readableFiles: readable.map((f) => join(worktreeDir, f)),
  });

  // Cwd VUOTA a parte: con la cwd nel worktree il CLI concederebbe ogni lettura
  // sotto di essa, e l'allowlist per file non chiuderebbe niente.
  const cwd = await mkdtemp(join(tmpdir(), "stubwise-nightly-page-"));
  let run;
  try {
    run = await runWithProviders(
      deps.select,
      { projectId: repo.projectId, workClass: "background" },
      (provider) =>
        deps.runner.run({
          cwd,
          prompt,
          model: deps.config.docsNightlyModel,
          permissionMode: "default",
          allowedTools: scopedFileReadTools(worktreeDir, readable),
          disallowedTools: sensitiveReadDenyRules(),
          maxTurns: deps.config.docModuleMaxTurns,
          timeoutMs: deps.config.docAgentTimeoutMs,
          ...(provider !== undefined ? { provider } : {}),
        }),
      limitTextOfRun,
    );
  } catch (err) {
    return { failed: `run della pagina fallito: ${errText(err)}` };
  } finally {
    await rm(cwd, { recursive: true, force: true }).catch(() => undefined);
  }
  if (run.kind === "legacy_limited") return { unavailable: "all_limited_now" };
  if (run.kind === "unavailable") return { unavailable: run.reason };

  const result = run.value;
  if (result.exitCode !== 0) return { failed: `run della pagina terminato con exit ${result.exitCode}` };
  const parsed = parseRefreshedPage(result.output);
  if (parsed.kind === "unchanged") {
    const explicit = result.output.split("\n").some((l) => l.trim() === REFRESH_NO_CHANGE_MARKER);
    if (!explicit) return { failed: "output della pagina senza i marcatori del contratto" };
    await deps.db.transaction(async (tx) => closeItem(tx as unknown as Db, item, p, "unchanged"));
    deps.log(`[stubwise-worker] notte: pagina '${page.slug}' di ${repo.repositoryName}: nessun cambiamento`);
    return "unchanged";
  }

  if (page.kind === "product") {
    const guard = await guardProductBody(deps, repo, page, parsed.body);
    if (guard !== "ok") {
      if ("unavailable" in guard) return guard;
      deps.log(
        `[stubwise-worker] notte: pagina product '${page.slug}' di ${repo.repositoryName} NON aggiornata: ${guard.rejected}`,
      );
      return { failed: `guardia product: ${guard.rejected}` };
    }
  }

  try {
    await deps.db.transaction(async (tx) => {
      await tx.update(docPages).set({ body: parsed.body }).where(eq(docPages.id, page.id));
      await tx.delete(docChunks).where(eq(docChunks.pageId, page.id));
      await embedAndStoreChunks(tx, deps.embeddingClient, {
        repositoryId: repo.repositoryId,
        generationId,
        pages: [{ id: page.id, body: parsed.body, kind: page.kind, sourcePath: page.sourcePath }],
        batchSize: EMBED_BATCH_SIZE,
      });
      await closeItem(tx as unknown as Db, item, p, "updated");
    });
  } catch (err) {
    return { failed: `salvataggio della pagina fallito: ${errText(err)}` };
  }
  deps.log(`[stubwise-worker] notte: pagina '${page.slug}' di ${repo.repositoryName} aggiornata`);
  return "updated";
}

/**
 * Il segnalibro dei Docs (Global Constraints, D4, D10, D32). Avanza quando il
 * repository non ha più `page_update`/`page_create` `pending` (gli `escalated`
 * non contano: dopo 3 notti il segnalibro passa oltre) E nessun commit del piano
 * ha ancora un elemento `summary` `pending` (senza riassunto un commit non
 * avrebbe `on_default_branch` né l'avviso «superata»; l'attesa è limitata dalle
 * 3 notti di escalation del riassunto). Allora, in UNA transazione e solo se
 * `plan.generationId` è ancora la generazione corrente (riga del repository
 * bloccata, così uno SWAP concorrente non passa in mezzo: altrimenti 0
 * scritture e il segnalibro della generazione nuova non va all'indietro):
 * `doc_generations.commit_sha = toSha` e `documented_at = now()` sui riassunti
 * in produzione dei commit del piano. Poi completa i link «related» delle note
 * di questo `toSha` con le pagine aggiornate o create (best-effort).
 *
 * NON tocca `doc_page_pending_commits`: le righe di una pagina in escalation
 * restano (l'avviso resta su di lei, D31). Restituisce se ha avanzato.
 */
export async function advanceBookmarkIfDone(deps: NightlyDeps, repo: NightlyRepo, plan: DocsPlan): Promise<boolean> {
  const [pages] = await deps.db
    .select({ n: sql<number>`count(*)::int` })
    .from(nightlyItems)
    .where(
      and(
        eq(nightlyItems.repositoryId, repo.repositoryId),
        inArray(nightlyItems.phase, ["page_update", "page_create"]),
        eq(nightlyItems.status, "pending"),
      ),
    );
  if ((pages?.n ?? 0) > 0) return false;
  if (plan.commits.length > 0) {
    const [summaries] = await deps.db
      .select({ n: sql<number>`count(*)::int` })
      .from(nightlyItems)
      .where(
        and(
          eq(nightlyItems.repositoryId, repo.repositoryId),
          eq(nightlyItems.phase, "summary"),
          eq(nightlyItems.status, "pending"),
          inArray(nightlyItems.key, plan.commits),
        ),
      );
    if ((summaries?.n ?? 0) > 0) return false;
  }

  const advanced = await deps.db.transaction(async (tx) => {
    const [row] = await tx
      .select({ current: repositories.currentDocGenerationId })
      .from(repositories)
      .where(eq(repositories.id, repo.repositoryId))
      .for("update");
    if ((row?.current ?? null) !== plan.generationId) return false;
    await tx.update(docGenerations).set({ commitSha: plan.toSha }).where(eq(docGenerations.id, plan.generationId));
    if (plan.commits.length > 0) {
      await tx
        .update(commitSummaries)
        .set({ documentedAt: sql`now()` })
        .where(
          and(
            eq(commitSummaries.repositoryId, repo.repositoryId),
            eq(commitSummaries.onDefaultBranch, true),
            isNull(commitSummaries.documentedAt),
            inArray(commitSummaries.sha, plan.commits),
          ),
        );
    }
    return true;
  });
  if (!advanced) {
    deps.log(
      `[stubwise-worker] notte: segnalibro di ${repo.repositoryName} non avanzato: la generazione ${plan.generationId} non è più la corrente`,
    );
    return false;
  }
  deps.log(`[stubwise-worker] notte: segnalibro dei Docs di ${repo.repositoryName} avanzato a ${plan.toSha}`);

  try {
    await linkNightPagesFromNotes(deps.db, repo.repositoryId, plan.toSha);
  } catch (err) {
    deps.log(
      `[stubwise-worker] notte: link «related» delle note di ${repo.repositoryName} non completati (${errText(err)})`,
    );
  }
  return true;
}

/**
 * Le pagine aggiornate o create per questo `toSha` (`resultPageId` nel payload
 * degli elementi chiusi) entrano nei link «related» di ogni nota di rilascio
 * che finisce a questo `toSha`.
 */
async function linkNightPagesFromNotes(db: Db, repositoryId: string, toSha: string): Promise<void> {
  const notes = await db
    .select({ pageId: sql<string | null>`${nightlyItems.payload} ->> 'pageId'` })
    .from(nightlyItems)
    .where(
      and(
        eq(nightlyItems.repositoryId, repositoryId),
        eq(nightlyItems.phase, "release"),
        eq(nightlyItems.status, "done"),
        sql`${nightlyItems.payload} ->> 'toSha' = ${toSha}`,
      ),
    );
  const notePageIds = notes.map((n) => n.pageId).filter((id): id is string => typeof id === "string" && id !== "");
  if (notePageIds.length === 0) return;
  const results = await db
    .select({ pageId: sql<string | null>`${nightlyItems.payload} ->> 'resultPageId'` })
    .from(nightlyItems)
    .where(
      and(
        eq(nightlyItems.repositoryId, repositoryId),
        inArray(nightlyItems.phase, ["page_update", "page_create"]),
        eq(nightlyItems.status, "done"),
        sql`${nightlyItems.payload} ->> 'toSha' = ${toSha}`,
        sql`${nightlyItems.payload} ->> 'resultPageId' IS NOT NULL`,
      ),
    );
  const ids = [...new Set(results.map((r) => r.pageId).filter((id): id is string => typeof id === "string"))];
  if (ids.length === 0) return;
  const pages = await db
    .select({ id: docPages.id, slug: docPages.slug, title: docPages.title })
    .from(docPages)
    .where(inArray(docPages.id, ids));
  const ordered = ids
    .map((id) => pages.find((p) => p.id === id))
    .filter((p): p is NonNullable<typeof p> => p !== undefined);
  for (const noteId of notePageIds) await appendRelatedLinks(db, noteId, ordered);
}
