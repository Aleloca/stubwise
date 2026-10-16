import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commitSummaries, docGenerations, docPages, nightlyItems, repositories, type Db } from "@stubwise/db";
import {
  buildExplorePrompt,
  buildGrowOrientPrompt,
  hasNoProposalMarker,
  parseExploreOutput,
  parseGrowOrientOutput,
  pathCovers,
  resolveGrowSourcePaths,
  slugForNode,
  type GrowExistingPage,
  type GrowProposal,
  type NewArea,
  type NightlyCommitSummary,
} from "@stubwise/docs-engine";
import { and, arrayOverlaps, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { AgentRunResult } from "../agent/runner.js";
import { ruleSafeFiles, scopedFileReadTools, sensitiveReadDenyRules } from "../agent/read-scope.js";
import { EMBED_BATCH_SIZE, embedAndStoreChunks } from "../docs/embed.js";
import { limitTextOfRun, runWithProviders, type EmptyReason } from "../providers/select.js";
import { closeWithoutRun } from "./page-update.js";
import { SUPERSEDED_BY_GENERATION } from "./plan.js";
import type { NightlyItem } from "./queue.js";
import type { NightlyDeps, NightlyRepo } from "./types.js";

/**
 * Fase 4 del giro notturno, pagine NUOVE (Piano B, Task B8, D12): un elemento
 * `page_create` è UN'area aggregata (`aggregateNewAreas`, accodata da
 * `planPages`) e diventa una o più pagine della generazione corrente.
 *
 * Riscrive per un'area sola la sequenza di `growNewAreaPages`/`applyGrowStats`
 * di `docs/auto-update.ts` (che resta com'è fino alla rimozione, B11). Le
 * differenze, tutte volute:
 *
 * - **Un mini-orient PER AREA**, non uno per tutte: nessun tetto (niente
 *   `maxPages` nel prompt, niente `slice`). Il parser tiene il suo tetto
 *   difensivo di proposte, che qui vale per area.
 * - **Allowlist CHIUSA sui file dell'area** (come B7): orient ed explore girano
 *   in una cwd VUOTA a parte, `permissionMode: "default"`, `allowedTools` = una
 *   regola `Read`/`Grep` per file (`scopedFileReadTools`), `disallowedTools` =
 *   `sensitiveReadDenyRules()`. Account dalla scelta del progetto
 *   (`runWithProviders` `background`, R18), modello `DOCS_NIGHTLY_MODEL`; un
 *   limite dell'auth del container è un'attesa di quota (R1).
 * - **Tutto o niente**: prima tutti i run (orient + un explore per proposta),
 *   poi UNA transazione che inserisce le pagine, ne embedda i chunk, aggiorna
 *   stats e costo della generazione e chiude l'elemento. Un limite a metà non
 *   lascia pagine parziali: l'elemento torna `pending` (lo decide il chiamante).
 * - **Guardia `product`**: le pagine create qui sono solo `technical` o
 *   `functional` (il parser dell'orient scarta ogni altro kind), quindi la
 *   guardia delle pagine `product` di B7 non ha nulla da guardare.
 * - Il `sourcePath` persistito è l'area quando una proposta sola la copre
 *   (`resolveGrowSourcePaths`): la notte dopo `mapAffectedPages` la vede coperta
 *   e l'area non torna fra le nuove.
 */

export type PageCreateOutcome =
  | "created"
  /** Chiuso `done` senza pagine: generazione sostituita, area già coperta, o l'orient DICHIARA che nessuna merita (`GROW_NO_PROPOSAL_MARKER`). */
  | "skipped"
  | { unavailable: EmptyReason | "all_limited_now" }
  | { failed: string };

interface PageCreatePayload {
  generationId: string | null;
  area: string;
  files: string[];
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function readPayload(payload: Record<string, unknown>): PageCreatePayload | null {
  const area = payload.area;
  if (typeof area !== "string" || area === "") return null;
  const files = Array.isArray(payload.files)
    ? payload.files.filter((x): x is string => typeof x === "string" && x !== "")
    : [];
  if (files.length === 0) return null;
  return {
    generationId: typeof payload.generationId === "string" ? payload.generationId : null,
    area,
    files,
  };
}

/** Radici della generazione + i loro figli diretti: i genitori fra cui l'orient sceglie. */
export async function loadTreeContext(db: Db, generationId: string): Promise<GrowExistingPage[]> {
  const roots = await db
    .select({ id: docPages.id, slug: docPages.slug, title: docPages.title, kind: docPages.kind })
    .from(docPages)
    .where(and(eq(docPages.generationId, generationId), isNull(docPages.parentId)))
    .orderBy(docPages.position);
  const rootIds = roots.map((r) => r.id);
  const children =
    rootIds.length > 0
      ? await db
          .select({ slug: docPages.slug, title: docPages.title, kind: docPages.kind })
          .from(docPages)
          .where(and(eq(docPages.generationId, generationId), inArray(docPages.parentId, rootIds)))
          .orderBy(docPages.position)
      : [];
  return [...roots, ...children].map((p) => ({ slug: p.slug, title: p.title, kind: p.kind }));
}

/**
 * Riassunti dei commit in attesa del segnalibro che toccano i file dell'area, dal
 * più recente (il prompt ne elenca al massimo 200 e dichiara il resto, D27).
 */
async function loadAreaSummaries(db: Db, repositoryId: string, files: string[]): Promise<NightlyCommitSummary[]> {
  return db
    .select({ sha: commitSummaries.sha, subject: commitSummaries.subject, summary: commitSummaries.summary })
    .from(commitSummaries)
    .where(
      and(
        eq(commitSummaries.repositoryId, repositoryId),
        eq(commitSummaries.onDefaultBranch, true),
        isNull(commitSummaries.documentedAt),
        arrayOverlaps(commitSummaries.files, files),
      ),
    )
    .orderBy(desc(commitSummaries.committedAt));
}

/** I `sourcePaths` di una proposta che stanno DENTRO l'area (il resto non è suo da documentare). */
function inArea(area: string, paths: string[]): string[] {
  return paths.filter((p) => pathCovers(area, p));
}

type Run = { ok: AgentRunResult } | { unavailable: EmptyReason | "all_limited_now" } | { failed: string };

/**
 * Crea le pagine di un elemento `page_create` GIÀ reclamato, leggendo dal worktree
 * `worktreeDir` (aperto al `toSha` dall'orchestratore). `created`/`skipped`
 * chiudono l'elemento; `unavailable`/`failed` non toccano né coda né pagine:
 * `releaseItem`/`failItem` li decide il chiamante. `resultPageId` (la prima
 * pagina) e `resultPageIds` finiscono nel payload: la fine della fase linka da lì
 * le pagine della notte dalla nota (`advanceBookmarkIfDone`).
 */
export async function runPageCreateItem(
  deps: NightlyDeps,
  repo: NightlyRepo,
  worktreeDir: string,
  item: NightlyItem,
): Promise<PageCreateOutcome> {
  const p = readPayload(item.payload);
  if (p === null) return { failed: "payload del page_create non valido" };

  const [repoRow] = await deps.db
    .select({ currentGenerationId: repositories.currentDocGenerationId })
    .from(repositories)
    .where(eq(repositories.id, repo.repositoryId));
  const generationId = repoRow?.currentGenerationId ?? null;
  if (generationId === null || generationId !== p.generationId) {
    await closeWithoutRun(deps.db, item, SUPERSEDED_BY_GENERATION);
    return "skipped";
  }

  // Idempotenza: se una pagina della generazione copre già ogni file dell'area
  // (creata nel frattempo), non se ne crea un'altra.
  const covering = await deps.db
    .select({ sourcePath: docPages.sourcePath })
    .from(docPages)
    .where(eq(docPages.generationId, generationId));
  const sources = covering.map((c) => c.sourcePath).filter((s): s is string => s !== null);
  if (p.files.every((f) => sources.some((s) => pathCovers(s, f)))) {
    await closeWithoutRun(deps.db, item, "area_already_covered");
    return "skipped";
  }

  // Nessun file esprimibile come regola per file: l'agente non potrebbe leggere
  // niente, quindi nessun run da pagare (si riprova, e alla terza notte escalation).
  const readable = ruleSafeFiles(p.files);
  if (readable.length === 0) {
    return { failed: `nessun file dell'area ${p.area} è leggibile con una regola per file (percorsi non sicuri)` };
  }

  const area: NewArea = { path: p.area, files: p.files };
  // Le pagine `product` (guide a struttura imposta) non fanno da genitore a una
  // pagina tecnica o funzionale creata qui: fuori sia dal prompt sia dai genitori validi.
  const treeContext = (await loadTreeContext(deps.db, generationId)).filter((t) => t.kind !== "product");
  const summaries = await loadAreaSummaries(deps.db, repo.repositoryId, p.files);
  const readableAbs = readable.map((f) => join(worktreeDir, f));
  const allowedTools = scopedFileReadTools(worktreeDir, readable);

  let cost = 0;
  const run = async (prompt: string): Promise<Run> => {
    // Cwd VUOTA a parte: con la cwd nel worktree il CLI concederebbe ogni lettura
    // sotto di essa, e l'allowlist per file non chiuderebbe niente.
    const cwd = await mkdtemp(join(tmpdir(), "stubwise-nightly-create-"));
    try {
      const r = await runWithProviders(
        deps.select,
        { projectId: repo.projectId, workClass: "background" },
        (provider) =>
          deps.runner.run({
            cwd,
            prompt,
            model: deps.config.docsNightlyModel,
            permissionMode: "default",
            allowedTools,
            disallowedTools: sensitiveReadDenyRules(),
            maxTurns: deps.config.docModuleMaxTurns,
            timeoutMs: deps.config.docAgentTimeoutMs,
            ...(provider !== undefined ? { provider } : {}),
          }),
        limitTextOfRun,
      );
      if (r.kind === "legacy_limited") return { unavailable: "all_limited_now" };
      if (r.kind === "unavailable") return { unavailable: r.reason };
      cost += r.value.usage?.totalCostUsd ?? 0;
      if (r.value.exitCode !== 0) return { failed: `run terminato con exit ${r.value.exitCode}` };
      return { ok: r.value };
    } catch (err) {
      return { failed: `run fallito: ${errText(err)}` };
    } finally {
      await rm(cwd, { recursive: true, force: true }).catch(() => undefined);
    }
  };

  // 1) Mini-orient dell'area: nessun tetto.
  const orient = await run(
    buildGrowOrientPrompt({
      areas: [area],
      existingPages: treeContext,
      commitSubjects: summaries.map((s) => s.subject),
      nightly: { readableFiles: readableAbs, commitSummaries: summaries },
    }),
  );
  if (!("ok" in orient)) {
    return "failed" in orient ? { failed: `mini-orient dell'area ${p.area}: ${orient.failed}` } : orient;
  }
  const parsedProposals = parseGrowOrientOutput(orient.ok.output);
  const proposals: GrowProposal[] = parsedProposals
    .map((prop) => ({ ...prop, sourcePaths: inArea(p.area, prop.sourcePaths) }))
    .filter((prop) => prop.sourcePaths.length > 0);
  if (proposals.length === 0) {
    // Chiudere l'elemento fa avanzare il segnalibro e l'area non torna più: lo si
    // fa SOLO sulla dichiarazione esplicita «nessuna pagina merita». Un output
    // vuoto o illeggibile, kind non validi, percorsi tutti fuori dall'area sono un
    // fallimento (si riprova; alla terza notte escalation), come in B7.
    if (parsedProposals.length === 0 && hasNoProposalMarker(orient.ok.output)) {
      await closeWithoutRun(deps.db, item, "no_page_proposed");
      deps.log(`[stubwise-worker] notte: area '${p.area}' di ${repo.repositoryName}: nessuna pagina proposta`);
      return "skipped";
    }
    return {
      failed:
        parsedProposals.length === 0
          ? `mini-orient dell'area ${p.area} senza proposte né il marcatore «nessuna proposta»`
          : `mini-orient dell'area ${p.area}: nessuna proposta con percorsi dentro l'area`,
    };
  }

  // sourcePath persistito: l'area se una proposta sola la copre (non torna «nuova»).
  const sourcePaths = resolveGrowSourcePaths([area], proposals.map((prop) => prop.sourcePaths[0]!));
  const validParents = new Set(treeContext.map((t) => t.slug));
  const existingPageTitles = treeContext.map((t) => t.title);

  // 2) Un explore per proposta, TUTTI prima di scrivere: un limite a metà non lascia pagine parziali.
  const pages: { proposal: GrowProposal; parentSlug: string | null; sourcePath: string; body: string }[] = [];
  const rejected: string[] = [];
  for (const [i, proposal] of proposals.entries()) {
    const parentSlug =
      proposal.parentSlug !== null && validParents.has(proposal.parentSlug) ? proposal.parentSlug : null;
    const parent = parentSlug !== null ? treeContext.find((t) => t.slug === parentSlug) : undefined;
    const explore = await run(
      buildExplorePrompt({
        tree: proposal.kind,
        unitRef: proposal.sourcePaths[0]!,
        title: proposal.title,
        parentContext: parent ? `${parent.title} (${parent.slug})` : "root",
        nightly: { readableFiles: readableAbs, commitSummaries: summaries, existingPageTitles },
      }),
    );
    if (!("ok" in explore)) {
      return "failed" in explore ? { failed: `pagina '${proposal.title}': ${explore.failed}` } : explore;
    }
    const parsed = parseExploreOutput(explore.ok.output);
    if ("reason" in parsed) {
      rejected.push(`'${proposal.title}' (${parsed.reason})`);
      continue;
    }
    pages.push({ proposal, parentSlug, sourcePath: sourcePaths[i] || proposal.sourcePaths[0]!, body: parsed.body });
  }
  if (pages.length === 0) return { failed: `nessuna pagina valida per l'area ${p.area}: ${rejected.join(", ")}` };
  if (rejected.length > 0) {
    deps.log(
      `[stubwise-worker] notte: area '${p.area}' di ${repo.repositoryName}: proposte scartate ${rejected.join(", ")}`,
    );
  }

  // 3) UNA transazione: pagine, chunk, stats/costo della generazione, elemento done.
  let created: { id: string; slug: string }[];
  try {
    created = await deps.db.transaction(async (tx) => {
      const used = new Set(
        (await tx.select({ slug: docPages.slug }).from(docPages).where(eq(docPages.generationId, generationId))).map(
          (r) => r.slug,
        ),
      );
      const [maxRow] = await tx
        .select({ position: docPages.position })
        .from(docPages)
        .where(eq(docPages.generationId, generationId))
        .orderBy(desc(docPages.position))
        .limit(1);
      let position = (maxRow?.position ?? -1) + 1;
      const out: { id: string; slug: string }[] = [];
      let chunks = 0;
      for (const page of pages) {
        const slug = slugForNode(page.proposal.title, used);
        used.add(slug);
        const parentId =
          page.parentSlug !== null
            ? ((
                await tx
                  .select({ id: docPages.id })
                  .from(docPages)
                  .where(and(eq(docPages.generationId, generationId), eq(docPages.slug, page.parentSlug)))
              )[0]?.id ?? null)
            : null;
        const [row] = await tx
          .insert(docPages)
          .values({
            repositoryId: repo.repositoryId,
            generationId,
            kind: page.proposal.kind,
            slug,
            title: page.proposal.title,
            parentId,
            position: position++,
            sourcePath: page.sourcePath,
            body: page.body,
          })
          .returning({ id: docPages.id });
        if (!row) throw new Error("insert della pagina senza riga");
        const { chunkCount } = await embedAndStoreChunks(tx, deps.embeddingClient, {
          repositoryId: repo.repositoryId,
          generationId,
          pages: [{ id: row.id, body: page.body, kind: page.proposal.kind, sourcePath: page.sourcePath }],
          batchSize: EMBED_BATCH_SIZE,
        });
        chunks += chunkCount;
        out.push({ id: row.id, slug });
      }
      // Le stats della generazione si scrivono alla sua finalize: qui vanno aggiornate a mano.
      await tx
        .update(docGenerations)
        .set({
          stats: sql`coalesce(${docGenerations.stats}, '{}'::jsonb) || jsonb_build_object(
            'pages', coalesce((${docGenerations.stats} ->> 'pages')::int, 0) + ${out.length}::int,
            'chunks', coalesce((${docGenerations.stats} ->> 'chunks')::int, 0) + ${chunks}::int)`,
          cost: sql`(coalesce(${docGenerations.cost}, 0) + ${cost.toFixed(6)}::numeric)`,
        })
        .where(eq(docGenerations.id, generationId));
      await tx
        .update(nightlyItems)
        .set({
          status: "done",
          claimedAt: null,
          payload: {
            ...item.payload,
            outcome: "created",
            resultPageId: out[0]!.id,
            resultPageIds: out.map((o) => o.id),
          },
          updatedAt: sql`now()`,
        })
        .where(eq(nightlyItems.id, item.id));
      return out;
    });
  } catch (err) {
    return { failed: `salvataggio delle pagine fallito: ${errText(err)}` };
  }
  deps.log(
    `[stubwise-worker] notte: area '${p.area}' di ${repo.repositoryName}: ${created.length} pagina/e nuova/e (${created.map((c) => c.slug).join(", ")})`,
  );
  return "created";
}
