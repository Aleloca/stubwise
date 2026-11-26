import type { AutomationDecision, AutomationRunDetail, MyAutomationRun } from "@stubwise/shared";
import {
  createAutomationRefs,
  inPrototypeWords,
  orNull,
  type AutomationRefs,
} from "./automationRefs";
import { createSettle, type RunState } from "./automationSettle";

// Il blocco «Automations» della Home e le approvazioni in «Da decidere»
// sulle rotte vere (area 7, F1, R7). Le pagine sono quelle del prototipo:
// l'adattatore parla la loro lingua — un'esecuzione per id, gli errori come
// `data/writer.ts` (`forbidden`, `not_found`, `invalid: …`) — e il server la
// sua (`/api/automations/:code/runs/:n/…`, `expectedPath` + `expectedRound`,
// 409 `stale`).
//
// Il passo e il giro che chi decide ha VISTO li ricorda l'ultima lettura
// (elenchi o dettaglio, `automationRefs.ts`): una decisione su un passo
// diverso parte col giro 0, e il server la rifiuta se non è quello in attesa.

/** Le rotte che servono (sul client vero: `client.automations`). */
export interface DecisionApi {
  myRuns(opts?: { log?: "none" }): Promise<{ items: MyAutomationRun[] }>;
  myApprovals(): Promise<{ items: AutomationDecision[] }>;
  run(code: string, n: number): Promise<AutomationRunDetail>;
  approve(
    code: string,
    n: number,
    body: { expectedPath: string; expectedRound: number; edited?: Record<string, string> },
  ): Promise<void>;
  reject(
    code: string,
    n: number,
    body: { expectedPath: string; expectedRound: number },
  ): Promise<void>;
}

/**
 * Una decisione: un passo che non è più quello in attesa (`stale`) è
 * `invalid: not_waiting`; la PROPRIA decisione già in coda (`pending`) resta
 * `invalid: pending` (la pagina dice «in corso», non «già deciso da qualcuno»).
 */
async function decide(call: () => Promise<void>): Promise<void> {
  try {
    await inPrototypeWords(call);
  } catch (error) {
    if (error instanceof Error && error.message === "invalid: stale")
      throw new Error("invalid: not_waiting");
    throw error;
  }
}

/** Il tempo degli input in coda (i test lo fingono). */
export interface SettleClock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

const realClock: SettleClock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

const stateOf = (r: { status?: string; cursor?: string | null; round?: number }): RunState => ({
  status: r.status,
  cursor: r.cursor ?? null,
  round: r.round ?? 0,
});

export function createRealDecisions(
  api: DecisionApi,
  refs: AutomationRefs = createAutomationRefs(),
  clock: SettleClock = realClock,
) {
  // Decisioni, annulla, riprova e salta li applica il worker dopo: vedi `automationSettle.ts`.
  const settle = createSettle({
    ...clock,
    async read(runId) {
      const s = refs.run(runId);
      const run = await orNull(() => api.run(s.code, s.n));
      if (run) refs.rememberRun(run);
      return run ? stateOf(run) : null;
    },
  });
  /** Dopo una scrittura riuscita su un'esecuzione: lo stato che aveva. */
  const markRun = (runId: string) => {
    const s = refs.run(runId);
    settle.mark(runId, { status: s.status, cursor: s.path, round: s.round });
  };

  /** Mandata (o già in coda, `pending`): l'esecuzione aspetta il worker. */
  const decideOn = async (runId: string, call: () => Promise<void>) => {
    try {
      await decide(call);
    } catch (error) {
      if (error instanceof Error && error.message === "invalid: pending") markRun(runId);
      throw error;
    }
    markRun(runId);
  };

  return {
    markRun,
    /** Dopo una scrittura: quando il worker ha applicato gli input in coda (al più 10 s). */
    whenAutomationsIdle: (): Promise<void> => settle.idle(),
    forgetQueuedInputs: (): void => settle.clear(),

    async listMyRuns(): Promise<MyAutomationRun[]> {
      // Un server senza le rotte dell'area 7 (404) non ha niente da far decidere.
      // Gli elenchi non mostrano il registro: le righe arrivano senza (`log: []`).
      const { items: runs } = (await orNull(() => api.myRuns({ log: "none" }))) ?? { items: [] };
      for (const r of runs) refs.rememberRun(r);
      return runs;
    },

    async listMyApprovals(): Promise<AutomationDecision[]> {
      const { items: all } = (await orNull(() => api.myApprovals())) ?? { items: [] };
      // Una decisione già mandata, che il worker non ha ancora applicato, non si ripropone.
      const items = all.filter((d) => !settle.queued(d.runId, stateOf(d)));
      for (const d of items)
        refs.rememberRun({
          id: d.runId,
          automationCode: d.automationCode,
          n: d.n,
          cursor: d.cursor,
          round: d.round,
        });
      return items;
    },

    /** Per codice e numero, anche fuori dalla prima pagina degli elenchi; `null` se non la vedo. */
    async findRun(automationCode: string, n: number): Promise<string | null> {
      const run = await orNull(() => api.run(automationCode, n));
      if (!run) return null;
      refs.rememberRun(run);
      return run.id;
    },

    /** L'esecuzione riletta (chi ha deciso prima); `null` se non si vede più. */
    async getRun(runId: string): Promise<AutomationRunDetail | null> {
      if (!refs.knowsRun(runId)) return null;
      const s = refs.run(runId);
      const run = await orNull(() => api.run(s.code, s.n));
      if (!run) return null;
      refs.rememberRun(run);
      if (!settle.queued(runId, stateOf(run))) return run;
      // L'input è in coda: niente seconda decisione, la pagina dice «in corso».
      return {
        ...run,
        inputQueued: true,
        permissions: { ...run.permissions, approve: false, chooseProject: false },
      };
    },

    async approve(
      runId: string,
      edited: Record<string, string> | undefined,
      opts: { expectedPath: string },
    ): Promise<void> {
      const s = refs.run(runId);
      const expectedRound = refs.roundFor(runId, opts.expectedPath);
      await decideOn(runId, () =>
        api.approve(s.code, s.n, {
          expectedPath: opts.expectedPath,
          expectedRound,
          ...(edited ? { edited } : {}),
        }),
      );
    },

    async reject(runId: string, opts: { expectedPath: string }): Promise<void> {
      const s = refs.run(runId);
      const expectedRound = refs.roundFor(runId, opts.expectedPath);
      await decideOn(runId, () =>
        api.reject(s.code, s.n, { expectedPath: opts.expectedPath, expectedRound }),
      );
    },
  };
}
