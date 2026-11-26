import { workerHeartbeats, type Db } from "@stubwise/db";
import { lt } from "drizzle-orm";

/**
 * Area 9, F4 (J-2 = a): l'heartbeat del worker per lo Stato dell'istanza. Una
 * riga per processo (`worker_heartbeats`), riscritta a ogni battito: quando ha
 * visto la coda, la sua concorrenza e i lavori che ha in mano. «Attivo» =
 * `seen_at` negli ultimi {@link WORKER_ACTIVE_MS}; le righe più vecchie di un
 * giorno si potano. BEST-EFFORT: un errore si logga e il worker prosegue.
 *
 * Solo una lettura per chi guarda: nessuno comanda un worker da qui.
 */
export const WORKER_HEARTBEAT_MS = 15_000;
export const WORKER_ACTIVE_MS = 2 * 60_000;
export const WORKER_HEARTBEAT_RETENTION_MS = 24 * 60 * 60_000;

export interface HeartbeatLogger {
  warn(msg: string): void;
}

export interface HeartbeatDeps {
  db: Db;
  workerId: string;
  concurrency: number;
  /** I lavori in mano adesso, `{ kind, id }` (ai_job, doc_generation…). */
  running: () => { kind: string; id: string }[];
  logger?: HeartbeatLogger;
  now?: () => Date;
}

/** Un battito: scrive la riga del processo e pota le vecchie. Non lancia. */
export async function beat(deps: HeartbeatDeps): Promise<void> {
  const now = deps.now?.() ?? new Date();
  try {
    const running = deps.running();
    await deps.db
      .insert(workerHeartbeats)
      .values({ workerId: deps.workerId, startedAt: now, seenAt: now, concurrency: deps.concurrency, running })
      .onConflictDoUpdate({ target: workerHeartbeats.workerId, set: { seenAt: now, concurrency: deps.concurrency, running } });
    await deps.db.delete(workerHeartbeats).where(lt(workerHeartbeats.seenAt, new Date(now.getTime() - WORKER_HEARTBEAT_RETENTION_MS)));
  } catch (err) {
    (deps.logger ?? console).warn(`[stubwise-worker] heartbeat non scritto: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Il battito periodico; `stop()` lo ferma. */
export function startHeartbeat(deps: HeartbeatDeps, intervalMs = WORKER_HEARTBEAT_MS): { stop(): void } {
  void beat(deps);
  const timer = setInterval(() => void beat(deps), intervalMs);
  timer.unref?.();
  return { stop: () => clearInterval(timer) };
}
