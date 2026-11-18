import { ApiError } from "@stubwise/api-client";
import type { BudgetSaveEffect, BudgetView, ContentLanguage } from "../../instance/budget";
import type { InstanceResult } from "../../instance/types";
import { appClient } from "./client";

// Amministrazione → AI → Budget & language nella build app (area 9, F4) su
// `/api/settings/instance` (72, 58af0dcd3): il tetto mensile, lo speso del
// mese (`spentUsd`, la stessa somma del worker), se il tetto è raggiunto
// (`budgetReached`, la regola che ferma il lavoro di Claude) e, nella
// risposta del salvataggio, l'effetto (`budgetEffect`). Il client non li
// calcola. Il PUT è una patch: si manda solo ciò che è cambiato (review F4, I3).
// Nell'app non c'è la simulazione del budget raggiunto (solo prototipo).

/* eslint-disable @typescript-eslint/no-explicit-any -- forme del server lette dai Reader */
type Any = any;

/** Le rotte (sul client vero: `client.instanceSettings`). */
export interface BudgetApi {
  get(): Promise<Any>;
  save(input: {
    contentLanguage?: ContentLanguage;
    monthlyBudgetUsd?: number | null;
  }): Promise<Any>;
}

const EFFECTS = new Set(["released", "now_reached", "still_reached"]);

function refusalOf(error: unknown): Extract<InstanceResult, { ok: false }> {
  if (!(error instanceof ApiError)) throw error;
  if (error.status === 403) return { ok: false, error: "forbidden" };
  // Review F4, M6: un rifiuto col suo codice (che non sia la validazione) lo dice col codice.
  if (error.status === 400 && error.code && error.code !== "FST_ERR_VALIDATION")
    return { ok: false, error: "invalid", reason: error.code };
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
        // Review F4, I3: il PUT è una patch, quindi solo ciò che è cambiato
        // (tetto e/o lingua); niente di cambiato, nessuna chiamata.
        const current = await api.get();
        const patch: { contentLanguage?: ContentLanguage; monthlyBudgetUsd?: number | null } = {};
        if (input.contentLanguage !== current.contentLanguage)
          patch.contentLanguage = input.contentLanguage;
        if (input.monthlyUsd !== (current.monthlyBudgetUsd ?? null))
          patch.monthlyBudgetUsd = input.monthlyUsd;
        if (Object.keys(patch).length === 0)
          return { ok: true, effect: "none", simulated: false, spentUsd: current.spentUsd ?? 0 };
        const r = await api.save(patch);
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
