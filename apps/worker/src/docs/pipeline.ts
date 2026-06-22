import {
  decrypt,
  docChunks,
  docGenerationJobs,
  docGenerations,
  docPages,
  gitAccounts,
  projects,
  type Db,
} from "@stubwise/db";
import {
  buildRepoMap,
  chunkMarkdown,
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

/** Branch effimero (read-only) del worktree di doc-generation. */
const DOC_BRANCH = "stubwise/docs-generation";

/** Target/overlap del chunking markdown per l'embedding (token stimati). */
const CHUNK_TARGET_TOKENS = 400;
const CHUNK_OVERLAP_WORDS = 40;

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
}

export type DocGenerationOutcome = "succeeded" | "failed" | "held";

/** Statistiche libere salvate in `doc_generations.stats` (jsonb). */
interface DocGenerationStats {
  modules: number;
  moduleFailures: string[];
  pages: number;
  chunks: number;
}

/** git locale nel worktree (HEAD del commit documentato), niente auth. */
async function resolveHeadSha(dir: string): Promise<string> {
  const { stdout } = await execa("git", ["rev-parse", "HEAD"], {
    cwd: dir,
    timeout: 60_000,
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
  let stats: DocGenerationStats = { modules: 0, moduleFailures: [], pages: 0, chunks: 0 };
  let commitSha = "";

  try {
    await mirrors.ensureMirror(mirrorProject);
    const built = await mirrors.withWorktree(mirrorProject, DOC_BRANCH, async (dir) => {
      commitSha = await resolveHeadSha(dir);
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
        limits: { maxModules: deps.maxModules },
        onProgress: () => {
          // Heartbeat: una generazione lunga continua a battere così
          // requeueStaleDocJobs non la riporta in coda (doppia generazione).
          void touchDocJob(db, job.id);
        },
      });

      const pages = await persistPages(db, {
        projectId: project.id,
        generationId: generation.id,
        pages: result.pages,
      });
      const chunks = await embedAndStoreChunks(db, embeddingClient, {
        projectId: project.id,
        generationId: generation.id,
        pages,
      });

      return {
        modules: repoMap.modules.length,
        moduleFailures: result.moduleFailures,
        pages: pages.length,
        chunks,
      };
    });
    stats = built;
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

  await completeDocJob(db, job.id, {
    log: `[docs] generazione completata: ${stats.pages} pagine, ${stats.chunks} chunk, costo $${costString}`,
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
  db: Db,
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

interface EmbedAndStoreInput {
  projectId: string;
  generationId: string;
  pages: PersistedPage[];
}

/**
 * Per ogni pagina: chunk markdown-aware → embedding (una richiesta per pagina) →
 * insert dei `doc_chunks` con embedding (1024 dim) e metadata (heading, sourcePath,
 * layer=kind). Una pagina con corpo vuoto non produce chunk. Ritorna il numero
 * totale di chunk inseriti.
 */
async function embedAndStoreChunks(
  db: Db,
  embeddingClient: EmbeddingClient,
  input: EmbedAndStoreInput,
): Promise<number> {
  let total = 0;
  for (const page of input.pages) {
    const chunks = chunkMarkdown(page.body, {
      targetTokens: CHUNK_TARGET_TOKENS,
      overlap: CHUNK_OVERLAP_WORDS,
    });
    if (chunks.length === 0) continue;
    const embeddings = await embeddingClient.embed(chunks.map((c) => c.content));
    await db.insert(docChunks).values(
      chunks.map((chunk, i) => ({
        pageId: page.id,
        projectId: input.projectId,
        generationId: input.generationId,
        content: chunk.content,
        embedding: embeddings[i],
        metadata: {
          heading: chunk.heading,
          sourcePath: page.sourcePath,
          layer: page.kind,
        },
        tokenCount: estimateTokens(chunk.content),
      })),
    );
    total += chunks.length;
  }
  return total;
}

/** Stima grossolana dei token di un chunk (parole × 1.33), per `token_count`. */
function estimateTokens(text: string): number {
  const words = text.split(/\s+/).filter(Boolean).length;
  return Math.round(words * 1.33);
}

/**
 * Pruna le generazioni vecchie del progetto: si conservano la corrente e la
 * IMMEDIATAMENTE precedente (le due più recenti per createdAt), tutto il resto è
 * eliminato. La cascade FK (onDelete: cascade su doc_pages/doc_chunks) porta via
 * pagine e chunk delle generazioni rimosse.
 */
async function pruneOldGenerations(
  db: Db,
  projectId: string,
  currentGenerationId: string,
): Promise<void> {
  const rows = await db
    .select({ id: docGenerations.id })
    .from(docGenerations)
    .where(eq(docGenerations.projectId, projectId))
    .orderBy(sql`${docGenerations.createdAt} DESC`);
  // Si tiene la corrente (sempre) + la più recente diversa dalla corrente.
  const keep = new Set<string>([currentGenerationId]);
  for (const r of rows) {
    if (keep.size >= 2) break;
    keep.add(r.id);
  }
  const toDelete = rows.filter((r) => !keep.has(r.id)).map((r) => r.id);
  for (const id of toDelete) {
    await db
      .delete(docGenerations)
      .where(and(eq(docGenerations.id, id), ne(docGenerations.id, currentGenerationId)));
  }
}
