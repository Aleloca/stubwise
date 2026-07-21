import { backlogJobs } from "@stubwise/db";
import { backlogChatTurnPayloadSchema } from "@stubwise/shared";
import { and, eq, sql } from "drizzle-orm";
import type { Db } from "@stubwise/db";
import { createProjectSerializer, type ProjectSerializer } from "../handler.js";
import { runChatTurn, type ChatTurnDeps } from "./chat-turn.js";
import { claimNextChatTurnJob, type BacklogJob } from "./poller.js";

/**
 * POLLER VELOCE dei turni della sessione di analisi sul codice (`chat_turn`).
 *
 * Separato dal poller lento del backlog (20s, intake/deep_dive): i turni sono
 * interattivi (l'utente attende la risposta in chat) quindi girano su un proprio
 * intervallo breve (default 2s). Reclama SOLO i `chat_turn` (claimNextChatTurnJob,
 * indice parziale dei queued → costo trascurabile) e li esegue.
 *
 * SERIALIZZAZIONE PER-ITEM: due turni della STESSA voce non devono mai girare in
 * parallelo (un `--resume` concorrente della stessa sessione CLI, o doppia
 * apertura del worktree al primo turno). Ogni turno passa da un serializer keyed
 * per itemId (pattern createProjectSerializer): turni di voci DIVERSE procedono
 * in parallelo (chat reattiva), quelli della stessa voce si accodano.
 *
 * RECOVERY ORFANI: i `chat_turn` `running` col startedAt oltre soglia sono di un
 * worker crashato → `failed` SENZA retry (un turno non si ritenta: la domanda
 * resta in chat, l'utente può rimandarla).
 *
 * BEST-EFFORT: ogni job in try/catch isolato, l'intero tick idem; non fa MAI
 * crashare il worker. Si ferma sull'AbortSignal.
 */

/** Minuti oltre cui un `chat_turn` `running` è considerato orfano. */
export const CHAT_TURN_STALE_MINUTES = 15;

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Recupero degli orfani (fase 0 del tick): i `chat_turn` `running` col startedAt
 * oltre soglia sono di un worker crashato → `failed` (nessun retry). Un solo
 * UPDATE status-guarded. Il poller è single-process e i tick non si sovrappongono
 * (guard `running` in startChatTurnPoller), quindi un `running` stantio è sempre
 * orfano, mai vivo.
 */
export async function recoverStaleChatTurnJobs(db: Db, staleMinutes: number): Promise<void> {
  await db
    .update(backlogJobs)
    .set({ status: "failed", error: "worker crash durante il turno di chat", finishedAt: sql`now()` })
    .where(
      and(
        eq(backlogJobs.kind, "chat_turn"),
        eq(backlogJobs.status, "running"),
        sql`${backlogJobs.startedAt} < now() - make_interval(mins => ${staleMinutes}::int)`,
      ),
    );
}

async function completeChatTurnJob(db: Db, jobId: string): Promise<void> {
  await db
    .update(backlogJobs)
    .set({ status: "done", error: null, finishedAt: sql`now()` })
    .where(and(eq(backlogJobs.id, jobId), eq(backlogJobs.status, "running")));
}

/** Fallisce il turno SENZA riaccodarlo (un turno non si ritenta mai). */
async function failChatTurnJob(db: Db, jobId: string, error: string): Promise<void> {
  await db
    .update(backlogJobs)
    .set({ status: "failed", error, finishedAt: sql`now()` })
    .where(and(eq(backlogJobs.id, jobId), eq(backlogJobs.status, "running")));
}

export interface ChatTurnPollerDeps extends ChatTurnDeps {
  /** Minuti oltre cui un `running` è orfano. Default CHAT_TURN_STALE_MINUTES. */
  staleMinutes?: number;
  /** Esecutore del turno, iniettabile nei test. Default runChatTurn. */
  runChatTurnFn?: typeof runChatTurn;
  /** Stop cooperativo: interrompe il drain a metà tick. */
  signal?: AbortSignal;
}

/**
 * Processa UN job chat_turn: valida il payload (malformato → failed subito,
 * niente retry) e lo esegue nel serializer PER-ITEM. Successo → done; qualunque
 * errore → failed SENZA retry. Ritorna true se il turno è stato completato con
 * successo (utile ai test). Non lancia.
 */
async function processChatTurnJob(
  deps: ChatTurnPollerDeps,
  job: BacklogJob,
  serializer: ProjectSerializer,
): Promise<boolean> {
  const parsed = backlogChatTurnPayloadSchema.safeParse(job.payload);
  if (!parsed.success) {
    await failChatTurnJob(deps.db, job.id, `payload chat_turn non valido: ${parsed.error.message}`).catch(
      (err: unknown) =>
        deps.logger.error({ err, jobId: job.id }, "[backlog] chat turn: fallimento payload malformato"),
    );
    return false;
  }
  const runFn = deps.runChatTurnFn ?? runChatTurn;
  try {
    await serializer.run(parsed.data.itemId, () => runFn(deps, job, parsed.data));
    await completeChatTurnJob(deps.db, job.id);
    return true;
  } catch (err) {
    // Un turno NON si ritenta: failed diretto (la domanda resta in chat).
    await failChatTurnJob(deps.db, job.id, errText(err)).catch((txErr: unknown) =>
      deps.logger.error({ err: txErr, jobId: job.id }, "[backlog] chat turn: chiusura failed fallita"),
    );
    return false;
  }
}

/**
 * Esegue UN giro: (0) recovery degli orfani, poi reclama TUTTI i `chat_turn`
 * queued e li dispatcha in PARALLELO tra voci diverse (serializer per-item:
 * stessa voce ⇒ sequenziale). Attende il completamento di tutti i turni
 * dispatchati prima di ritornare (i tick non si sovrappongono). Ritorna il numero
 * di turni completati con successo. Non lancia mai.
 */
export async function pollChatTurnsOnce(deps: ChatTurnPollerDeps): Promise<number> {
  const staleMinutes = deps.staleMinutes ?? CHAT_TURN_STALE_MINUTES;
  try {
    await recoverStaleChatTurnJobs(deps.db, staleMinutes);
  } catch (err) {
    deps.logger.error({ err }, "[backlog] chat turn: recupero degli orfani fallito");
  }

  // Serializer PER-ITEM per QUESTO giro: due job della stessa voce reclamati nello
  // stesso tick si accodano; voci diverse procedono in parallelo. I tick non si
  // sovrappongono (guard in startChatTurnPoller), quindi non serve condividerlo
  // fra tick (nessun turno della stessa voce sopravvive al confine di tick).
  const serializer = createProjectSerializer();
  const dispatched: Promise<boolean>[] = [];
  while (!deps.signal?.aborted) {
    let job: BacklogJob | null;
    try {
      job = await claimNextChatTurnJob(deps.db);
    } catch (err) {
      deps.logger.error({ err }, "[backlog] chat turn: claim del prossimo turno fallito");
      break;
    }
    if (!job) break;
    dispatched.push(processChatTurnJob(deps, job, serializer));
  }
  const results = await Promise.all(dispatched);
  return results.filter(Boolean).length;
}

export interface StartChatTurnPollerOptions extends ChatTurnPollerDeps {
  /** Intervallo di poll in secondi. ≤ 0 = disabilitato (non avvia nulla). */
  intervalSeconds: number;
  signal: AbortSignal;
}

/**
 * Avvia il poller veloce su un proprio setInterval. Ad ogni tick recupera gli
 * orfani e drena la coda dei turni. Tick non sovrapposti (guard `running`: un
 * giro può durare minuti se i turni sono lenti). Stop sull'AbortSignal. Ritorna
 * uno stop idempotente. intervalSeconds ≤ 0 = disabilitato.
 */
export function startChatTurnPoller(opts: StartChatTurnPollerOptions): () => void {
  if (opts.intervalSeconds <= 0) {
    return () => {};
  }
  const { intervalSeconds, ...deps } = opts;
  let running = false;
  const tick = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      await pollChatTurnsOnce(deps);
    } catch (err) {
      deps.logger.error({ err }, "[backlog] chat turn: tick fallito");
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => void tick(), intervalSeconds * 1000);
  if (typeof timer.unref === "function") timer.unref();
  const stop = (): void => clearInterval(timer);
  opts.signal.addEventListener("abort", stop, { once: true });
  return stop;
}
