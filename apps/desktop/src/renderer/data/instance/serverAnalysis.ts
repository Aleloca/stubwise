import { serverAnalysisLimitsSchema, type ServerAnalysisLimits } from "@stubwise/shared";
import { recordChange } from "../changelog/index";
import { changedFields } from "../changelog/settingValues";
import { gate, notifyInstanceChange, state } from "../store";
import { forbidden, writer } from "../writer";
import { canI, refuse } from "./common";
import type { InstanceResult } from "./types";

// I tetti dell'analisi dei server (area 8, F4b, R0-C, R6): GET/PUT
// /api/settings/server-analysis sul server, con `settings.manage`. La forma,
// i limiti e i default sono quelli di `serverAnalysisLimitsSchema` di
// `@stubwise/shared` (mai una copia). L'analisi, automatica e a mano, li
// legge alla partenza (`data/servers/analysis.ts`): spenta, all'allarme non
// parte e a mano è rifiutata; i minuti e il costo vanno nella sessione; le
// letture SSH e via agente si fermano al loro tetto.

/** Le chiavi del registro: distinte dalle altre `changelog.fields.*` («enabled» c'è già). */
const FIELD_KEYS: Record<keyof ServerAnalysisLimits, string> = {
  enabled: "analysisEnabled",
  maxMinutes: "maxMinutes",
  maxCostUsd: "maxCostUsd",
  maxAgentReads: "maxAgentReads",
  maxSshReads: "maxSshReads",
};

/** Valori stabili per il registro: l'interruttore come booleano, i numeri come testo. */
const fieldsOf = (l: ServerAnalysisLimits): Record<string, string | boolean> =>
  Object.fromEntries(
    (Object.keys(FIELD_KEYS) as (keyof ServerAnalysisLimits)[]).map((k) => {
      const v = l[k];
      return [FIELD_KEYS[k], typeof v === "boolean" ? v : String(v)];
    }),
  );

export async function getServerAnalysisSettings(): Promise<ServerAnalysisLimits> {
  const me = await gate("instance.getServerAnalysisSettings");
  if (!canI(me, "settings.manage")) throw forbidden();
  return { ...state.instance.serverAnalysis };
}

export async function saveServerAnalysisSettings(
  input: ServerAnalysisLimits,
): Promise<InstanceResult> {
  const me = await writer("instance.saveServerAnalysisSettings");
  if (!canI(me, "settings.manage")) return refuse.forbidden();
  const parsed = serverAnalysisLimitsSchema.strict().safeParse(input);
  if (!parsed.success) {
    const field = parsed.error.issues[0]?.path[0];
    return refuse.invalid(typeof field === "string" ? field : "settings");
  }
  const before = state.instance.serverAnalysis;
  const diff = changedFields(fieldsOf(before), fieldsOf(parsed.data));
  if (diff) {
    recordChange({
      kind: "server_analysis.changed",
      actorId: me,
      projectId: null,
      object: { type: "ai_settings", id: "server_analysis", label: "server_analysis" },
      before: diff.before,
      after: diff.after,
    });
  }
  state.instance.serverAnalysis = parsed.data;
  notifyInstanceChange();
  return { ok: true };
}
