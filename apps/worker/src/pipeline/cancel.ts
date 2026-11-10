import { aiJobs, type Db } from "@stubwise/db";
import { AI_JOB_CANCEL_CHANNEL } from "@stubwise/shared";
import { and, inArray, isNotNull } from "drizzle-orm";
import { AgentRunCancelledError, type AgentRunner, type AgentRunOptions } from "../agent/runner.js";

/**
 * «Annulla il lavoro» su un job IN ESECUZIONE (integrazione area 3, 3b.1-bis;
 * decisione del maintainer del 10 nov 2026). Il server scrive la richiesta
 * (`ai_jobs.cancel_requested_at`/`_by_user_id`, migrazione 0124) e la annuncia
 * con un NOTIFY (`AI_JOB_CANCEL_CHANNEL`); il worker la riceve qui.
 *
 * - La COLONNA è la fonte: sopravvive a un LISTEN caduto e a un riavvio. Il
 *   NOTIFY è la sveglia immediata; un controllo periodico della colonna
 *   (`startCancelWatch`, sui soli job registrati) è la rete.
 * - Ogni job in corso ha un AbortController nel registro. Il runner del job è
 *   avvolto da `withCancelSignal`: ogni run riceve il segnale, e lo streaming
 *   ferma il CLI sul percorso di sempre (`AgentRunCancelledError`, lo stesso
 *   dello «Ferma» scaduto). Qui diventa `RunCancelRequestedError`, una
 *   sottoclasse: i catch di fix e correzione lo prendono già (job `skipped`,
 *   niente push né PR), e scelgono solo il commento giusto.
 * - Fra i passi, prima di commit e push, `assertNotCancelled`: un annullamento
 *   arrivato a CLI già uscito non lascia partire il push. Dopo il push la PR si
 *   apre comunque: il lavoro è già sul remoto, e annullare lì non toglierebbe
 *   niente (limite dichiarato).
 * Come il relay e il serializer, presuppone un worker a processo SINGOLO.
 */

/** Il job è stato annullato da una persona («Annulla il lavoro»), non da una pausa scaduta. */
export class RunCancelRequestedError extends AgentRunCancelledError {
  constructor(partialOutput = "") {
    super(null, partialOutput, 0);
    this.name = "RunCancelRequestedError";
    this.message = "lavoro annullato da una persona («Annulla il lavoro»)";
  }
}

export interface CancelRegistry {
  /** Registra un job in corso: il suo segnale, e la funzione che lo toglie. */
  register(jobId: string): { signal: AbortSignal; release: () => void };
  abort(jobId: string): void;
  ids(): string[];
}

export function createCancelRegistry(): CancelRegistry {
  const controllers = new Map<string, AbortController>();
  return {
    register(jobId) {
      const controller = new AbortController();
      controllers.set(jobId, controller);
      return {
        signal: controller.signal,
        release: () => {
          if (controllers.get(jobId) === controller) controllers.delete(jobId);
        },
      };
    },
    abort(jobId) {
      controllers.get(jobId)?.abort();
    },
    ids: () => [...controllers.keys()],
  };
}

/** Il runner del job, col segnale dell'annullamento passato a ogni run. */
export function withCancelSignal(runner: AgentRunner, signal: AbortSignal): AgentRunner {
  return {
    ...(runner.recordsSessions !== undefined ? { recordsSessions: runner.recordsSessions } : {}),
    async run(opts: AgentRunOptions) {
      try {
        return await runner.run({ ...opts, signal: opts.signal ?? signal });
      } catch (error) {
        if (error instanceof AgentRunCancelledError && !(error instanceof RunCancelRequestedError) && signal.aborted) {
          throw new RunCancelRequestedError(error.partialOutput);
        }
        throw error;
      }
    },
  };
}

/** Fra i passi: se l'annullamento è arrivato, ci si ferma qui (prima di commit e push). */
export function assertNotCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new RunCancelRequestedError();
}

/**
 * La sveglia: LISTEN sul canale (payload `{ jobId }`) e, ogni `pollMs`, la
 * colonna dei job registrati. Fail-open: un LISTEN che non parte lascia il
 * solo controllo periodico. Restituisce lo stop.
 */
export async function startCancelWatch(deps: {
  db: Db;
  registry: CancelRegistry;
  listen?: (channel: string, cb: (payload: string) => void) => Promise<unknown>;
  pollMs?: number;
  log?: (line: string) => void;
}): Promise<() => void> {
  const check = async (ids: string[]) => {
    if (ids.length === 0) return;
    const rows = await deps.db
      .select({ id: aiJobs.id })
      .from(aiJobs)
      .where(and(inArray(aiJobs.id, ids), isNotNull(aiJobs.cancelRequestedAt)));
    for (const r of rows) deps.registry.abort(r.id);
  };
  if (deps.listen) {
    try {
      await deps.listen(AI_JOB_CANCEL_CHANNEL, (payload) => {
        try {
          const jobId = (JSON.parse(payload) as { jobId?: unknown }).jobId;
          if (typeof jobId === "string") deps.registry.abort(jobId);
        } catch {
          // payload illeggibile: ci pensa il controllo periodico
        }
      });
    } catch (error) {
      deps.log?.(`annullamenti: LISTEN fallito, resta il controllo periodico: ${String(error)}`);
    }
  }
  const timer = setInterval(() => {
    void check(deps.registry.ids()).catch((error: unknown) => deps.log?.(`annullamenti: controllo fallito: ${String(error)}`));
  }, deps.pollMs ?? 10_000);
  timer.unref?.();
  return () => clearInterval(timer);
}

/** Al momento della registrazione: una richiesta arrivata prima che il job fosse registrato non si perde. */
export async function checkCancelNow(db: Db, registry: CancelRegistry, jobId: string): Promise<void> {
  const [row] = await db
    .select({ id: aiJobs.id })
    .from(aiJobs)
    .where(and(inArray(aiJobs.id, [jobId]), isNotNull(aiJobs.cancelRequestedAt)));
  if (row) registry.abort(jobId);
}
