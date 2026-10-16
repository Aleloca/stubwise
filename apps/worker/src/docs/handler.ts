import { projects, repositories, type Db } from "@stubwise/db";
import { eq } from "drizzle-orm";
import type { AgentRunner } from "../agent/runner.js";
import type { MirrorManager } from "../git/mirrors.js";
import type { ProjectSerializer } from "../handler.js";
import {
  isQuotaWait,
  markLegacyLimited,
  markProviderLimitedFromText,
  selectProviders,
  type SelectDeps,
} from "../providers/select.js";
import { runOrientation } from "./recursive/orient-handler.js";
import type { GenerationWorktreeRegistry } from "./recursive/registry.js";
import { completeDocJob, failDocJob, holdDocJob, type DocJob } from "./queue.js";

/**
 * Wiring del TRIGGER di doc-generation per runWorker (M7): handler(job) =
 * runOrientation, accodato alla catena per-PROGETTO CONDIVISA con l'handler fix.
 *
 * Il trigger di documentazione avvia l'ORIENTAMENTO (M5a): apre il worktree di
 * generazione, lo registra nel registro in-processo (i job-nodo lo riusano), semina le
 * radici del DAG e — appena seminato — chiude il TRIGGER `succeeded` (decoupling C2). La
 * generazione prosegue poi via i job-nodo (dispatchNode nel loop) fino alla
 * finalizzazione; lo stato "generazione in corso" vive su `doc_generations`, NON sul
 * trigger (che è già concluso).
 *
 * SERIALIZZAZIONE (per-PROGETTO in Fase 3): l'orientamento gira nella catena per-progetto
 * (serializer condiviso) — fa `ensureMirror` + apre il worktree, e NON deve sovrapporsi a
 * un fix dello STESSO PROGETTO (un fix di progetto apre worktree su TUTTI i suoi repo, e il
 * suo `fetch --prune` cancellerebbe il ref del worktree di generazione). La catena
 * per-progetto garantisce che orientamento e fix dello stesso progetto non si
 * sovrappongano. Una volta seminato il DAG e REGISTRATO il worktree, la catena si libera:
 * da quel momento la mutua esclusione col fix è retta dal registro (activeProjectIds → il
 * claim non reclama fix di quel progetto finché il worktree è aperto, vedi queue.ts).
 *
 * GUARDIA NUOVA-GENERAZIONE: se il repository ha GIÀ una generazione attiva NON se ne avvia
 * una seconda — aprirebbe un secondo worktree concorrente sullo stesso mirror. Due
 * livelli: (1) qui il guard IN-PROCESSO del registro (`activeRepositoryIds`) come fast-path
 * — difesa in profondità che si azzera al riavvio; (2) dentro runOrientation il guard DB
 * AUTORITATIVO (`hasRunningGeneration`), che persiste tra i riavvii. In entrambi i casi
 * il trigger è `succeeded`-skip (nessun errore: una generazione è già in corso).
 *
 * runOrientation chiude da sé il trigger in OGNI esito (`succeeded` per seeded/skipped,
 * `failed` per orientamento invalido/piano vuoto/errore, `held` per provider al limite:
 * il trigger resta riaccodabile dal resume poller). L'handler intercetta solo un
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
  /**
   * Radice del volume dei knowledge graph (`GRAPHS_DIR`, fase 2c graphify): inoltrata
   * all'orientamento, che col grafo semina i prompt di brief/orientamento con la mappa
   * delle aree e i comandi di interrogazione. Assente → generazione identica a prima.
   */
  graphsDir?: string;
  /** La scelta dell'account del worker (providers/select.ts), la stessa di ogni run. */
  select: SelectDeps;
}

/**
 * Crea l'handler del trigger doc-generation per runWorker. `serializer` è la catena
 * per-PROGETTO, la STESSA dell'handler fix (passata da index.ts): è ciò che
 * garantisce la serializzazione orientamento↔fix sullo stesso PROGETTO (un fix di
 * progetto tiene worktree su tutti i suoi repo, incluso quello della generazione).
 */
export function createDocHandler(
  deps: DocHandlerDeps,
  serializer: ProjectSerializer,
): (job: DocJob) => Promise<void> {
  return async function handler(job: DocJob): Promise<void> {
    // Il doc-job porta il repositoryId; risolviamo il PROGETTO del repository (chiave del
    // serializer per-progetto) e il provider AI del progetto in un'unica join, PRIMA di
    // entrare nella catena. Se il repository non esiste più (o non ha progetto) marchiamo
    // il trigger `failed` con un messaggio chiaro.
    const [project] = await deps.db
      .select({
        projectId: repositories.projectId,
        aiProviderId: projects.aiProviderId,
        aiProviderExclusive: projects.aiProviderExclusive,
      })
      .from(repositories)
      .innerJoin(projects, eq(projects.id, repositories.projectId))
      .where(eq(repositories.id, job.repositoryId));
    if (!project) {
      await failDocJob(deps.db, job.id, {
        log: `[docs] repository ${job.repositoryId} o progetto collegato non trovato`,
        error: "repository del job non trovato",
      });
      return;
    }
    // Il pin della generazione nasce SOLO con «solo questo» (preflight D8, A-5;
    // regola A-1: vale solo con un id). Senza, il provider del progetto è
    // PREFERITO come per ogni altro lavoro, e i nodi possono passare agli altri
    // abbonamenti quando è al limite.
    const exclusivePin =
      project.aiProviderExclusive && project.aiProviderId ? project.aiProviderId : null;

    return serializer.run(project.projectId, async () => {
      // GUARDIA IN-PROCESSO (difesa in profondità): niente seconda generazione
      // concorrente sullo stesso repository se il registro ha già un worktree aperto. È un
      // fast-path che evita perfino di aprire il mirror; il check AUTORITATIVO (che
      // sopravvive al riavvio del worker) è la guardia DB dentro runOrientation
      // (hasRunningGeneration). Qui marco il trigger `succeeded`-skip senza errore: una
      // generazione è già in corso, il trigger ha fatto il suo dovere.
      if (deps.registry.activeRepositoryIds().has(job.repositoryId)) {
        await completeDocJob(deps.db, job.id, {
          log: "[docs] una generazione è già attiva per questo repository (worktree aperto, guard in-processo): trigger ignorato",
        });
        return;
      }

      // SCELTA DELL'ACCOUNT dell'orientamento (providers/select.ts, la stessa di
      // ogni run): generazione completa = lavoro di SFONDO (decisione A-6).
      //  - Nessun account con margine (tutti al limite, o oltre la soglia
      //    settimanale): il trigger va HELD `limit` — la ripresa lo riaccoda
      //    quando la stessa scelta trova un candidato con margine.
      //  - «Solo questo» su un provider disabilitato/sparito, o nessun segreto
      //    decifrabile: trigger `failed` (serve un intervento umano), mai un
      //    ripiego su un altro account.
      //  - Nessun provider abilitato: auth storica del container.
      const selection = await (deps.select.selectProvidersFn ?? selectProviders)(deps.select, {
        projectId: project.projectId,
        workClass: "background",
      });
      const provider = selection.candidates[0];
      if (!selection.legacyAuth && provider === undefined) {
        const reason = selection.emptyReason ?? "all_limited";
        if (isQuotaWait(reason)) {
          await holdDocJob(deps.db, job.id, {
            reason:
              "nessun account AI con margine (al limite o oltre la soglia settimanale): la generazione partirà alla ripresa automatica",
            heldReason: "limit",
          });
          return;
        }
        await failDocJob(deps.db, job.id, {
          log:
            reason === "exclusive_unavailable"
              ? "[docs] provider AI del progetto («solo questo») non disponibile (disabilitato o cancellato): generazione annullata"
              : "[docs] nessun provider AI utilizzabile (segreti non decifrabili): generazione annullata",
          error:
            reason === "exclusive_unavailable" ? "pinned_provider_unavailable" : "no_usable_provider",
        });
        return;
      }

      // runOrientation chiude da sé il trigger in OGNI esito: `succeeded` (seeded o
      // skipped per guard DB), `failed`, o `held` (provider al limite: il trigger resta
      // riaccodabile dal resume poller). Niente da fare qui dopo il ritorno.
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
          ...(deps.graphsDir !== undefined ? { graphsDir: deps.graphsDir } : {}),
          ...(provider !== undefined ? { provider } : {}),
          // Con «solo questo» il provider del progetto diventa il pin della
          // generazione: l'orientamento lo semina su doc_generations.pinned_provider_id
          // e i job-nodo lo rileggono. Una generazione nata con un pin resta rigida
          // anche se nel frattempo il vincolo viene tolto.
          ...(exclusivePin ? { pinnedProviderId: exclusivePin } : {}),
          // Orientamento al limite: l'account (o l'auth storica, in memoria) è
          // marcato fino all'ora del testo, così la ripresa non lo riprova prima
          // del reset.
          onProviderLimit: async (text: string) => {
            if (provider !== undefined) {
              await markProviderLimitedFromText(deps.select, provider.id, text);
            } else {
              markLegacyLimited(deps.select, text);
            }
          },
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
