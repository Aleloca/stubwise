import { ApiError } from "@stubwise/api-client";
import type { ServerAnalysisLimits } from "@stubwise/shared";
import type { InstanceResult } from "../../instance/types";
import { appClient } from "./client";

// I tetti dell'analisi dei server nella build app (registro, A8 r.964,
// `servers-analysis-limits`): Amministrazione → AI → Budget su
// GET/PUT /api/settings/server-analysis (`settings.manage`, 72), con
// `client.serverOps.analysisSettings`. La forma è `serverAnalysisLimitsSchema`
// di `@stubwise/shared`; il registro delle modifiche lo scrive il server. I
// rifiuti nelle parole del prototipo (`data/instance/serverAnalysis.ts`).

const FIELDS: readonly (keyof ServerAnalysisLimits)[] = [
  "enabled",
  "maxMinutes",
  "maxCostUsd",
  "maxAgentReads",
  "maxSshReads",
];

function refusalOf(error: unknown): Extract<InstanceResult, { ok: false }> {
  if (!(error instanceof ApiError)) throw error;
  if (error.status === 403) return { ok: false, error: "forbidden" };
  if (error.status === 400) {
    // La validazione del server nomina il campo (`body/maxCostUsd …`).
    const field = FIELDS.find((f) => new RegExp(`\\b${f}\\b`).test(error.message));
    return { ok: false, error: "invalid", reason: field ?? "settings" };
  }
  if (error.code) return { ok: false, error: "invalid", reason: error.code };
  throw error;
}

export const liveServerAnalysis = {
  async getServerAnalysisSettings(): Promise<ServerAnalysisLimits> {
    return await appClient().serverOps.analysisSettings();
  },

  async saveServerAnalysisSettings(input: ServerAnalysisLimits): Promise<InstanceResult> {
    try {
      await appClient().serverOps.setAnalysisSettings(input);
      return { ok: true };
    } catch (error) {
      return refusalOf(error);
    }
  },
};
