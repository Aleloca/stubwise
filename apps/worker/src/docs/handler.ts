import type { Db } from "@stubwise/db";
import type { AgentRunner } from "../agent/runner.js";
import type { MirrorManager } from "../git/mirrors.js";
import type { ProjectSerializer } from "../handler.js";
import {
  loadProviderById,
  loadProviderChain,
  type ResolvedProvider,
} from "../providers/chain.js";
import { runOrientation } from "./recursive/orient-handler.js";
import type { GenerationWorktreeRegistry } from "./recursive/registry.js";
import { completeDocJob, failDocJob, type DocJob } from "./queue.js";

/**
 * Wiring del TRIGGER di doc-generation per runWorker (M7): handler(job) =
 * runOrientation, accodato alla catena per-progetto CONDIVISA con l'handler fix.
 *
 * Il trigger di documentazione avvia l'ORIENTAMENTO (M5a): apre il worktree di
 * generazione, lo registra nel registro in-processo (i job-nodo lo riusano), semina le
 * radici del DAG e — appena seminato — chiude il TRIGGER `succeeded` (decoupling C2). La
 * generazione prosegue poi via i job-nodo (dispatchNode nel loop) fino alla
 * finalizzazione; lo stato "generazione in corso" vive su `doc_generations`, NON sul
 * trigger (che è già concluso).
 *
 * SERIALIZZAZIONE: l'orientamento gira nella catena per-progetto (serializer condiviso)
 * — fa `ensureMirror` + apre il worktree, e NON deve sovrapporsi a un fix dello stesso
 * progetto (il fetch --prune del fix cancellerebbe il ref). Una volta seminato il DAG e
 * REGISTRATO il worktree, la catena si libera: da quel momento la mutua esclusione
 * col fix è retta dal registro (activeProjectIds → il loop non reclama fix di quel
 * progetto finché il worktree è aperto, vedi node-dispatch/queue.ts).
 *
 * GUARDIA NUOVA-GENERAZIONE: se il progetto ha GIÀ una generazione attiva NON se ne avvia
 * una seconda — aprirebbe un secondo worktree concorrente sullo stesso mirror. Due
 * livelli: (1) qui il guard IN-PROCESSO del registro (`activeProjectIds`) come fast-path
 * — difesa in profondità che si azzera al riavvio; (2) dentro runOrientation il guard DB
 * AUTORITATIVO (`hasRunningGeneration`), che persiste tra i riavvii. In entrambi i casi
 * il trigger è `succeeded`-skip (nessun errore: una generazione è già in corso).
 *
 * runOrientation chiude da sé il trigger in OGNI esito (`succeeded` per seeded/skipped,
 * `failed` per orientamento invalido/piano vuoto/errore). L'handler intercetta solo un
 * throw inatteso (fuori dai percorsi gestiti) per marcare il job `failed`.
 */
export interface DocHandlerDeps {
  db: Db;
  runner: AgentRunner;
  mirrors: MirrorManager;
  /** Registro in-processo dei worktree di generazione (M7): l'orientamento vi registra
   * il worktree aperto; il dispatch dei nodi e la guardia nuova-generazione lo leggono. */
  registry: GenerationWorktreeRegistry;
  /** Chiave AES-256 per decifrare le credenziali dell'account git. */
  encryptionKey: Buffer;
  /** Modello AI della generazione (config.docGenerationModel). */
  model: string;
  /** Timeout (ms) del run dell'agente di orientamento (config.docAgentTimeoutMs). */
  agentTimeoutMs: number;
  /** Turni massimi del run dell'agente di orientamento (config.docModuleMaxTurns). */
  maxTurns: number;
  /** Caricatore della catena di provider AI (iniettabile nei test). Default:
   * loadProviderChain. La PRIMA voce della catena è la credenziale usata. */
  loadProviderChainFn?: (db: Db, encryptionKey: Buffer) => Promise<ResolvedProvider[]>;
  /** Risolutore di UN provider per id (iniettabile nei test). Default:
   * loadProviderById. Usato quando il trigger ha un provider bloccato
   * (`pinnedProviderId`): se ritorna null la generazione è annullata, MAI fallback. */
  loadProviderByIdFn?: (
    db: Db,
    encryptionKey: Buffer,
    id: string,
  ) => Promise<ResolvedProvider | null>;
}

/**
 * Crea l'handler del trigger doc-generation per runWorker. `serializer` è la catena
 * per-progetto, la STESSA dell'handler fix (passata da index.ts): è ciò che
 * garantisce la serializzazione orientamento↔fix sullo stesso progetto.
 */
export function createDocHandler(
  deps: DocHandlerDeps,
  serializer: ProjectSerializer,
): (job: DocJob) => Promise<void> {
  return function handler(job: DocJob): Promise<void> {
    // Il doc-job porta già il projectId: niente join, si accoda direttamente
    // alla catena del progetto.
    return serializer.run(job.projectId, async () => {
      // GUARDIA IN-PROCESSO (difesa in profondità): niente seconda generazione
      // concorrente sullo stesso progetto se il registro ha già un worktree aperto. È un
      // fast-path che evita perfino di aprire il mirror; il check AUTORITATIVO (che
      // sopravvive al riavvio del worker) è la guardia DB dentro runOrientation
      // (hasRunningGeneration). Qui marco il trigger `succeeded`-skip senza errore: una
      // generazione è già in corso, il trigger ha fatto il suo dovere.
      if (deps.registry.activeProjectIds().has(job.projectId)) {
        await completeDocJob(deps.db, job.id, {
          log: "[docs] una generazione è già attiva per questo progetto (worktree aperto, guard in-processo): trigger ignorato",
        });
        return;
      }

      // Scelta della credenziale AI dell'INTERA generazione.
      //  - Con `pinnedProviderId` (provider BLOCCATO dall'utente): risolviamo SOLO
      //    quel provider. Se non è risolvibile al run (disabilitato/cancellato/segreto
      //    non decifrabile → loadProviderById = null) la generazione è ANNULLATA: trigger
      //    `failed`, NIENTE fallback su chain[0] (il pin è una scelta esplicita, non un
      //    suggerimento). L'utente ri-triggererà con un provider valido.
      //  - Senza pin: comportamento ATTUALE — la prima credenziale della catena (come la
      //    pipeline fix). Catena vuota → undefined = auth storica del container.
      let provider: ResolvedProvider | undefined;
      if (job.pinnedProviderId) {
        const loadById = deps.loadProviderByIdFn ?? loadProviderById;
        const pinned = await loadById(deps.db, deps.encryptionKey, job.pinnedProviderId);
        if (!pinned) {
          await failDocJob(deps.db, job.id, {
            log: "[docs] provider bloccato non disponibile (disabilitato o cancellato): generazione annullata",
            error: "pinned_provider_unavailable",
          });
          return;
        }
        provider = pinned;
      } else {
        const loadChain = deps.loadProviderChainFn ?? loadProviderChain;
        const chain = await loadChain(deps.db, deps.encryptionKey);
        provider = chain[0];
      }

      // runOrientation chiude da sé il trigger in OGNI esito: `succeeded` (seeded o
      // skipped per guard DB) o `failed`. Niente da fare qui dopo il ritorno.
      await runOrientation(
        {
          db: deps.db,
          mirrors: deps.mirrors,
          runner: deps.runner,
          registry: deps.registry,
          encryptionKey: deps.encryptionKey,
          model: deps.model,
          agentTimeoutMs: deps.agentTimeoutMs,
          maxTurns: deps.maxTurns,
          ...(provider !== undefined ? { provider } : {}),
          // Il pin è propagato alla generazione: l'orientamento lo semina su
          // doc_generations, i job-nodo lo rileggono per blindarsi sullo stesso provider.
          ...(job.pinnedProviderId ? { pinnedProviderId: job.pinnedProviderId } : {}),
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
