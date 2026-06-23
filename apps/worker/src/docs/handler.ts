import type { Db } from "@stubwise/db";
import type { EmbeddingClient } from "@stubwise/embeddings";
import type { AgentRunner } from "../agent/runner.js";
import type { MirrorManager } from "../git/mirrors.js";
import type { ProjectSerializer } from "../handler.js";
import { loadProviderChain, type ResolvedProvider } from "../providers/chain.js";
import { failDocJob, type DocJob } from "./queue.js";
import { runDocGenerationJob } from "./pipeline.js";

/**
 * Wiring del job di doc-generation per runWorker: handler(job) =
 * runDocGenerationJob, accodato alla catena per-progetto CONDIVISA con
 * l'handler fix. Un doc-job e un fix-job dello STESSO progetto non possono
 * sovrapporsi (vedi createProjectSerializer / il limite fetch --prune di
 * MirrorManager); progetti diversi restano paralleli.
 *
 * runDocGenerationJob chiude SEMPRE il job da sé (completeDocJob/failDocJob/
 * holdDocJob) su ogni percorso, quindi l'handler non gestisce la chiusura:
 * intercetta solo un throw inatteso (fuori dai percorsi gestiti) per marcare
 * il job `failed` invece di lasciarlo orfano fino a requeueStaleDocJobs.
 */
export interface DocHandlerDeps {
  db: Db;
  runner: AgentRunner;
  mirrors: MirrorManager;
  embeddingClient: EmbeddingClient;
  /** Chiave AES-256 per decifrare le credenziali dell'account git. */
  encryptionKey: Buffer;
  /** Modello AI della generazione (config.docGenerationModel). */
  model: string;
  /** Tetto al numero di moduli mappati (config.docMaxModules). */
  maxModules: number;
  /** Tetto al numero di capability documentate in profondità (config.docMaxCapabilities). */
  maxCapabilities: number;
  /** Turni massimi dell'agent per la pagina di un modulo (config.docModuleMaxTurns). */
  moduleMaxTurns: number;
  /** Timeout (ms) di OGNI run dell'agent per modulo/reduce. */
  agentTimeoutMs: number;
  /** Cap di costo per generazione in USD; undefined = nessun cap. */
  costCapUsd?: number;
  /** Caricatore della catena di provider AI (iniettabile nei test). Default:
   * loadProviderChain. La PRIMA voce della catena è la credenziale usata. */
  loadProviderChainFn?: (db: Db, encryptionKey: Buffer) => Promise<ResolvedProvider[]>;
}

/**
 * Crea l'handler doc-generation per runWorker. `serializer` è la catena
 * per-progetto, la STESSA dell'handler fix (passata da index.ts): è ciò che
 * garantisce la serializzazione doc↔fix sullo stesso progetto.
 */
export function createDocHandler(
  deps: DocHandlerDeps,
  serializer: ProjectSerializer,
): (job: DocJob) => Promise<void> {
  return function handler(job: DocJob): Promise<void> {
    // Il doc-job porta già il projectId: niente join, si accoda direttamente
    // alla catena del progetto.
    return serializer.run(job.projectId, async () => {
      // La prima credenziale della catena, come la pipeline fix. Catena vuota
      // → undefined = auth storica del container (nessun provider iniettato).
      const loadChain = deps.loadProviderChainFn ?? loadProviderChain;
      const chain = await loadChain(deps.db, deps.encryptionKey);
      const provider = chain[0];

      await runDocGenerationJob(
        {
          db: deps.db,
          mirrors: deps.mirrors,
          runner: deps.runner,
          embeddingClient: deps.embeddingClient,
          encryptionKey: deps.encryptionKey,
          model: deps.model,
          maxModules: deps.maxModules,
          maxCapabilities: deps.maxCapabilities,
          moduleMaxTurns: deps.moduleMaxTurns,
          agentTimeoutMs: deps.agentTimeoutMs,
          ...(deps.costCapUsd !== undefined ? { costCapUsd: deps.costCapUsd } : {}),
          ...(provider !== undefined ? { provider } : {}),
        },
        job,
      );
    });
  };
}

/**
 * Marca un doc-job `failed` quando l'handler lancia un'eccezione inattesa (il
 * mirror di runJob → failJob della coda fix, ma per i doc-job). best-effort:
 * un failDocJob fallito lascia il job orfano da recuperare con
 * requeueStaleDocJobs.
 */
export async function failDocJobOnError(db: Db, job: DocJob, err: unknown): Promise<void> {
  const message = err instanceof Error ? err.message : String(err);
  try {
    await failDocJob(db, job.id, {
      log: `[docs] handler fallito: ${message}`,
      error: message,
    });
  } catch {
    // Anche il failDocJob è fallito (DB irraggiungibile?): il job resta running
    // e verrà recuperato da requeueStaleDocJobs.
  }
}
