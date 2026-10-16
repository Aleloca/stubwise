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
  resolveGrowSourcePaths,
  buildExplorePrompt,
  buildGrowOrientPrompt,
  buildRefreshPagePrompt,
  buildReleasePrompt,
  buildSecretsAuditPrompt,
  mapAffectedPages,
  parseExploreOutput,
  parseGrowOrientOutput,
  parseProductGuideOutput,
  parseRefreshedPage,
  parseReleaseNotes,
  parseSecretsAuditOutput,
  slugForNode,
  PRODUCT_PAGE_END_MARKER,
  PRODUCT_PAGE_START_MARKER,
  type BriefConfidentialFact,
  type ExistingPage,
  type GrowExistingPage,
  type GrowProposal,
  type PageRef,
  type ProjectBrief,
  type ReleaseNotes,
} from "@stubwise/docs-engine";
import type { EmbeddingClient } from "@stubwise/embeddings";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { z } from "zod";
import type { AgentRunner, AgentRunResult, AgentRunSession } from "../agent/runner.js";
import { isNoise } from "../nightly/noise.js";
import { buildRelatedLinks, newAreasSection, uniqueReleaseSlug } from "../nightly/release-page.js";
import { isLimitError } from "../providers/limit.js";
import { docUpdateSession, sessionOption } from "../sessions/owners.js";
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
 * Le deps dei run interni: quelle pubbliche più la sessione dell'aggiornamento,
 * risolta UNA volta in {@link runAutoUpdate} e passata giù.
 */
type AutoUpdateRunDeps = RunAutoUpdateDeps & { session?: AgentRunSession };

/** Opzione `session` di un run (assente = run non registrato). */
function sessionOf(deps: AutoUpdateRunDeps): { session?: AgentRunSession } {
  return deps.session !== undefined ? { session: deps.session } : {};
}

/**
 * Gate del rumore: spostato in `nightly/noise.ts` (Piano B, Task B3) con la regola
 * allargata; ri-esportato finché questo modulo esiste (lo rimuove il Task B11).
 */
export { isNoise };

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
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
 * Carica i FATTI RISERVATI del brief della generazione corrente (colonna
 * `doc_generations.brief`, jsonb nullable). Il refresh di una pagina product deve poter
 * ri-auditare il body rinfrescato contro questi fatti (Fase C). Ritorna `[]` (con log a
 * carico del chiamante quando serve) se la generazione non ha brief o non ha fatti — nel
 * qual caso l'audit del refresh è saltato (fail-open dichiarato, come nel product handler:
 * senza una lista di fatti non c'è violazione DEFINIBILE). Best-effort: un errore DB
 * ritorna `[]` (il refresh non deve rompersi per il brief).
 */
async function loadConfidentialFacts(
  db: Db,
  generationId: string,
): Promise<BriefConfidentialFact[]> {
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

/**
 * Euristica "è una GUIDA product": il body ha le due sezioni cardine della guida a struttura
 * imposta (`### Goal` e `### Steps`, vedi `product.ts`/`parseProductGuideOutput`). Le radici e
 * le FAQ product NON le hanno, quindi non passano dalla ri-validazione NAV.
 */
function looksLikeProductGuide(body: string): boolean {
  const lines = body.split("\n");
  const has = (heading: string): boolean => lines.some((l) => l.trim() === heading);
  return has("### Goal") && has("### Steps");
}

/**
 * GUARD del refresh di una pagina `product` (nota review C2). Oggi le pagine product hanno
 * `sourcePath` null (nodi con sourcePaths []), quindi il mapping diff→pagine NON le seleziona
 * MAI: le verticali seguono i journey del brief, non i file, e si arricchiscono solo a una
 * rigenerazione COMPLETA. Questo guard è una difesa in profondità per il caso in cui una
 * pagina product entrasse comunque nel giro di refresh (dati futuri/manuali). NON riscrive
 * mai: nel refresh la violazione = si SALTA l'update (la vecchia pagina, già verificata alla
 * generazione, resta pubblicata).
 *
 * Due controlli, entrambi bloccanti (ritorno `false` = NON aggiornare):
 *  (b) se il body rinfrescato è una GUIDA (euristica `looksLikeProductGuide`), lo si ri-valida
 *      con `parseProductGuideOutput` (ancoraggi di navigazione): fallito → non aggiornare
 *      (una riscrittura non deve degradare gli ancoraggi NAV validati alla generazione);
 *  (a) se ci sono fatti riservati, si AUDITA il body rinfrescato (Fase C, red-teamer): una
 *      VIOLATION → non aggiornare. Senza fatti (brief/facts assenti) l'audit è saltato ma si
 *      LOGGA (una pagina product rinfrescata senza verifica non dovrebbe accadere oggi).
 *
 * Ritorna `true` se il body può essere persistito, `false` se l'update va SALTATO. Non lancia:
 * un errore dell'audit (agente/parse) è trattato fail-closed (→ `false`, non aggiornare).
 */
async function guardRefreshedProductBody(
  deps: AutoUpdateRunDeps,
  dir: string,
  page: PageRef,
  newBody: string,
  confidentialFacts: BriefConfidentialFact[],
  provider: ResolvedProvider | undefined,
  repositoryId: string,
): Promise<boolean> {
  // (b) Ri-validazione NAV se è una guida: il body va ri-avvolto nei marcatori product,
  // perché `parseProductGuideOutput` si aspetta l'output marcato (`===PAGE===`…`===END PAGE===`).
  if (looksLikeProductGuide(newBody)) {
    const wrapped = [PRODUCT_PAGE_START_MARKER, newBody, PRODUCT_PAGE_END_MARKER].join("\n");
    const parsed = parseProductGuideOutput(wrapped);
    if (!("body" in parsed)) {
      console.error(
        `[stubwise-worker] auto-update: refresh della guida product '${page.slug}' (repository ` +
          `${repositoryId}) invalida (ancoraggi di navigazione insufficienti) → NON aggiornata`,
      );
      return false;
    }
  }

  // (a) Audit segreti sul body rinfrescato. Senza fatti riservati non c'è violazione
  // definibile → audit saltato, ma LOGGATO (product rinfrescata senza verifica: anomalo oggi).
  if (confidentialFacts.length === 0) {
    console.error(
      `[stubwise-worker] auto-update: pagina product '${page.slug}' (repository ${repositoryId}) ` +
        "rinfrescata SENZA verifica segreti (nessun fatto riservato nel brief) — non dovrebbe accadere",
    );
    return true;
  }

  const providerOpt = provider !== undefined ? { provider } : {};
  let output: string;
  try {
    const result = await deps.runner.run({
      cwd: dir,
      prompt: buildSecretsAuditPrompt({
        pageTitle: page.title,
        body: newBody,
        confidentialFacts,
      }),
      model: deps.model,
      permissionMode: "plan",
      maxTurns: deps.maxTurns,
      timeoutMs: deps.agentTimeoutMs,
      ...sessionOf(deps),
      ...providerOpt,
    });
    stopOnLimit(result);
    output = result.output;
  } catch (err) {
    if (isLimitStop(err)) throw err;
    // Audit non eseguibile → fail-closed: non aggiorniamo ciò che non abbiamo potuto verificare.
    console.error(
      `[stubwise-worker] auto-update: audit segreti del refresh della pagina product '${page.slug}' ` +
        `(repository ${repositoryId}) fallito (${errText(err)}) → NON aggiornata (fail-closed)`,
    );
    return false;
  }
  const verdict = parseSecretsAuditOutput(output);
  if (verdict.verdict !== "clean") {
    console.error(
      `[stubwise-worker] auto-update: refresh della pagina product '${page.slug}' (repository ` +
        `${repositoryId}) BOCCIATO dal verificatore segreti (${verdict.detail}) → NON aggiornata`,
    );
    return false;
  }
  return true;
}

/**
 * Un run al LIMITE di rate/usage ferma l'INTERO aggiornamento al primo colpo
 * (Task A6): ogni run successivo sarebbe bruciato contro lo stesso limite, e
 * una entry release scritta senza le pagine rinfrescate racconterebbe un
 * aggiornamento che non c'è stato. Si lancia dal punto del run e risale i
 * catch best-effort per pagina/proposta (che la rilanciano) fino a
 * runAutoUpdate, che logga e termina. Basta questo: il Piano B sostituisce il
 * modulo col giro notturno.
 */
class AutoUpdateLimitStop extends Error {
  constructor() {
    super("provider AI al limite di rate/usage: auto-update interrotto");
    this.name = "AutoUpdateLimitStop";
  }
}

/** Il run è finito al limite → stop (vedi AutoUpdateLimitStop). */
function stopOnLimit(result: AgentRunResult): void {
  if (isLimitError(result)) throw new AutoUpdateLimitStop();
}

/** Un errore che deve fermare l'aggiornamento: lo stop, o un limite lanciato dal runner. */
function isLimitStop(err: unknown): boolean {
  return err instanceof AutoUpdateLimitStop || isLimitError(err);
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
  deps: AutoUpdateRunDeps,
  dir: string,
  generationId: string,
  affected: PageRef[],
  material: string[],
  commitSubjects: string[],
  provider: ResolvedProvider | undefined,
  repositoryId: string,
  confidentialFacts: BriefConfidentialFact[],
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
        ...sessionOf(deps),
        ...(provider !== undefined ? { provider } : {}),
      });
      stopOnLimit(result);
      const parsed = parseRefreshedPage(result.output);
      if (parsed.kind !== "updated") continue; // no-op/ambiguo: niente da fare.

      const newBody = parsed.body;

      // GUARD product (nota review C2): se la pagina è `product`, il body rinfrescato passa
      // dall'audit segreti (e, se guida, dalla ri-validazione NAV) PRIMA di persistere. Nel
      // refresh NON si riscrive: violazione/guida invalida = si SALTA l'update (la vecchia
      // pagina, già verificata alla generazione, resta pubblicata). Oggi le product hanno
      // sourcePath null e non entrano mai in `affected`: questo è difesa in profondità.
      if (pageBody.kind === "product") {
        const ok = await guardRefreshedProductBody(
          deps,
          dir,
          page,
          newBody,
          confidentialFacts,
          provider,
          repositoryId,
        );
        if (!ok) continue; // non aggiornata: guard bocciata (già loggato).
      }

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
      if (isLimitStop(err)) throw err;
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
  /** Un run è finito al limite: il chiamante salva le stats di ciò che è stato creato e si ferma. */
  limited?: boolean;
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
  deps: AutoUpdateRunDeps,
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
      ...sessionOf(deps),
      ...(provider !== undefined ? { provider } : {}),
    });
    cost += orientRun.usage?.totalCostUsd ?? 0;
    stopOnLimit(orientRun);
    proposals = parseGrowOrientOutput(orientRun.output).slice(0, deps.maxNewPages);
  } catch (err) {
    if (isLimitStop(err)) {
      return {
        createdPages,
        cost,
        chunkCount,
        residualAreas: Array.from(residual).sort(),
        limited: true,
      };
    }
    console.error(
      `[stubwise-worker] auto-update: mini-orient Fase 3 del repository ${repositoryId} fallito (${errText(err)}), nessuna pagina nuova`,
    );
    return { createdPages, cost, chunkCount, residualAreas: Array.from(residual).sort() };
  }

  // sourcePath da PERSISTERE per ciascuna proposta: allargato al path dell'AREA quando quella
  // proposta è l'UNICA a coprirla (copertura 1:1), altrimenti l'unitRef scelto dall'agente.
  // Allargando all'area, i file fratelli futuri risultano coperti da `pathCovers` (ancestor-only)
  // e l'area non si ripresenta come "nuova" a ogni push (chiude il ciclo di ripetizione).
  const pageSourcePaths = resolveGrowSourcePaths(
    areas,
    proposals.map((p) => p.sourcePaths[0] ?? ""),
  );

  // 2) Un run EXPLORE per proposta (cap già applicato): SOLO il body, i figli ignorati.
  for (const [proposalIndex, proposal] of proposals.entries()) {
    // Sanificazione: sourcePaths validi (già normalizzati dal parser); parentSlug tra gli
    // slug reali, altrimenti radice (null). Una proposta senza sourcePaths è SCARTATA: non
    // ripieghiamo su `areas[0]?.path` perché per la 2ª+ proposta sarebbe l'area SBAGLIATA e
    // la pagina finirebbe a coprire file altrui. L'area resta nel residuo (già in `residual`).
    const sourcePaths = proposal.sourcePaths;
    const parentSlug =
      proposal.parentSlug !== null && validParentSlugs.has(proposal.parentSlug)
        ? proposal.parentSlug
        : null;
    const parentPage = parentSlug !== null ? treeContext.find((p) => p.slug === parentSlug) : undefined;
    const unitRef = sourcePaths[0];
    if (unitRef === undefined) continue;

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
        ...sessionOf(deps),
        ...(provider !== undefined ? { provider } : {}),
      });
      cost += exploreRun.usage?.totalCostUsd ?? 0;
      stopOnLimit(exploreRun);

      const parsed = parseExploreOutput(exploreRun.output);
      // Body invalido (vuoto / troppo corto / meta-summary) o contratto rotto: scarto,
      // l'area resta nel residuo (già in `residual`).
      if ("reason" in parsed) continue;
      const body = parsed.body;

      // sourcePath della pagina: quello risolto da `resolveGrowSourcePaths` (allargato all'area
      // se copertura 1:1), e solo in sua assenza quello (potenzialmente più stretto) dell'explore.
      // Il sourcePath persistito determina quali file futuri l'area considera già coperti; è
      // allineato allo svuotamento del residuo qui sotto (ancestor-only, come `pathCovers`).
      const pageSourcePath = pageSourcePaths[proposalIndex] || parsed.sourcePaths[0] || null;

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
      // L'area documentata esce dal residuo SOLO se il sourcePath PERSISTITO la copre nel senso
      // ANCESTOR-ONLY di `pathCovers` (antenato-o-uguale): così "coperta adesso" ⇔ "coperta ai
      // push futuri". Un sourcePath più stretto dell'area (suddivisione fine) NON la rimuove →
      // resta segnalata onestamente finché non è coperta del tutto.
      if (pageSourcePath !== null) {
        for (const area of areas) {
          if (area.path === pageSourcePath || area.path.startsWith(`${pageSourcePath}/`)) {
            residual.delete(area.path);
          }
        }
      }
    } catch (err) {
      if (isLimitStop(err)) {
        // Le pagine già create restano: il chiamante ne salva le stats e si ferma.
        return {
          createdPages,
          cost,
          chunkCount,
          residualAreas: Array.from(residual).sort(),
          limited: true,
        };
      }
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
  deps: AutoUpdateRunDeps,
  ctx: ProjectContext,
  generationId: string,
  pagesWithRefs: PageRef[],
  material: string[],
  commitSubjects: string[],
  provider: ResolvedProvider | undefined,
  repositoryId: string,
  confidentialFacts: BriefConfidentialFact[],
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
          confidentialFacts,
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
        if (g.limited) throw new AutoUpdateLimitStop();
      }
    });
  } catch (err) {
    if (isLimitStop(err)) throw err;
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

  // Sessione dell'aggiornamento: è un JOB, non una generazione (può non
  // averne una corrente), quindi `doc_update:<jobId>` senza doc_generation_id.
  // Nasce solo qui, dopo i gate (rumore, provider bloccato): un push che non
  // fa partire nessun run non lascia una sessione vuota. Solo col runner in
  // streaming, fail-open; in sola lettura (`docs` non è interattiva).
  const runDeps: AutoUpdateRunDeps = {
    ...deps,
    ...(await sessionOption(deps.runner, () =>
      docUpdateSession(deps.db, { id: job.id, repositoryId: job.repositoryId }),
    )),
  };

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
    // Fatti riservati del brief della generazione corrente: servono al guard del refresh di
    // pagine product (audit del body rinfrescato prima di persistere). Caricati una volta.
    const confidentialFacts = await loadConfidentialFacts(deps.db, ctx.currentDocGenerationId);
    try {
      refresh = await refreshAndGrowPages(
        runDeps,
        ctx,
        ctx.currentDocGenerationId,
        pagesWithRefs,
        material,
        commitSubjects,
        resolved.provider,
        job.repositoryId,
        confidentialFacts,
      );
    } catch (err) {
      if (!isLimitStop(err)) throw err;
      console.error(
        `[stubwise-worker] auto-update: provider AI al limite durante refresh/creazione del repository ${job.repositoryId}: aggiornamento interrotto, nessuna entry`,
      );
      return;
    }
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
    const result = await runDeps.runner.run({
      cwd: process.cwd(),
      prompt,
      model: deps.model,
      permissionMode: "plan",
      maxTurns: deps.maxTurns,
      timeoutMs: deps.agentTimeoutMs,
      ...sessionOf(runDeps),
      ...(resolved.provider !== undefined ? { provider: resolved.provider } : {}),
    });
    if (isLimitError(result)) {
      console.error(
        `[stubwise-worker] auto-update: agente di release del repository ${job.repositoryId} al limite del provider AI: nessuna entry`,
      );
      return;
    }
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

  // Entry release: pagina PERSISTENTE (generationId null, come le manuali). La
  // significatività vive nella colonna `significant` (filtrabile dalla vista changelog),
  // non più come prefisso "[minore]" nel titolo; position decrescente nel tempo così le
  // più recenti sono in cima.
  const now = new Date();
  const slug = await uniqueReleaseSlug(deps.db, job.repositoryId, job.toSha, now);
  const title = notes.title;
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
      significant: notes.significant,
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
