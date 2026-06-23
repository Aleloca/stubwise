import {
  decrypt,
  docGenerationJobs,
  docGenerations,
  docPages,
  gitAccounts,
  projects,
  type Db,
} from "@stubwise/db";
import {
  buildRepoMap,
  runGeneration,
  type GeneratedPage,
} from "@stubwise/docs-engine";
import type { EmbeddingClient } from "@stubwise/embeddings";
import { and, eq, ne, sql } from "drizzle-orm";
import { execa } from "execa";
import { z } from "zod";
import type { AgentRunner } from "../agent/runner.js";
import { MirrorManager, type MirrorProject } from "../git/mirrors.js";
import type { ResolvedProvider } from "../providers/chain.js";
import { EMBED_BATCH_SIZE, embedAndStoreChunks } from "./embed.js";
import {
  completeDocJob,
  failDocJob,
  holdDocJob,
  touchDocJob,
  type DocJob,
} from "./queue.js";
import { createWorktreeReader } from "./reader.js";

/**
 * Pipeline di generazione della documentazione (centro del dominio Docs).
 *
 * Tiene insieme: MirrorManager (worktree effimero, riuso della pipeline fix),
 * docs-engine (buildRepoMap + runGeneration map-reduce, PURO), un AgentRunner
 * read-only (`permissionMode: "plan"`) e un EmbeddingClient. Tutto è iniettato
 * via `deps` perché la pipeline è testata end-to-end con un FakeAgentRunner e un
 * fake embedding client (vedi pipeline.test.ts).
 *
 * Flusso:
 *  1. carica progetto + account git, decifra le credenziali, costruisce il
 *     MirrorProject;
 *  2. apre un worktree (`withWorktree`, read-only): risolve il commit HEAD,
 *     costruisce il RepoMap, esegue runGeneration con l'agent reale, persiste
 *     pagine + chunk con embedding, accumula il costo;
 *  3. fuori dal worktree: chiude la generazione come `succeeded`, fa lo SWAP del
 *     puntatore `currentDocGenerationId`, PRUNA le generazioni vecchie e chiude il
 *     job;
 *  4. cap di costo: se il costo aggregato supera un tetto configurato, la
 *     generazione viene marcata `failed` e il job messo in `held` con una ragione
 *     LOGGATA (mai un cap silenzioso);
 *  5. su qualunque errore: generazione `failed`, job `failed`, NESSUNO swap.
 *
 * Branch del worktree: `withWorktree` richiede un branch `stubwise/<safe>` e fa
 * `switch -C`. La generazione è read-only e non committa né pusha nulla, quindi il
 * branch è solo un'etichetta effimera (cancellata all'uscita).
 */

/**
 * Drizzle DB o una sua transazione: i due espongono la stessa interfaccia di
 * query, così gli helper di persistenza funzionano sia con `db` sia con il `tx`
 * passato dentro `db.transaction(...)`.
 */
type DbOrTx = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];

/** Branch effimero (read-only) del worktree di doc-generation. */
const DOC_BRANCH = "stubwise/docs-generation";

/** Forma attesa delle credenziali git decifrate (vedi pipeline/fix.ts). */
const credentialsSchema = z.object({
  username: z.string().min(1).optional(),
  email: z.string().min(1).optional(),
  token: z.string().min(1),
});

export interface RunDocGenerationDeps {
  db: Db;
  mirrors: MirrorManager;
  runner: AgentRunner;
  embeddingClient: EmbeddingClient;
  /** Chiave AES-256 per decifrare le credenziali dell'account git. */
  encryptionKey: Buffer;
  /** Modello AI usato dall'agent per la generazione (es. "opus"). */
  model: string;
  /** Tetto al numero di moduli mappati (docs-engine taglia oltre). */
  maxModules: number;
  /** Tetto al numero di capability documentate in profondità (deep pass; docs-engine
   * logga le eccedenti in `cappedCapabilities`). */
  maxCapabilities: number;
  /** Turni massimi dell'agent per la pagina di un modulo. */
  moduleMaxTurns: number;
  /** Timeout (ms) di OGNI run dell'agent per modulo/reduce. */
  agentTimeoutMs: number;
  /**
   * Cap di costo per singola generazione in USD. Se il costo aggregato lo supera,
   * la generazione è marcata `failed` e il job messo in `held` (ragione loggata).
   * undefined = nessun cap (comportamento per default in assenza di config).
   */
  costCapUsd?: number;
  /** Credenziale AI risolta dalla catena (prima voce); undefined = auth storica. */
  provider?: ResolvedProvider;
  /**
   * Override del tetto di input per chiamata `embed()` (default `EMBED_BATCH_SIZE`).
   * Pensato per i test (batch piccoli senza fixture giganti); in produzione non
   * va impostato.
   */
  embedBatchSize?: number;
}

export type DocGenerationOutcome = "succeeded" | "failed" | "held";

/** Statistiche libere salvate in `doc_generations.stats` (jsonb). */
interface DocGenerationStats {
  modules: number;
  moduleFailures: string[];
  /** Numero di pagine funzionali profonde prodotte dal deep pass per-capability. */
  capabilities: number;
  /** Titoli delle capability il cui deep pass è fallito (fallback all'indice). */
  capabilityFailures: string[];
  /**
   * Titoli delle capability tagliate dal budget `maxCapabilities` (non documentate in
   * profondità). Persistite qui: il cap è LOGGATO, mai un drop silenzioso.
   */
  cappedCapabilities: string[];
  pages: number;
  chunks: number;
  /** true se lo step di reduce è fallito (overview/capability-map vuote). */
  reduceFailed: boolean;
}

/** git locale nel worktree (HEAD del commit documentato), niente auth. */
/** Timeout (ms) del `git rev-parse HEAD` nel worktree (repo patologico → no appeso). */
const GIT_REV_PARSE_TIMEOUT_MS = 60_000;

async function resolveHeadSha(dir: string): Promise<string> {
  const { stdout } = await execa("git", ["rev-parse", "HEAD"], {
    cwd: dir,
    timeout: GIT_REV_PARSE_TIMEOUT_MS,
  });
  return stdout.trim();
}

/**
 * Esegue una generazione di documentazione per il progetto del job. Chiude SEMPRE
 * il job qui dentro (completeDocJob/failDocJob/holdDocJob). Da chiamare serialmente
 * per progetto (come la pipeline fix): condivide il MirrorManager e il vincolo
 * del fetch --prune.
 */
export async function runDocGenerationJob(
  deps: RunDocGenerationDeps,
  job: DocJob,
): Promise<DocGenerationOutcome> {
  const { db, mirrors, runner, embeddingClient } = deps;
  const providerOpt = deps.provider !== undefined ? { provider: deps.provider } : {};

  // Carica progetto + account git collegato in un colpo (come la pipeline fix).
  const [row] = await db
    .select({ project: projects, account: gitAccounts })
    .from(projects)
    .innerJoin(gitAccounts, eq(projects.gitAccountId, gitAccounts.id))
    .where(eq(projects.id, job.projectId));
  if (!row) {
    await failDocJob(db, job.id, {
      log: `[docs] progetto ${job.projectId} o account git collegato non trovato`,
      error: "progetto del job non trovato",
    });
    return "failed";
  }
  const { project, account } = row;

  // Credenziali: decifratura + parse PRIMA di toccare il repo. MAI il payload nel log.
  let credentials: z.infer<typeof credentialsSchema>;
  try {
    credentials = credentialsSchema.parse(
      JSON.parse(decrypt(account.encryptedCredentials, deps.encryptionKey)),
    );
  } catch {
    await failDocJob(db, job.id, {
      log: "[docs] impossibile decifrare le credenziali dell'account git (ENCRYPTION_KEY errata o payload non valido)",
      error: "credenziali dell'account git non decifrabili",
    });
    return "failed";
  }

  const mirrorProject: MirrorProject = {
    provider: project.provider,
    repoUrl: project.repoUrl,
    defaultBranch: project.defaultBranch,
    credentials,
  };

  // Crea la riga di generazione `running` e la collega al job. Il commitSha viene
  // fissato dentro il worktree (HEAD effettivo del checkout).
  const [generation] = await db
    .insert(docGenerations)
    .values({
      projectId: project.id,
      status: "running",
      trigger: job.trigger,
      model: deps.model,
      startedAt: sql`now()`,
    })
    .returning();
  if (!generation) {
    await failDocJob(db, job.id, {
      log: "[docs] insert della generazione non ha restituito la riga",
      error: "insert doc_generations fallito",
    });
    return "failed";
  }

  await db
    .update(docGenerationJobs)
    .set({ generationId: generation.id })
    .where(eq(docGenerationJobs.id, job.id));

  let costUsd = 0;
  let stats: DocGenerationStats = {
    modules: 0,
    moduleFailures: [],
    capabilities: 0,
    capabilityFailures: [],
    cappedCapabilities: [],
    pages: 0,
    chunks: 0,
    reduceFailed: false,
  };
  let commitSha = "";

  try {
    await mirrors.ensureMirror(mirrorProject);
    // `withWorktree` ritorna commitSha + stats: niente assegnazione a un `let`
    // esterno, così un `succeeded` non può finire con uno sha vuoto dopo un
    // refactor (il valore è strutturalmente legato all'esito del callback).
    const built = await mirrors.withWorktree(mirrorProject, DOC_BRANCH, async (dir) => {
      const sha = await resolveHeadSha(dir);
      await touchDocJob(db, job.id);

      const reader = createWorktreeReader(dir);
      const repoMap = await buildRepoMap(reader, { maxModules: deps.maxModules });

      // Agent read-only: ogni run accumula il costo riportato dal CLI.
      const agent = async (i: { prompt: string; cwd?: string }): Promise<string> => {
        const result = await runner.run({
          cwd: dir,
          prompt: i.prompt,
          model: deps.model,
          permissionMode: "plan",
          maxTurns: deps.moduleMaxTurns,
          timeoutMs: deps.agentTimeoutMs,
          ...providerOpt,
        });
        costUsd += result.usage?.totalCostUsd ?? 0;
        return result.output;
      };

      const result = await runGeneration({
        repoMap,
        agent,
        cwd: dir,
        limits: { maxModules: deps.maxModules, maxCapabilities: deps.maxCapabilities },
        onProgress: () => {
          // Heartbeat: una generazione lunga continua a battere così
          // requeueStaleDocJobs non la riporta in coda (doppia generazione).
          // `.catch` per non trasformare un blip del DB in unhandled rejection.
          void touchDocJob(db, job.id).catch(() => {});
        },
      });

      // Reduce fallito = sia overview che capability-map hanno corpo vuoto. Le
      // chiamate di embedding sono già calcolate qui; gli insert vengono fatti
      // ATOMICAMENTE in transazione, così un throw a metà persistenza fa rollback
      // a ZERO righe (niente doc_pages/doc_chunks orfani sotto un `failed`).
      const reduceFailed = isReduceFailed(result.pages);
      const { pages, chunks } = await db.transaction(async (tx) => {
        const persisted = await persistPages(tx, {
          projectId: project.id,
          generationId: generation.id,
          pages: result.pages,
        });
        const embedded = await embedAndStoreChunks(tx, embeddingClient, {
          projectId: project.id,
          generationId: generation.id,
          pages: persisted,
          batchSize: deps.embedBatchSize ?? EMBED_BATCH_SIZE,
        });
        return { pages: persisted.length, chunks: embedded.chunkCount };
      });

      return {
        commitSha: sha,
        stats: {
          modules: repoMap.modules.length,
          moduleFailures: result.moduleFailures,
          capabilities: countCapabilityPages(result.pages),
          capabilityFailures: result.capabilityFailures,
          cappedCapabilities: result.cappedCapabilities,
          pages,
          chunks,
          reduceFailed,
        },
      };
    });
    commitSha = built.commitSha;
    stats = built.stats;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await db
      .update(docGenerations)
      .set({ status: "failed", error: message, finishedAt: sql`now()` })
      .where(eq(docGenerations.id, generation.id));
    await failDocJob(db, job.id, {
      log: `[docs] generazione fallita: ${message}`,
      error: message,
    });
    return "failed";
  }

  const costString = costUsd.toFixed(6);

  // Cap di costo: niente cap silenzioso. Se sforato, la generazione è `failed`,
  // il job è `held` con ragione loggata e NON si fa lo swap del puntatore.
  if (deps.costCapUsd !== undefined && costUsd > deps.costCapUsd) {
    const reason = `costo della generazione $${costString} oltre il tetto di $${deps.costCapUsd.toFixed(6)}`;
    await db
      .update(docGenerations)
      .set({
        status: "failed",
        cost: costString,
        stats,
        error: reason,
        finishedAt: sql`now()`,
      })
      .where(eq(docGenerations.id, generation.id));
    console.error(`[stubwise-worker] doc-generation ${generation.id} sospesa: ${reason}`);
    await holdDocJob(db, job.id, { reason });
    return "held";
  }

  // Chiude la generazione come `succeeded` con costo + commitSha + stats.
  await db
    .update(docGenerations)
    .set({
      status: "succeeded",
      commitSha,
      cost: costString,
      stats,
      finishedAt: sql`now()`,
    })
    .where(eq(docGenerations.id, generation.id));

  // SWAP: il puntatore `currentDocGenerationId` passa alla nuova generazione SOLO
  // ora (su successo). La ricerca/lettura usano la generazione corrente.
  await db
    .update(projects)
    .set({ currentDocGenerationId: generation.id })
    .where(eq(projects.id, project.id));

  // PRUNE: si tengono SOLO la corrente + la precedente. Le più vecchie sono
  // rimosse (cascade su doc_pages/doc_chunks via FK onDelete: cascade).
  await pruneOldGenerations(db, project.id, generation.id);

  // Cap/failures delle capability: se non vuoti vanno LOGGATI (mai un drop silenzioso),
  // così la riga di completamento li rende visibili oltre alle stats persistite.
  const capCounts =
    stats.capabilityFailures.length > 0 || stats.cappedCapabilities.length > 0
      ? ` (failures=${stats.capabilityFailures.length}, capped=${stats.cappedCapabilities.length})`
      : "";
  await completeDocJob(db, job.id, {
    log: `[docs] generazione completata: ${stats.pages} pagine, ${stats.capabilities} capability${capCounts}, ${stats.chunks} chunk, costo $${costString}`,
    generationId: generation.id,
  });
  return "succeeded";
}

interface PersistPagesInput {
  projectId: string;
  generationId: string;
  pages: GeneratedPage[];
}

/** Pagina persistita con il suo id (per la mappatura slug → parentId dei chunk). */
interface PersistedPage {
  id: string;
  slug: string;
  body: string;
  kind: GeneratedPage["kind"];
  sourcePath: string | null;
}

/**
 * Persiste l'albero di pagine. Le pagine arrivano già ordinate genitore-prima
 * dell'orchestrazione (overview prima dei moduli figli, capability-map prima delle
 * capability), così la mappa slug → id è popolata quando si risolve il parentSlug.
 * `position` è l'indice di emissione (ordine stabile). `parentId` deriva dalla
 * mappa: uno slug genitore mai visto resta null (difesa anti-orfano, non dovrebbe
 * accadere).
 */
async function persistPages(
  db: DbOrTx,
  input: PersistPagesInput,
): Promise<PersistedPage[]> {
  const slugToId = new Map<string, string>();
  const persisted: PersistedPage[] = [];
  let position = 0;
  for (const page of input.pages) {
    const parentId = page.parentSlug ? (slugToId.get(page.parentSlug) ?? null) : null;
    const [stored] = await db
      .insert(docPages)
      .values({
        projectId: input.projectId,
        generationId: input.generationId,
        kind: page.kind,
        slug: page.slug,
        title: page.title,
        parentId,
        position,
        sourcePath: page.sourcePath,
        body: page.body,
      })
      .returning({ id: docPages.id });
    if (!stored) throw new Error(`insert della pagina '${page.slug}' non ha restituito la riga`);
    slugToId.set(page.slug, stored.id);
    persisted.push({
      id: stored.id,
      slug: page.slug,
      body: page.body,
      kind: page.kind,
      sourcePath: page.sourcePath,
    });
    position += 1;
  }
  return persisted;
}

/**
 * Reduce fallito = le due pagine root sintetizzate (overview tecnica + mappa
 * capability) hanno entrambe corpo vuoto. Le pagine di modulo restano comunque
 * disponibili (best-effort), ma lo segnaliamo nelle stats.
 */
function isReduceFailed(pages: GeneratedPage[]): boolean {
  const roots = pages.filter((p) => p.parentSlug === null);
  if (roots.length === 0) return true;
  return roots.every((p) => p.body.trim() === "");
}

/**
 * Conta le pagine funzionali profonde prodotte dal deep pass per-capability: le
 * pagine `functional` figlie della mappa funzionale root (l'unica root funzionale).
 * Per le stats: quante capability sono state documentate in profondità in questo run.
 */
function countCapabilityPages(pages: GeneratedPage[]): number {
  const root = pages.find((p) => p.kind === "functional" && p.parentSlug === null);
  if (!root) return 0;
  return pages.filter((p) => p.kind === "functional" && p.parentSlug === root.slug)
    .length;
}

/**
 * Pruna le generazioni vecchie del progetto. Regola (semplice e corretta):
 *  - si tiene SEMPRE la corrente (`projects.currentDocGenerationId`), qualunque sia
 *    la sua posizione temporale: MAI prunata, anche se più vecchia di run `failed`
 *    o `held` più recenti (non c'è FK a proteggerla);
 *  - si tiene inoltre la singola generazione più recente DIVERSA dalla corrente,
 *    ordinando per (createdAt DESC, id DESC) — il tiebreaker su `id` rende l'ordine
 *    stabile quando due run condividono lo stesso `createdAt`;
 *  - tutto il resto è eliminato. Non si scende mai sotto "corrente + 1".
 *
 * La cascade FK (onDelete: cascade su doc_pages/doc_chunks) porta via pagine e chunk
 * delle generazioni rimosse. La delete porta comunque un guard `ne(currentId)` come
 * difesa in profondità: la corrente non può finire nel set da eliminare.
 */
export async function pruneOldGenerations(
  db: Db,
  projectId: string,
  currentGenerationId: string,
): Promise<void> {
  const rows = await db
    .select({ id: docGenerations.id })
    .from(docGenerations)
    .where(eq(docGenerations.projectId, projectId))
    .orderBy(sql`${docGenerations.createdAt} DESC`, sql`${docGenerations.id} DESC`);
  // Si tiene la corrente (sempre, autoritativo) + la più recente diversa dalla corrente.
  const keep = new Set<string>([currentGenerationId]);
  for (const r of rows) {
    if (r.id === currentGenerationId) continue;
    keep.add(r.id);
    break; // una sola "altra" generazione, la più recente per (createdAt, id) DESC.
  }
  const toDelete = rows.filter((r) => !keep.has(r.id)).map((r) => r.id);
  for (const id of toDelete) {
    await db
      .delete(docGenerations)
      .where(and(eq(docGenerations.id, id), ne(docGenerations.id, currentGenerationId)));
  }
}
