// Gli input in coda sul worker (area 7, F1, review I2). Il server mette in
// coda decisioni, annulla, riprova e salta, e il worker li applica dopo
// qualche secondo: rileggere subito mostrerebbe l'esecuzione ancora in
// attesa, e un secondo clic prenderebbe il 409 `stale` del controllo sugli
// input in coda («già deciso da qualcuno», per la propria decisione).
//
// Dopo una scrittura riuscita si ricorda lo stato VISTO dell'esecuzione;
// finché le letture lo ripetono (entro il tetto), l'input è «in coda».
// «idle» rilegge ogni secondo finché cambia, per al più 10 secondi.

/** Ciò che dice se un input è stato applicato: lo stato, il passo, il giro. */
export interface RunState {
  /** Assente nelle voci di «Da decidere»: allora contano passo e giro. */
  status?: string;
  cursor: string | null;
  round: number;
}

export const SETTLE_STEP_MS = 1000;
export const SETTLE_MAX_MS = 10_000;

interface SettleDeps {
  now(): number;
  sleep(ms: number): Promise<void>;
  /** L'esecuzione riletta; `null` se non si vede più. */
  read(runId: string): Promise<RunState | null>;
}

const moved = (seen: RunState, now: RunState): boolean =>
  (seen.status !== undefined && now.status !== undefined && now.status !== seen.status) ||
  now.cursor !== seen.cursor ||
  now.round !== seen.round;

export function createSettle(deps: SettleDeps) {
  const pending = new Map<string, { seen: RunState; until: number }>();

  /** Toglie ciò che è applicato o scaduto; `true` se l'input è ancora in coda. */
  const check = (runId: string, now: RunState | null): boolean => {
    const p = pending.get(runId);
    if (!p) return false;
    if (now === null || deps.now() >= p.until || moved(p.seen, now)) {
      pending.delete(runId);
      return false;
    }
    return true;
  };

  return {
    /** Dopo una scrittura riuscita: lo stato che l'esecuzione aveva prima. */
    mark(runId: string, seen: RunState): void {
      pending.set(runId, { seen, until: deps.now() + SETTLE_MAX_MS });
    },

    queued: (runId: string, now: RunState): boolean => check(runId, now),

    /** Quando gli input in coda sono applicati (o al tetto); senza, dopo un attimo. */
    async idle(): Promise<void> {
      if (pending.size === 0) return deps.sleep(SETTLE_STEP_MS);
      while (pending.size > 0) {
        await deps.sleep(SETTLE_STEP_MS);
        for (const runId of [...pending.keys()]) {
          const p = pending.get(runId)!;
          if (deps.now() >= p.until) {
            pending.delete(runId);
            continue;
          }
          check(runId, await deps.read(runId).catch(() => null));
        }
      }
    },

    clear(): void {
      pending.clear();
    },
  };
}

export type Settle = ReturnType<typeof createSettle>;
