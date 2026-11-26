import { ApiError } from "@stubwise/api-client";
import { AI_OPERATION_GROUPS, type AiModelChoice, type AiOperation } from "@stubwise/shared";
import type { ModelRow } from "../../instance/models";
import type { InstanceResult } from "../../instance/types";
import { appClient } from "./client";

// Amministrazione → AI → Models nella build app (area 9, F3) su
// `/api/settings/models` (72). Il server dice il modello impostato, quello che
// il worker userebbe senza (`workerDefault`) e le due fonti (`source`,
// `fallbackSource`). `workerDefault` è la stringa dell'env com'è (un alias o
// un id intero): si mostra così, e `useModelWords` traduce solo gli alias.
// Se il worker non ha mai pubblicato i default è null: «—» (dichiarato).

/* eslint-disable @typescript-eslint/no-explicit-any -- forme del server lette dai Reader */
type Any = any;

/** Il modello che il worker non ha mai detto. */
const UNKNOWN = "—";

/** Le rotte (sul client vero: `client.settings`). */
export interface ModelsApi {
  get(): Promise<Any>;
  set(models: Partial<Record<AiOperation, AiModelChoice | null>>): Promise<Any>;
}

const groupOf = (operation: string) =>
  AI_OPERATION_GROUPS.find((g) => (g.operations as readonly string[]).includes(operation))?.group;

export function createRealModels(api: ModelsApi) {
  return {
    async listModels(): Promise<ModelRow[]> {
      const view = await api.get();
      return (view.operations as Any[])
        .filter((o) => o.configurable && groupOf(o.operation))
        .map((o) => {
          const fallbackModel = (o.workerDefault ?? UNKNOWN) as AiModelChoice;
          const fallbackSource = o.fallbackSource === "env" ? "env" : "default";
          return {
            operation: o.operation,
            group: groupOf(o.operation)!,
            model: o.source === "setting" && o.model ? o.model : fallbackModel,
            source: o.source,
            fallback: { model: fallbackModel, source: fallbackSource },
          } as ModelRow;
        });
    },

    async setModel(operation: AiOperation, model: AiModelChoice | null): Promise<InstanceResult> {
      try {
        await api.set({ [operation]: model });
        return { ok: true };
      } catch (error) {
        if (!(error instanceof ApiError)) throw error;
        if (error.status === 403) return { ok: false, error: "forbidden" };
        return {
          ok: false,
          error: "invalid",
          reason: error.status === 400 ? "model" : error.code || "model",
        };
      }
    },
  };
}

/** Sul client vero (il client si legge a ogni chiamata). */
const liveApi: ModelsApi = {
  get: () => appClient().settings.models(),
  set: (models) => appClient().settings.setModels(models),
};

/** SOLO TEST: le rotte vere. */
export const liveModelsApiForTest = liveApi;

export const liveModels = createRealModels(liveApi);
