import { ApiError } from "@stubwise/api-client";
import type { AutomationDecision, AutomationRunDetail, MyAutomationRun } from "@stubwise/shared";

// Il blocco «Automations» della Home e le approvazioni in «Da decidere»
// sulle rotte vere (area 7, F1, R7). Le pagine sono quelle del prototipo:
// l'adattatore parla la loro lingua — un'esecuzione per id, gli errori come
// `data/writer.ts` (`forbidden`, `not_found`, `invalid: …`) — e il server la
// sua (`/api/automations/:code/runs/:n/…`, `expectedPath` + `expectedRound`,
// 409 `stale`).
//
// Il passo e il giro che chi decide ha VISTO li ricorda l'ultima lettura
// (elenchi o dettaglio): una decisione su un passo diverso parte col giro 0,
// e il server la rifiuta se non è quello in attesa.

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
  reject(code: string, n: number, body: { expectedPath: string; expectedRound: number }): Promise<void>;
}

interface Seen {
  code: string;
  n: number;
  path: string | null;
  round: number;
}

/** Un errore del server come lo dicono le scritture del prototipo. */
function asPrototypeError(error: unknown): unknown {
  if (!(error instanceof ApiError)) return error;
  if (error.status === 404) return new Error("not_found");
  if (error.status === 403) return new Error("forbidden");
  if (error.code === "stale") return new Error("invalid: not_waiting");
  if (error.code) return new Error(`invalid: ${error.code}`);
  return error;
}

export function createRealDecisions(api: DecisionApi) {
  const seen = new Map<string, Seen>();
  const remember = (id: string, code: string, n: number, path: string | null, round?: number) =>
    seen.set(id, { code, n, path, round: round ?? 0 });

  function target(runId: string, expectedPath: string) {
    const s = seen.get(runId);
    if (!s) throw new Error("not_found");
    return { s, expectedRound: s.path === expectedPath ? s.round : 0 };
  }

  async function send(call: () => Promise<void>): Promise<void> {
    try {
      await call();
    } catch (error) {
      throw asPrototypeError(error);
    }
  }

  return {
    async listMyRuns(): Promise<MyAutomationRun[]> {
      const runs = await api.myRuns();
      for (const r of runs) remember(r.id, r.automationCode, r.n, r.cursor ?? null, r.round);
      return runs;
    },

    async listMyApprovals(): Promise<AutomationDecision[]> {
      const { items } = await api.myApprovals();
      for (const d of items) remember(d.runId, d.automationCode, d.n, d.cursor, d.round);
      return items;
    },

    /** L'esecuzione riletta (chi ha deciso prima); `null` se non si vede più. */
    async getRun(runId: string): Promise<AutomationRunDetail | null> {
      const s = seen.get(runId);
      if (!s) return null;
      try {
        const run = await api.run(s.code, s.n);
        remember(run.id, run.automationCode, run.n, run.cursor ?? null, run.round);
        return run;
      } catch (error) {
        if (error instanceof ApiError && error.status === 404) return null;
        throw error;
      }
    },

    async approve(
      runId: string,
      edited: Record<string, string> | undefined,
      opts: { expectedPath: string },
    ): Promise<void> {
      const { s, expectedRound } = target(runId, opts.expectedPath);
      await send(() =>
        api.approve(s.code, s.n, {
          expectedPath: opts.expectedPath,
          expectedRound,
          ...(edited ? { edited } : {}),
        }),
      );
    },

    async reject(runId: string, opts: { expectedPath: string }): Promise<void> {
      const { s, expectedRound } = target(runId, opts.expectedPath);
      await send(() => api.reject(s.code, s.n, { expectedPath: opts.expectedPath, expectedRound }));
    },
  };
}
