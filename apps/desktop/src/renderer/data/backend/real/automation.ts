import { ApiError } from "@stubwise/api-client";
import type { AutomationSettings } from "../../instance/automation";
import type { InstanceResult } from "../../instance/types";
import type { TaskType } from "../../model";
import { appClient } from "./client";

// Amministrazione → AI → Automation nella build app (area 9, F3) su
// `/api/settings/automation` (72). Il server ha una regola per ognuno dei
// cinque tipi di ticket; la pagina del prototipo ne mostra tre, quelli delle
// task (`uiTypeOf` di `@stubwise/shared`). Ogni riga legge e scrive il tipo
// PRINCIPALE della sua famiglia (`activity` è `task`); le regole di
// `feedback` e `review` si rimandano com'erano a ogni salvataggio, così non si
// perdono né cambiano in silenzio (differenza dichiarata nella parità).

/* eslint-disable @typescript-eslint/no-explicit-any -- forme del server lette dai Reader */
type Any = any;

/** Il tipo del server che ogni riga del prototipo legge e scrive. */
const SERVER_TYPE: Record<TaskType, string> = { bug: "bug", feature: "feature", activity: "task" };
const ROWS: readonly TaskType[] = ["bug", "feature", "activity"];

/** Le rotte (sul client vero: `client.instanceSettings`). */
export interface AutomationApi {
  get(): Promise<Any>;
  save(input: Any): Promise<Any>;
}

function refusalOf(error: unknown): Extract<InstanceResult, { ok: false }> {
  if (!(error instanceof ApiError)) throw error;
  if (error.status === 403) return { ok: false, error: "forbidden" };
  if (error.status === 400) {
    const reason = /maxCostUsd/.test(error.message)
      ? "cost"
      : /Effort/i.test(error.message)
        ? "effort"
        : "task_type";
    return { ok: false, error: "invalid", reason };
  }
  if (error.code) return { ok: false, error: "invalid", reason: error.code };
  throw error;
}

const ruleOf = (r: Any, taskType: TaskType) => ({
  taskType,
  autoFix: !!r.autoFix,
  maxEffort: r.maxEffort,
  planApprovalMinEffort: r.planApprovalMinEffort ?? null,
  maxCostUsd: r.maxCostUsd ?? null,
});

export function createRealAutomation(api: AutomationApi) {
  return {
    async getAutomation(): Promise<AutomationSettings> {
      const a = await api.get();
      const rules = ROWS.flatMap((taskType) => {
        const r = (a.rules as Any[]).find((x) => x.type === SERVER_TYPE[taskType]);
        return r ? [ruleOf(r, taskType)] : [];
      });
      return {
        rules,
        prReview: { enabled: !!a.prReview.enabled, maxCostUsd: a.prReview.maxCostUsd ?? null },
      } as AutomationSettings;
    },

    async saveAutomation(input: AutomationSettings): Promise<InstanceResult> {
      try {
        const current = await api.get();
        const mine = new Set(Object.values(SERVER_TYPE));
        const rows = input.rules.map((r) => ({
          type: SERVER_TYPE[r.taskType],
          autoFix: r.autoFix,
          maxEffort: r.maxEffort,
          planApprovalMinEffort: r.planApprovalMinEffort,
          maxCostUsd: r.maxCostUsd,
        }));
        // `feedback` e `review` com'erano: la pagina non li mostra.
        const others = (current.rules as Any[]).filter((r) => !mine.has(r.type));
        await api.save({ rules: [...rows, ...others], prReview: input.prReview });
        return { ok: true };
      } catch (error) {
        return refusalOf(error);
      }
    },
  };
}

/** Sul client vero (il client si legge a ogni chiamata). */
const liveApi: AutomationApi = {
  get: () => appClient().instanceSettings.automation(),
  save: (input) => appClient().instanceSettings.saveAutomation(input),
};

/** SOLO TEST: le rotte vere. */
export const liveAutomationApiForTest = liveApi;

export const liveAutomation = createRealAutomation(liveApi);
