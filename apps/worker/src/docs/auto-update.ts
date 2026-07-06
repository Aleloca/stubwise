import {
  decrypt,
  docChunks,
  docGenerations,
  docPages,
  gitAccounts,
  projects,
  repositories,
  type Db,
} from "@stubwise/db";
import {
  aggregateNewAreas,
  buildExplorePrompt,
  buildGrowOrientPrompt,
  buildRefreshPagePrompt,
  buildReleasePrompt,
  mapAffectedPages,
  parseExploreOutput,
  parseGrowOrientOutput,
  parseRefreshedPage,
  parseReleaseNotes,
  slugForNode,
  type ExistingPage,
  type GrowExistingPage,
  type GrowProposal,
  type PageRef,
  type ReleaseNotes,
} from "@stubwise/docs-engine";
import type { EmbeddingClient } from "@stubwise/embeddings";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { z } from "zod";
import type { AgentRunner } from "../agent/runner.js";
import type { MirrorManager, MirrorProject } from "../git/mirrors.js";
import {
  loadProviderById,
  loadProviderChain,
  type ResolvedProvider,
} from "../providers/chain.js";
import { EMBED_BATCH_SIZE, embedAndStoreChunks } from "./embed.js";

/**
 * AUTO-AGGIORNAMENTO DOCS — Fase 1 (changelog automatico).
 *
 * Quando un pending di `doc_auto_update_jobs` scade (`not_before <= now`), il poller
 * (auto-update-poller.ts) lo RECLAMA in modo atomico (DELETE ... RETURNING) e chiama
 * `runAutoUpdate` nella catena PER-REPOSITORY (serializer condiviso col fix e con la
 * doc-generation, così non si sovrappone a un fetch --prune dello stesso repository).
 *
 * Cosa fa `runAutoUpdate`:
 *  1. carica il repository (defaultBranch, currentDocGenerationId) e l'aiProviderId del
 *     suo PROGETTO;
 *  2. calcola il diff del range (file cambiati + subject dei commit) sul mirror;
 *  3. GATE RUMORE deterministico: se TUTTI i file cambiati sono rumore (lockfile,
 *     cartelle di processo/doc) o non c'è alcun file → niente agente, niente entry;
 *  4. risolve il provider (provider bloccato per id, oppure chain[0]); provider auto
 *     impostato ma non risolvibile → log e termina SENZA fallback;
 *  5. RIGENERAZIONE MIRATA (Fase 2): se abilitata (maxRefreshPages > 0) e c'è una
 *     generazione corrente, mappa i file materiali alle pagine esistenti
 *     (`mapAffectedPages` via sourcePath), apre UN worktree effimero al default branch e
 *     per ogni pagina impattata fa girare un agente di refresh read-only che riscrive il
 *     body; le pagine effettivamente aggiornate hanno il body aggiornato e i loro
 *     `doc_chunks` RI-EMBEDDATI (doc_pages non ha un commitSha per-pagina: la staleness è
 *     a livello di generazione, vedi step 8). Best-effort per pagina (un fallimento non
 *     blocca le altre né la entry). Le aree non coperte sono raccolte (`newAreas`);
 *  6. un agente di analisi (1 run, contesto TESTUALE del diff, NESSUN worktree per la
 *     entry) produce le note di rilascio col contratto a marcatori (significatività +
 *     titolo + body markdown + slug impattati); riceve anche le pagine già rigenerate e
 *     le aree nuove (campi opzionali) per coerenza del changelog;
 *  7. inserisce una pagina `doc_pages` PERSISTENTE (generationId null, come le manuali)
 *     kind="releases", con cross-link "related" = unione (slug rigenerati ∪ slug
 *     dell'agente, filtrati agli esistenti) e una sezione DETERMINISTICA di "aree nuove
 *     non documentate" (e troncamento) appesa al body quando servono;
 *  8. avanza `doc_generations.commitSha` della generazione corrente a `toSha`.
 *
 * SCELTE:
 *  - NESSUN worktree per l'agente RELEASE: il diff/commit/pagine sono passati come
 *    contesto testuale (basta, la entry non rigenera codice). La rigenerazione mirata
 *    (Fase 2) invece apre un worktree effimero per leggere il codice al toSha.
 *  - RE-EMBED delle sole pagine rigenerate (delete dei chunk vecchi + embedAndStoreChunks
 *    del nuovo body): la ricerca semantica resta allineata. La entry release NON viene
 *    embeddata (resta fuori dalla ricerca, come in Fase 1).
 *  - BEST-EFFORT / IDEMPOTENTE: il pending è GIÀ stato reclamato (rimosso) dal poller
 *    prima di chiamare l'handler. Se l'handler fallisce a metà, quel ciclo è perso ma
 *    il job NON torna in loop: il prossimo push ricreerà un pending col toSha aggiornato.
 */

/** Forma attesa delle credenziali git decifrate (mirror di orient-handler). */
const credentialsSchema = z.object({
  username: z.string().min(1).optional(),
  email: z.string().min(1).optional(),
  token: z.string().min(1),
});

/** Riga di pending reclamata dal poller, passata all'handler. */
export interface AutoUpdateJob {
  id: string;
  repositoryId: string;
  fromSha: string;
  toSha: string;
}

export interface RunAutoUpdateDeps {
  db: Db;
  mirrors: MirrorManager;
  runner: AgentRunner;
  /** Chiave AES-256 per decifrare le credenziali dell'account git. */
  encryptionKey: Buffer;
  /** Modello AI dell'agente di analisi (config.docGenerationModel). */
  model: string;
  /** Timeout (ms) del run dell'agente (config.docAgentTimeoutMs). */
  agentTimeoutMs: number;
  /** Turni massimi del run dell'agente (config.docModuleMaxTurns). */
  maxTurns: number;
  /** Client di embedding (lo stesso usato in finalize): re-embedda i chunk delle pagine
   * rigenerate in-place (Fase 2). */
  embeddingClient: EmbeddingClient;
  /** Tetto alle pagine rigenerate in-place per push (config.docsAutoUpdateMaxPages).
   * 0 = niente rigenerazione mirata, solo la entry release (comportamento Fase 1). */
  maxRefreshPages: number;
  /** Tetto alle pagine NUOVE create per aree non documentate per push
   * (config.docsAutoUpdateMaxNewPages). 0 = niente creazione incrementale (Fase 3 off). */
  maxNewPages: number;
  /** Risolutore di UN provider per id (iniettabile nei test). Default: loadProviderById. */
  loadProviderByIdFn?: (
    db: Db,
    encryptionKey: Buffer,
    id: string,
  ) => Promise<ResolvedProvider | null>;
  /** Caricatore della catena di provider (iniettabile nei test). Default: loadProviderChain. */
  loadProviderChainFn?: (db: Db, encryptionKey: Buffer) => Promise<ResolvedProvider[]>;
}

/**
 * Lockfile (changeset di solo rumore se sono i soli a cambiare): l'aggiornamento di un
 * lockfile da solo non è materiale per un changelog.
 */
const LOCKFILE_BASENAMES = new Set(["pnpm-lock.yaml", "package-lock.json", "yarn.lock"]);

/**
 * Cartelle top-level di RUMORE escluse dal changelog: gli stessi artefatti di sessione/
 * processo che l'orientamento (packages/docs-engine/src/recursive/orient.ts) esclude dal
 * tecnico — note di pianificazione, design, manuali, guide — più la cartella CI `.github`.
 * Un file sotto una di queste cartelle non è una modifica di prodotto materiale per la
 * entry release. Lista DUPLICATA volutamente (qui è un gate deterministico, non il prompt
 * dell'agente di orientamento) e tenuta in sync con quella.
 */
const NOISE_DIR_PREFIXES = [
  "plans/",
  "docs/",
  "manual/",
  "guides/",
  ".github/",
];

/**
 * true se `path` è RUMORE per il changelog: un lockfile (per basename, ovunque sia) o un
 * file annidato in una cartella di rumore (per prefisso di path normalizzato).
 */
export function isNoise(path: string): boolean {
  const normalized = path.trim().replace(/^\/+/, "");
  if (normalized === "") return true;
  const slash = normalized.lastIndexOf("/");
  const basename = slash === -1 ? normalized : normalized.slice(slash + 1);
  if (LOCKFILE_BASENAMES.has(basename)) return true;
  return NOISE_DIR_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Sha breve (7 char) per lo slug della release; tollera sha più corti. */
function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

/** Timestamp `YYYYMMDD-HHmm` (UTC) per lo slug della release. */
function timestampForSlug(now: Date): string {
  const p = (n: number): string => String(n).padStart(2, "0");
  return (
    `${now.getUTCFullYear()}${p(now.getUTCMonth() + 1)}${p(now.getUTCDate())}` +
    `-${p(now.getUTCHours())}${p(now.getUTCMinutes())}`
  );
}

/** Contesto del repository necessario all'auto-update. */
interface ProjectContext {
  mirrorProject: MirrorProject;
  aiProviderId: string | null;
  currentDocGenerationId: string | null;
}

/**
 * Carica il repository + il suo PROGETTO (per `aiProviderId`) + l'account git e decifra
 * le credenziali per costruire il MirrorProject. Il provider AI dell'auto-update è del
 * PROGETTO del repository (join repositories→projects). Ritorna null (con log) se il
 * repository/account non c'è o le credenziali non si decifrano: l'auto-update è
 * best-effort, non c'è un job da fallire.
 */
async function loadProjectContext(
  deps: RunAutoUpdateDeps,
  repositoryId: string,
): Promise<ProjectContext | null> {
  const [row] = await deps.db
    .select({
      repository: repositories,
      account: gitAccounts,
      aiProviderId: projects.aiProviderId,
    })
    .from(repositories)
    .innerJoin(gitAccounts, eq(repositories.gitAccountId, gitAccounts.id))
    .innerJoin(projects, eq(projects.id, repositories.projectId))
    .where(eq(repositories.id, repositoryId));
  if (!row) {
    console.error(
      `[stubwise-worker] auto-update: repository ${repositoryId} o account git collegato non trovato, salto`,
    );
    return null;
  }
  const { repository, account } = row;

  let credentials: z.infer<typeof credentialsSchema>;
  try {
    credentials = credentialsSchema.parse(
      JSON.parse(decrypt(account.encryptedCredentials, deps.encryptionKey)),
    );
  } catch {
    console.error(
      `[stubwise-worker] auto-update: credenziali git del repository ${repositoryId} non decifrabili, salto`,
    );
    return null;
  }

  return {
    mirrorProject: {
      provider: repository.provider,
      repoUrl: repository.repoUrl,
      defaultBranch: repository.defaultBranch,
      credentials,
    },
    aiProviderId: row.aiProviderId,
    currentDocGenerationId: repository.currentDocGenerationId,
  };
}

/** Carica le pagine esistenti della generazione corrente (contesto per l'agente + link). */
async function loadExistingPages(
  db: Db,
  generationId: string | null,
): Promise<ExistingPage[]> {
  if (generationId === null) return [];
  const rows = await db
    .select({
      slug: docPages.slug,
      title: docPages.title,
      sourcePath: docPages.sourcePath,
    })
    .from(docPages)
    .where(eq(docPages.generationId, generationId));
  return rows.map((r) => ({ slug: r.slug, title: r.title, sourcePath: r.sourcePath }));
}

/**
 * Carica le pagine della generazione corrente con `id` e `parentId` (Fase 2): servono al
 * mapping diff → pagine impattate (`mapAffectedPages`) e all'update in-place. Distinto da
 * `loadExistingPages` (che resta la forma slug/title/sourcePath per l'agente release).
 */
async function loadPagesWithRefs(db: Db, generationId: string | null): Promise<PageRef[]> {
  if (generationId === null) return [];
  const rows = await db
    .select({
      id: docPages.id,
      slug: docPages.slug,
      title: docPages.title,
      sourcePath: docPages.sourcePath,
      parentId: docPages.parentId,
    })
    .from(docPages)
    .where(eq(docPages.generationId, generationId));
  return rows.map((r) => ({
    id: r.id,
    slug: r.slug,
    title: r.title,
    sourcePath: r.sourcePath,
    parentId: r.parentId,
  }));
}

/** Corpo + kind di una pagina (caricati per il prompt di refresh e il re-embed). */
interface PageBody {
  body: string;
  kind: string;
  sourcePath: string | null;
}

/** Carica body/kind/sourcePath di una pagina per id (null se sparita nel frattempo). */
async function loadPageBody(db: Db, pageId: string): Promise<PageBody | null> {
  const [row] = await db
    .select({ body: docPages.body, kind: docPages.kind, sourcePath: docPages.sourcePath })
    .from(docPages)
    .where(eq(docPages.id, pageId));
  return row ?? null;
}

/**
 * Risolve il provider AI dell'auto-update:
 *  - con `aiProviderId`: SOLO quel provider (provider "bloccato"). Se non è
 *    risolvibile (disabilitato/cancellato/segreto non decifrabile) ritorna
 *    `{ blocked: true }` → l'handler termina SENZA fallback;
 *  - senza id (automatico): la prima voce della catena (come la generazione normale).
 *    Catena vuota → `provider` undefined (auth storica del container).
 */
async function resolveProvider(
  deps: RunAutoUpdateDeps,
  aiProviderId: string | null,
): Promise<{ provider: ResolvedProvider | undefined } | { blocked: true }> {
  if (aiProviderId) {
    const loadById = deps.loadProviderByIdFn ?? loadProviderById;
    const pinned = await loadById(deps.db, deps.encryptionKey, aiProviderId);
    if (!pinned) return { blocked: true };
    return { provider: pinned };
  }
  const loadChain = deps.loadProviderChainFn ?? loadProviderChain;
  const chain = await loadChain(deps.db, deps.encryptionKey);
  return { provider: chain[0] };
}

/**
 * Costruisce uno slug univoco per la release: `release-<YYYYMMDD-HHmm>-<shortSha>`. Se
 * collide con una pagina release già esistente (stesso minuto + stesso sha breve) appende
 * un suffisso numerico. Lo slug è univoco tra le pagine PERSISTENTI (generation_id null)
 * del repository (vincolo parziale doc_pages_manual_slug_unique).
 */
async function uniqueReleaseSlug(
  db: Db,
  repositoryId: string,
  toSha: string,
  now: Date,
): Promise<string> {
  const base = `release-${timestampForSlug(now)}-${shortSha(toSha)}`;
  let slug = base;
  let suffix = 1;
  // Loop limitato: in pratica al massimo una/due iterazioni (collisione = doppio push
  // nello stesso minuto sullo stesso sha breve, raro).
  for (let i = 0; i < 100; i++) {
    const [existing] = await db
      .select({ id: docPages.id })
      .from(docPages)
      .where(
        and(
          eq(docPages.repositoryId, repositoryId),
          eq(docPages.slug, slug),
          isNull(docPages.generationId),
        ),
      );
    if (!existing) return slug;
    slug = `${base}-${suffix}`;
    suffix += 1;
  }
  // Fallback estremo: aggiungi un componente casuale (non dovrebbe mai servire).
  return `${base}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Risolve gli `affectedSlugs` dell'agente in cross-link "related": tiene solo gli slug
 * che ESISTONO tra le pagine esistenti (scarta quelli inventati), risolve il titolo e
 * deduplica. Formato del campo `links` (jsonb): array `{ type, slug, title }`.
 */
function buildRelatedLinks(
  affectedSlugs: string[],
  existingPages: ExistingPage[],
): { type: "related"; slug: string; title: string }[] {
  const bySlug = new Map(existingPages.map((p) => [p.slug, p.title]));
  const seen = new Set<string>();
  const links: { type: "related"; slug: string; title: string }[] = [];
  for (const slug of affectedSlugs) {
    const title = bySlug.get(slug);
    if (title === undefined || seen.has(slug)) continue;
    seen.add(slug);
    links.push({ type: "related", slug, title });
  }
  return links;
}

/** Branch effimero (stabile) del worktree di refresh/grow: vive solo per il run, poi rimosso. */
const REFRESH_BRANCH = "stubwise/docs-autoupdate";

/** Esito combinato di rigenerazione mirata (Fase 2) e creazione incrementale (Fase 3). */
interface RefreshResult {
  /** Slug delle pagine effettivamente aggiornate (per i cross-link e il prompt release). */
  updatedSlugs: string[];
  /** Pagine aggiornate con titolo (passate al prompt release, additivo). */
  refreshedPages: { slug: string; title: string }[];
  /** Pagine NUOVE create per le aree non documentate (Fase 3): slug + titolo. */
  createdPages: { slug: string; title: string }[];
  /** Aree (path) cambiate NON coperte da alcuna pagina e non documentate in questo ciclo
   * (residuo Fase 3: aggregate scartate/fallite/oltre il tetto). Elencate nella entry. */
  newAreas: string[];
  /** Pagine impattate scartate per il tetto `maxRefreshPages`. */
  truncated: number;
}

/** Contesto albero passato al mini-orient (radici + primo livello della generazione). */
async function loadGrowTreeContext(
  db: Db,
  generationId: string,
): Promise<GrowExistingPage[]> {
  // Radici (parentId IS NULL) + i loro figli DIRETTI: uno spaccato compatto dell'albero
  // (slug/title/kind) tra cui il mini-orient sceglie il genitore, senza sommergere il
  // prompt con l'intera generazione.
  const roots = await db
    .select({ id: docPages.id, slug: docPages.slug, title: docPages.title, kind: docPages.kind })
    .from(docPages)
    .where(and(eq(docPages.generationId, generationId), isNull(docPages.parentId)));
  const rootIds = roots.map((r) => r.id);
  const children =
    rootIds.length > 0
      ? await db
          .select({ slug: docPages.slug, title: docPages.title, kind: docPages.kind })
          .from(docPages)
          .where(
            and(
              eq(docPages.generationId, generationId),
              inArray(docPages.parentId, rootIds),
            ),
          )
      : [];
  return [
    ...roots.map((r) => ({ slug: r.slug, title: r.title, kind: r.kind })),
    ...children.map((c) => ({ slug: c.slug, title: c.title, kind: c.kind })),
  ];
}

/**
 * RIGENERAZIONE MIRATA (Fase 2). Per ogni pagina impattata dal diff fa girare l'agente di
 * refresh nel worktree GIÀ APERTO `dir`, aggiornando in-place il body e RI-EMBEDDANDO i
 * chunk (update + delete + embedAndStoreChunks) in UNA transazione per-pagina: un embed
 * fallito dopo il delete rollbacka anche update+delete, lasciando la pagina nello stato
 * VECCHIO coerente. Tutto BEST-EFFORT per pagina: un fallimento logga e prosegue.
 */
async function refreshAffectedPagesInWorktree(
  deps: RunAutoUpdateDeps,
  dir: string,
  generationId: string,
  affected: PageRef[],
  material: string[],
  commitSubjects: string[],
  provider: ResolvedProvider | undefined,
  repositoryId: string,
): Promise<{ updatedSlugs: string[]; refreshedPages: { slug: string; title: string }[] }> {
  const updatedSlugs: string[] = [];
  const refreshedPages: { slug: string; title: string }[] = [];
  // Sequenziale: l'agente è read-only nello stesso worktree, un solo run alla volta.
  for (const page of affected) {
    try {
      const pageBody = await loadPageBody(deps.db, page.id);
      if (pageBody === null) continue; // pagina sparita nel frattempo: salta.

      const prompt = buildRefreshPagePrompt({
        title: page.title,
        sourcePath: page.sourcePath,
        currentBody: pageBody.body,
        // Passiamo tutti i file materiali come contesto: l'agente filtra leggendo il
        // codice sotto sourcePath (il prompt lo istruisce a leggere ciò che conta).
        changedFiles: material,
        commitSubjects,
      });
      const result = await deps.runner.run({
        cwd: dir,
        prompt,
        model: deps.model,
        permissionMode: "plan",
        maxTurns: deps.maxTurns,
        timeoutMs: deps.agentTimeoutMs,
        ...(provider !== undefined ? { provider } : {}),
      });
      const parsed = parseRefreshedPage(result.output);
      if (parsed.kind !== "updated") continue; // no-op/ambiguo: niente da fare.

      const newBody = parsed.body;
      // Update in-place del solo BODY: `doc_pages` non ha una colonna commitSha per-pagina
      // (la staleness è tracciata a livello di GENERAZIONE, e doc_generations.commitSha
      // viene avanzato a toSha in coda a runAutoUpdate).
      //
      // TRANSAZIONE per-pagina: update body + delete chunk vecchi + re-embed dei chunk
      // nuovi sono atomici. Se l'embed lancia DOPO il delete, il rollback ripristina anche
      // update+delete: la pagina resta nello stato VECCHIO coerente. L'errore risale al
      // try/catch best-effort esterno, che logga e prosegue con le altre pagine.
      await deps.db.transaction(async (tx) => {
        await tx.update(docPages).set({ body: newBody }).where(eq(docPages.id, page.id));
        await tx.delete(docChunks).where(eq(docChunks.pageId, page.id));
        await embedAndStoreChunks(tx, deps.embeddingClient, {
          repositoryId,
          generationId,
          pages: [
            { id: page.id, body: newBody, kind: pageBody.kind, sourcePath: pageBody.sourcePath },
          ],
          batchSize: EMBED_BATCH_SIZE,
        });
      });
      updatedSlugs.push(page.slug);
      refreshedPages.push({ slug: page.slug, title: page.title });
    } catch (err) {
      // BEST-EFFORT per pagina: un refresh fallito (agente o embed) non blocca le altre né
      // l'intero auto-update.
      console.error(
        `[stubwise-worker] auto-update: refresh della pagina '${page.slug}' (repository ${repositoryId}) fallito (${errText(err)}), proseguo`,
      );
    }
  }
  return { updatedSlugs, refreshedPages };
}

/** Esito della creazione incrementale (Fase 3). */
interface GrowResult {
  createdPages: { slug: string; title: string }[];
  /** Costo (USD) sommato dei run Fase 3 (mini-orient + explore). */
  cost: number;
  /** Numero totale di chunk embeddati per le pagine create (per lo stats update). */
  chunkCount: number;
  /** Aree (path) rimaste NON documentate (proposte scartate/fallite/oltre il tetto). */
  residualAreas: string[];
}

/**
 * CREAZIONE INCREMENTALE (Fase 3). Le AREE NUOVE (file non coperti da alcuna pagina) sono
 * aggregate deterministicamente; un MINI-ORIENT (1 run read-only) propone fino a
 * `maxNewPages` pagine; per ogni proposta un run explore-style scrive il body (SOLO il
 * body, i figli sono ignorati) e la pagina è inserita nella GENERAZIONE CORRENTE (slug
 * dedupato, parentId dal parentSlug, position in coda, chunk embeddati) in una transazione
 * per-pagina. Best-effort: ogni proposta scartata/fallita finisce nel `residualAreas`.
 * Gira nel worktree GIÀ APERTO `dir`. Non lancia: ritorna sempre un GrowResult.
 */
async function growNewAreaPages(
  deps: RunAutoUpdateDeps,
  dir: string,
  generationId: string,
  newAreaFiles: string[],
  treeContext: GrowExistingPage[],
  commitSubjects: string[],
  provider: ResolvedProvider | undefined,
  repositoryId: string,
): Promise<GrowResult> {
  const empty: GrowResult = { createdPages: [], cost: 0, chunkCount: 0, residualAreas: [] };
  const areas = aggregateNewAreas(newAreaFiles);
  if (areas.length === 0) return empty;

  const createdPages: { slug: string; title: string }[] = [];
  let cost = 0;
  let chunkCount = 0;
  // Residuo di default: tutte le aree, rimosse man mano che una proposta le documenta.
  const residual = new Set(areas.map((a) => a.path));

  // Slug reali della generazione per SANIFICARE i parentSlug proposti dall'agente.
  const validParentSlugs = new Set(treeContext.map((p) => p.slug));

  // 1) MINI-ORIENT: un solo run read-only decide le proposte.
  let proposals: GrowProposal[];
  try {
    const orientPrompt = buildGrowOrientPrompt({
      areas,
      existingPages: treeContext,
      maxPages: deps.maxNewPages,
      commitSubjects,
    });
    const orientRun = await deps.runner.run({
      cwd: dir,
      prompt: orientPrompt,
      model: deps.model,
      permissionMode: "plan",
      maxTurns: deps.maxTurns,
      timeoutMs: deps.agentTimeoutMs,
      ...(provider !== undefined ? { provider } : {}),
    });
    cost += orientRun.usage?.totalCostUsd ?? 0;
    proposals = parseGrowOrientOutput(orientRun.output).slice(0, deps.maxNewPages);
  } catch (err) {
    console.error(
      `[stubwise-worker] auto-update: mini-orient Fase 3 del repository ${repositoryId} fallito (${errText(err)}), nessuna pagina nuova`,
    );
    return { createdPages, cost, chunkCount, residualAreas: Array.from(residual).sort() };
  }

  // 2) Un run EXPLORE per proposta (cap già applicato): SOLO il body, i figli ignorati.
  for (const proposal of proposals) {
    // Sanificazione: sourcePaths validi (già normalizzati dal parser); parentSlug tra gli
    // slug reali, altrimenti radice (null). unitRef = primo path (o path dell'area se
    // l'agente non ha specificato i path). Copre l'area col primo dei suoi sourcePaths.
    const sourcePaths = proposal.sourcePaths;
    const parentSlug =
      proposal.parentSlug !== null && validParentSlugs.has(proposal.parentSlug)
        ? proposal.parentSlug
        : null;
    const parentPage = parentSlug !== null ? treeContext.find((p) => p.slug === parentSlug) : undefined;
    const unitRef = sourcePaths[0] ?? "";

    try {
      const explorePrompt = buildExplorePrompt({
        tree: proposal.kind,
        unitRef,
        title: proposal.title,
        parentContext: parentPage
          ? `${parentPage.title} (${parentPage.slug})`
          : "root",
      });
      const exploreRun = await deps.runner.run({
        cwd: dir,
        prompt: explorePrompt,
        model: deps.model,
        permissionMode: "plan",
        maxTurns: deps.maxTurns,
        timeoutMs: deps.agentTimeoutMs,
        ...(provider !== undefined ? { provider } : {}),
      });
      cost += exploreRun.usage?.totalCostUsd ?? 0;

      const parsed = parseExploreOutput(exploreRun.output);
      // Body invalido (vuoto / troppo corto / meta-summary) o contratto rotto: scarto,
      // l'area resta nel residuo (già in `residual`).
      if ("reason" in parsed) continue;
      const body = parsed.body;

      // sourcePath della pagina: primo dei path raffinati dall'explore, poi quelli della
      // proposta. Null se davvero nessuno.
      const pageSourcePath = parsed.sourcePaths[0] ?? sourcePaths[0] ?? null;

      // 3) INSERT in transazione: slug dedupato (slug FRESCHI della generazione), parentId
      // dal parentSlug, position = max(position)+1 della generazione, chunk embeddati.
      const inserted = await deps.db.transaction(async (tx) => {
        const usedRows = await tx
          .select({ slug: docPages.slug })
          .from(docPages)
          .where(eq(docPages.generationId, generationId));
        const used = new Set(usedRows.map((r) => r.slug));
        const slug = slugForNode(proposal.title, used);

        const parentId =
          parentSlug !== null
            ? (
                await tx
                  .select({ id: docPages.id })
                  .from(docPages)
                  .where(
                    and(
                      eq(docPages.generationId, generationId),
                      eq(docPages.slug, parentSlug),
                    ),
                  )
              )[0]?.id ?? null
            : null;

        const [maxRow] = await tx
          .select({ position: docPages.position })
          .from(docPages)
          .where(eq(docPages.generationId, generationId))
          .orderBy(desc(docPages.position))
          .limit(1);
        const position = (maxRow?.position ?? -1) + 1;

        const [row] = await tx
          .insert(docPages)
          .values({
            repositoryId,
            generationId,
            kind: proposal.kind,
            slug,
            title: proposal.title,
            parentId,
            position,
            sourcePath: pageSourcePath,
            body,
          })
          .returning({ id: docPages.id });
        if (!row) throw new Error("insert della pagina Fase 3 non ha restituito la riga");

        const { chunkCount: pageChunks } = await embedAndStoreChunks(tx, deps.embeddingClient, {
          repositoryId,
          generationId,
          pages: [{ id: row.id, body, kind: proposal.kind, sourcePath: pageSourcePath }],
          batchSize: EMBED_BATCH_SIZE,
        });
        return { slug, chunks: pageChunks };
      });

      createdPages.push({ slug: inserted.slug, title: proposal.title });
      chunkCount += inserted.chunks;
      // L'area documentata esce dal residuo: rimuovi le aree i cui path sono coperti da
      // uno dei sourcePaths della pagina.
      for (const area of areas) {
        if (sourcePaths.some((sp) => area.path === sp || area.path.startsWith(`${sp}/`) || sp.startsWith(`${area.path}/`))) {
          residual.delete(area.path);
        }
      }
    } catch (err) {
      console.error(
        `[stubwise-worker] auto-update: creazione pagina Fase 3 '${proposal.title}' (repository ${repositoryId}) fallita (${errText(err)}), proseguo`,
      );
    }
  }

  return { createdPages, cost, chunkCount, residualAreas: Array.from(residual).sort() };
}

/**
 * Orchestratore Fase 2 + Fase 3: apre UN worktree effimero al default branch e vi esegue,
 * in sequenza, la rigenerazione mirata (se `maxRefreshPages > 0`) e la creazione
 * incrementale (se `maxNewPages > 0`). `mapAffectedPages` gira sempre (con `maxRefreshPages`
 * come tetto per il refresh) per calcolare le aree nuove. Non lancia: ritorna sempre un
 * RefreshResult (worktree non apribile → esito con solo il mapping deterministico).
 */
async function refreshAndGrowPages(
  deps: RunAutoUpdateDeps,
  ctx: ProjectContext,
  generationId: string,
  pagesWithRefs: PageRef[],
  material: string[],
  commitSubjects: string[],
  provider: ResolvedProvider | undefined,
  repositoryId: string,
): Promise<RefreshResult> {
  // Mapping deterministico: il tetto del refresh è `maxRefreshPages` (0 = niente refresh,
  // ma le newAreas sono comunque calcolate per la Fase 3 e la entry).
  const { affected, newAreas, truncated } = mapAffectedPages(
    material,
    pagesWithRefs,
    deps.maxRefreshPages,
  );

  let updatedSlugs: string[] = [];
  let refreshedPages: { slug: string; title: string }[] = [];
  let createdPages: { slug: string; title: string }[] = [];
  // Residuo Fase 3: parte dalle newAreas del mapping; la Fase 3, se attiva, lo raffina.
  let residualAreas = newAreas;

  const runRefresh = deps.maxRefreshPages > 0 && affected.length > 0;
  const runGrow = deps.maxNewPages > 0 && newAreas.length > 0;
  if (!runRefresh && !runGrow) {
    return { updatedSlugs, refreshedPages, createdPages, newAreas: residualAreas, truncated };
  }

  const treeContext = runGrow ? await loadGrowTreeContext(deps.db, generationId) : [];

  try {
    // withWorktree fa checkout dell'HEAD CORRENTE del default branch (dopo ensureMirror/
    // fetch), NON di job.toSha: doc_pages non tiene uno sha per-pagina e gli agenti leggono
    // codice reale dal worktree. UN SOLO worktree per entrambe le fasi.
    await deps.mirrors.withWorktree(ctx.mirrorProject, REFRESH_BRANCH, async (dir) => {
      if (runRefresh) {
        const r = await refreshAffectedPagesInWorktree(
          deps,
          dir,
          generationId,
          affected,
          material,
          commitSubjects,
          provider,
          repositoryId,
        );
        updatedSlugs = r.updatedSlugs;
        refreshedPages = r.refreshedPages;
      }
      if (runGrow) {
        const g = await growNewAreaPages(
          deps,
          dir,
          generationId,
          newAreas,
          treeContext,
          commitSubjects,
          provider,
          repositoryId,
        );
        createdPages = g.createdPages;
        residualAreas = g.residualAreas;
        // Aggiorna stats/cost della generazione con l'esito della Fase 3.
        await applyGrowStats(deps.db, generationId, g, repositoryId);
      }
    });
  } catch (err) {
    // Apertura del worktree fallita (es. mirror non raggiungibile): niente refresh/grow, ma
    // l'auto-update prosegue con la sola entry release (best-effort).
    console.error(
      `[stubwise-worker] auto-update: worktree di refresh/grow del repository ${repositoryId} non apribile (${errText(err)}), solo entry release`,
    );
  }

  return { updatedSlugs, refreshedPages, createdPages, newAreas: residualAreas, truncated };
}

/** Forma delle stats jsonb della generazione a cui la Fase 3 incrementa pages/chunks. */
interface GenerationStats {
  pages?: number;
  chunks?: number;
  [k: string]: unknown;
}

/**
 * Incrementa `doc_generations.stats` (pages/chunks) e `cost` con l'esito della Fase 3. Le
 * stats sono scritte SOLO alla finalize della generazione: qui vanno aggiornate a mano.
 * Best-effort: un errore logga e prosegue (le pagine sono già inserite).
 */
async function applyGrowStats(
  db: Db,
  generationId: string,
  grow: GrowResult,
  repositoryId: string,
): Promise<void> {
  if (grow.createdPages.length === 0) return;
  try {
    const [gen] = await db
      .select({ stats: docGenerations.stats, cost: docGenerations.cost })
      .from(docGenerations)
      .where(eq(docGenerations.id, generationId));
    const stats = (gen?.stats as GenerationStats | null) ?? {};
    const nextStats: GenerationStats = {
      ...stats,
      pages: (stats.pages ?? 0) + grow.createdPages.length,
      chunks: (stats.chunks ?? 0) + grow.chunkCount,
    };
    const nextCost = (Number(gen?.cost ?? 0) + grow.cost).toFixed(6);
    await db
      .update(docGenerations)
      .set({ stats: nextStats, cost: nextCost })
      .where(eq(docGenerations.id, generationId));
  } catch (err) {
    console.error(
      `[stubwise-worker] auto-update: aggiornamento stats/cost Fase 3 della generazione ${generationId} (repository ${repositoryId}) fallito (${errText(err)})`,
    );
  }
}

/** Sezione markdown DETERMINISTICA appesa alla entry quando ci sono aree nuove/troncate. */
function newAreasSection(newAreas: string[], truncated: number): string {
  if (newAreas.length === 0 && truncated === 0) return "";
  const lines: string[] = ["", "## Aree nuove non documentate"];
  if (newAreas.length > 0) {
    lines.push("");
    for (const area of newAreas) lines.push(`- ${area}`);
  }
  if (truncated > 0) {
    lines.push(
      "",
      `_${truncated} pagina/e impattata/e oltre il tetto non sono state rigenerate in questo ciclo._`,
    );
  }
  if (newAreas.length > 0) {
    lines.push("", "_Valuta una rigenerazione completa per coprirle._");
  }
  return lines.join("\n");
}

/**
 * Esegue l'auto-update per un pending GIÀ RECLAMATO (rimosso dalla tabella dal poller).
 * Best-effort: ogni percorso d'uscita logga e termina; un errore NON rimette in loop il
 * pending (non esiste più). Vedi il docblock del modulo per il flusso completo.
 */
export async function runAutoUpdate(deps: RunAutoUpdateDeps, job: AutoUpdateJob): Promise<void> {
  const ctx = await loadProjectContext(deps, job.repositoryId);
  if (!ctx) return;

  // Diff del range: file cambiati + subject dei commit. Se gli sha non sono raggiungibili
  // (es. force-push che ha riscritto la history, mirror non aggiornato) il git fallisce →
  // log e termina (best-effort, il prossimo push ricreerà un pending).
  let changed: string[];
  let commitSubjects: string[];
  try {
    changed = await deps.mirrors.getChangedFiles(ctx.mirrorProject, job.fromSha, job.toSha);
    const commits = await deps.mirrors.getCommitMessages(
      ctx.mirrorProject,
      job.fromSha,
      job.toSha,
    );
    commitSubjects = commits.map((c) => c.subject);
  } catch (err) {
    console.error(
      `[stubwise-worker] auto-update: diff ${job.fromSha}..${job.toSha} del repository ${job.repositoryId} fallito (${errText(err)}), salto`,
    );
    return;
  }

  // GATE RUMORE (deterministico): se TUTTI i file cambiati sono rumore (o non c'è alcun
  // file) niente è materiale per un changelog → niente agente, niente entry. Il pending è
  // già stato reclamato, quindi non si ricrea nulla. Lo `commitSha` della generazione NON
  // avanza qui di proposito: il prossimo push utile partirà da un fromSha che include
  // anche questi commit di rumore (sono nel suo range, ma resteranno comunque filtrati).
  const material = changed.filter((path) => !isNoise(path));
  if (material.length === 0) {
    console.error(
      `[stubwise-worker] auto-update: repository ${job.repositoryId} ${job.fromSha}..${job.toSha} è solo rumore (${changed.length} file), nessuna entry release`,
    );
    return;
  }

  // Provider: bloccato (per id) o automatico (chain[0]). Bloccato non risolvibile → stop
  // senza fallback (coerente col "provider bloccato" della generazione).
  const resolved = await resolveProvider(deps, ctx.aiProviderId);
  if ("blocked" in resolved) {
    console.error(
      `[stubwise-worker] auto-update: provider auto del repository ${job.repositoryId} non disponibile (disabilitato/cancellato), salto senza fallback`,
    );
    return;
  }

  const existingPages = await loadExistingPages(deps.db, ctx.currentDocGenerationId);

  // RIGENERAZIONE MIRATA (Fase 2) + CREAZIONE INCREMENTALE (Fase 3): PRIMA dell'agente
  // release aggiorniamo/creiamo le pagine nel worktree effimero. Abilitate indipendentemente
  // dai loro tetti (maxRefreshPages / maxNewPages > 0), ma solo se c'è una generazione
  // corrente su cui agire. Best-effort: ritorna sempre un esito (fallimenti per-pagina già
  // loggati e assorbiti). Entrambi i tetti a 0 → comportamento Fase 1 (solo la entry).
  let refresh: RefreshResult = {
    updatedSlugs: [],
    refreshedPages: [],
    createdPages: [],
    newAreas: [],
    truncated: 0,
  };
  if (
    (deps.maxRefreshPages > 0 || deps.maxNewPages > 0) &&
    ctx.currentDocGenerationId !== null
  ) {
    const pagesWithRefs = await loadPagesWithRefs(deps.db, ctx.currentDocGenerationId);
    refresh = await refreshAndGrowPages(
      deps,
      ctx,
      ctx.currentDocGenerationId,
      pagesWithRefs,
      material,
      commitSubjects,
      resolved.provider,
      job.repositoryId,
    );
  }

  // Agente di analisi: 1 run, contesto TESTUALE (niente worktree per la entry). plan =
  // read-only (l'agente non scrive nulla, produce solo l'output marcato). Il prompt riceve
  // ANCHE le pagine rigenerate (Fase 2), quelle create (Fase 3) e il residuo di aree nuove.
  const prompt = buildReleasePrompt({
    changedFiles: material,
    commitSubjects,
    existingPages,
    refreshedPages: refresh.refreshedPages,
    createdPages: refresh.createdPages,
    newAreas: refresh.newAreas,
  });
  let notes: ReleaseNotes | null;
  try {
    const result = await deps.runner.run({
      cwd: process.cwd(),
      prompt,
      model: deps.model,
      permissionMode: "plan",
      maxTurns: deps.maxTurns,
      timeoutMs: deps.agentTimeoutMs,
      ...(resolved.provider !== undefined ? { provider: resolved.provider } : {}),
    });
    notes = parseReleaseNotes(result.output);
  } catch (err) {
    console.error(
      `[stubwise-worker] auto-update: agente di release del repository ${job.repositoryId} fallito (${errText(err)}), nessuna entry`,
    );
    return;
  }
  if (!notes) {
    console.error(
      `[stubwise-worker] auto-update: output dell'agente di release del repository ${job.repositoryId} non valido (marcatori mancanti), nessuna entry`,
    );
    return;
  }

  // Entry release: pagina PERSISTENTE (generationId null, come le manuali). Titolo col
  // prefisso "[minore]" quando NON significativa; position decrescente nel tempo così le
  // più recenti sono in cima all'albero.
  const now = new Date();
  const slug = await uniqueReleaseSlug(deps.db, job.repositoryId, job.toSha, now);
  const title = notes.significant ? notes.title : `[minore] ${notes.title}`;
  // Cross-link related = unione DETERMINISTICA degli slug aggiornati in-place (Fase 2), degli
  // slug delle pagine CREATE (Fase 3) e degli affectedSlugs dell'agente, filtrati alle pagine
  // note (buildRelatedLinks deduplica e scarta gli slug inventati). Le pagine create NON sono
  // in `existingPages` (caricate PRIMA della Fase 3): il lookup va esteso con esse, altrimenti
  // il loro cross-link verrebbe scartato come "slug inventato".
  const linkablePages: ExistingPage[] = [
    ...existingPages,
    ...refresh.createdPages.map((p) => ({ slug: p.slug, title: p.title, sourcePath: null })),
  ];
  const links = buildRelatedLinks(
    [
      ...refresh.updatedSlugs,
      ...refresh.createdPages.map((p) => p.slug),
      ...notes.affectedSlugs,
    ],
    linkablePages,
  );
  // Garanzia DETERMINISTICA: se ci sono aree nuove non documentate (o pagine impattate
  // troncate dal tetto) la entry lo segnala sempre, anche se l'agente lo omette.
  const body = notes.body + newAreasSection(refresh.newAreas, refresh.truncated);

  try {
    await deps.db.insert(docPages).values({
      repositoryId: job.repositoryId,
      generationId: null,
      kind: "releases",
      isManual: false,
      slug,
      title,
      parentId: null,
      position: -Math.floor(now.getTime() / 1000),
      sourcePath: null,
      body,
      links: links.length > 0 ? links : null,
    });
  } catch (err) {
    console.error(
      `[stubwise-worker] auto-update: insert della entry release del repository ${job.repositoryId} fallito (${errText(err)})`,
    );
    return;
  }

  // I docs sono ora "visti fino a" toSha: avanza il commitSha della generazione corrente.
  // Se non c'è una generazione corrente, salta (niente puntatore da aggiornare).
  if (ctx.currentDocGenerationId !== null) {
    try {
      await deps.db
        .update(docGenerations)
        .set({ commitSha: job.toSha })
        .where(eq(docGenerations.id, ctx.currentDocGenerationId));
    } catch (err) {
      console.error(
        `[stubwise-worker] auto-update: aggiornamento commitSha della generazione ${ctx.currentDocGenerationId} fallito (${errText(err)})`,
      );
      // L'entry è già creata: non è un fallimento dell'auto-update.
    }
  }

  console.error(
    `[stubwise-worker] auto-update: entry release '${slug}' creata per il repository ${job.repositoryId} (significant=${notes.significant}, ${links.length} link)`,
  );
}
