import type { AutomationDecision, AutomationRunDetail, MyAutomationRun } from "@stubwise/shared";
import {
  createAutomationRefs,
  inPrototypeWords,
  orNull,
  type AutomationRefs,
} from "./automationRefs";

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
  myRuns(): Promise<MyAutomationRun[]>;
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

/** Una decisione: un passo che non è più quello in attesa (`stale`) è `invalid: not_waiting`. */
async function decide(call: () => Promise<void>): Promise<void> {
  try {
    await inPrototypeWords(call);
  } catch (error) {
    if (error instanceof Error && error.message === "invalid: stale")
      throw new Error("invalid: not_waiting");
    throw error;
  }
}

export function createRealDecisions(
  api: DecisionApi,
  refs: AutomationRefs = createAutomationRefs(),
) {
  return {
    async listMyRuns(): Promise<MyAutomationRun[]> {
      const runs = await inPrototypeWords(() => api.myRuns());
      for (const r of runs) refs.rememberRun(r);
      return runs;
    },

    async listMyApprovals(): Promise<AutomationDecision[]> {
      const { items } = await inPrototypeWords(() => api.myApprovals());
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

    /** L'esecuzione riletta (chi ha deciso prima); `null` se non si vede più. */
    async getRun(runId: string): Promise<AutomationRunDetail | null> {
      if (!refs.knowsRun(runId)) return null;
      const s = refs.run(runId);
      const run = await orNull(() => api.run(s.code, s.n));
      if (run) refs.rememberRun(run);
      return run;
    },

    async approve(
      runId: string,
      edited: Record<string, string> | undefined,
      opts: { expectedPath: string },
    ): Promise<void> {
      const s = refs.run(runId);
      const expectedRound = refs.roundFor(runId, opts.expectedPath);
      await decide(() =>
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
      await decide(() =>
        api.reject(s.code, s.n, { expectedPath: opts.expectedPath, expectedRound }),
      );
    },
  };
}
