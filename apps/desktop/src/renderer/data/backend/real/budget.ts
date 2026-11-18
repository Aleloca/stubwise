import { ApiError } from "@stubwise/api-client";
import type { BudgetSaveEffect, BudgetView, ContentLanguage } from "../../instance/budget";
import type { InstanceResult } from "../../instance/types";
import { appClient } from "./client";

// Amministrazione → AI → Budget & language nella build app (area 9, F4) su
// `/api/settings/instance` (72, 58af0dcd3): il tetto mensile, lo speso del
// mese (`spentUsd`, la stessa somma del worker), se il tetto è raggiunto
// (`budgetReached`, la regola che ferma il lavoro di Claude) e, nella
// risposta del salvataggio, l'effetto (`budgetEffect`). Il client non li
// calcola. Il salvataggio manda solo lingua e tetto: i campi
// dell'archiviazione che mancano restano com'erano sul server.
// Nell'app non c'è la simulazione del budget raggiunto (solo prototipo).

/* eslint-disable @typescript-eslint/no-explicit-any -- forme del server lette dai Reader */
type Any = any;

/** Le rotte (sul client vero: `client.instanceSettings`). */
export interface BudgetApi {
  get(): Promise<Any>;
  save(input: { contentLanguage: ContentLanguage; monthlyBudgetUsd: number | null }): Promise<Any>;
}

const EFFECTS = new Set(["released", "now_reached", "still_reached"]);

function refusalOf(error: unknown): Extract<InstanceResult, { ok: false }> {
  if (!(error instanceof ApiError)) throw error;
  if (error.status === 403) return { ok: false, error: "forbidden" };
  if (error.status === 400) {
    const reason = /contentLanguage/.test(error.message) ? "language" : "amount";
    return { ok: false, error: "invalid", reason };
  }
  if (error.code) return { ok: false, error: "invalid", reason: error.code };
  throw error;
}

export function createRealBudget(api: BudgetApi) {
  return {
    async getBudget(): Promise<BudgetView> {
      const s = await api.get();
      return {
        monthlyUsd: s.monthlyBudgetUsd ?? null,
        spentUsd: s.spentUsd ?? 0,
        reached: !!s.budgetReached,
        simulated: false,
        contentLanguage: s.contentLanguage === "it" ? "it" : "en",
      };
    },

    async saveBudget(input: {
      monthlyUsd: number | null;
      contentLanguage: ContentLanguage;
    }): Promise<InstanceResult<BudgetSaveEffect>> {
      try {
        const r = await api.save({
          contentLanguage: input.contentLanguage,
          monthlyBudgetUsd: input.monthlyUsd,
        });
        const effect = EFFECTS.has(r.budgetEffect) ? r.budgetEffect : "none";
        return { ok: true, effect, simulated: false, spentUsd: r.spentUsd ?? 0 };
      } catch (error) {
        return refusalOf(error);
      }
    },
  };
}

/** Sul client vero (il client si legge a ogni chiamata). */
const liveApi: BudgetApi = {
  get: () => appClient().instanceSettings.get(),
  save: (input) => appClient().instanceSettings.save(input as Any),
};

/** SOLO TEST: le rotte vere. */
export const liveBudgetApiForTest = liveApi;

export const liveBudget = createRealBudget(liveApi);
