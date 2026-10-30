import {
  AI_MODEL_ALIASES,
  AI_MODEL_CHOICES,
  AI_OPERATION_GROUPS,
  isConfigurableAiOperation,
  type AiModelChoice,
  type AiOperation,
  type AiOperationGroupKey,
} from "@stubwise/shared";
import { recordChange } from "../changelog/index";
import { gate, state } from "../store";
import { forbidden, writer } from "../writer";
import { canI, refuse } from "./common";
import { ENV_MODELS } from "./seed";
import type { InstanceResult } from "./types";

// I modelli per operazione (area 9b, Task 3), come sul web
// (`ai_model_settings` → env → default di codice): un'impostazione vince
// sull'env del worker, l'env sul default. Si scrivono con `settings.manage`,
// una voce del registro per operazione (shape [AI 5]); si leggono anche con
// `ai_providers.manage`. Le operazioni tecniche (prova del plugin, della
// credenziale, lettura della quota) non si configurano.

export type ModelSource = "setting" | "env" | "default";

export interface ModelRow {
  operation: AiOperation;
  group: AiOperationGroupKey;
  model: AiModelChoice;
  source: ModelSource;
}

const HAIKU_BY_DEFAULT: readonly AiOperation[] = ["daily_report", "commit_summary", "summary"];

/** Il default di codice: Haiku per i riassunti e i report, Sonnet per il resto. */
export const DEFAULT_MODELS: Record<AiOperation, AiModelChoice> = Object.fromEntries(
  AI_OPERATION_GROUPS.flatMap((g) => g.operations).map((op) => [
    op,
    HAIKU_BY_DEFAULT.includes(op) ? "haiku" : "sonnet",
  ]),
) as Record<AiOperation, AiModelChoice>;

/**
 * Il nome di un'operazione nel registro (il nome di allora, come
 * `ChangeObject.label`). Le parole della pagina le mette la UI.
 */
const OPERATION_NAMES: Record<AiOperation, string> = {
  triage: "Task triage",
  fix_plan: "Fix plan",
  fix_execute: "Fix execution",
  pr_review: "Pull request review",
  summary: "Summaries",
  backlog_intake: "Backlog intake",
  backlog_refine: "Backlog refinement",
  commit_summary: "Commit summaries",
  release_notes: "Release notes",
  docs_nightly: "Nightly Docs",
  docs_generation: "Docs generation",
  daily_report: "Daily report",
  weekly_brief: "Weekly brief",
  mail_classify: "Mail classification",
  chat: "Chats with Claude",
  backlog_merge: "Backlog merge",
  plugin_smoke: "Plugin smoke run",
  credential_test: "Credential test",
  usage_probe: "Usage probe",
};

const canRead = (me: string) => canI(me, "settings.manage") || canI(me, "ai_providers.manage");

/** Il modello con cui gira un'operazione adesso, e da dove viene. */
export function modelFor(operation: AiOperation): { model: AiModelChoice; source: ModelSource } {
  const setting = state.instance.models[operation];
  if (setting) return { model: setting, source: "setting" };
  const env = ENV_MODELS[operation];
  if (env) return { model: env, source: "env" };
  return { model: DEFAULT_MODELS[operation], source: "default" };
}

/** «opus» → «Opus»; un id preciso resta com'è. */
const modelName = (m: AiModelChoice): string =>
  (AI_MODEL_ALIASES as readonly string[]).includes(m) ? `${m[0]!.toUpperCase()}${m.slice(1)}` : m;

/** La scelta in parole per il prima/dopo: «Opus», «Default (Sonnet)», «Server configuration (Haiku)». */
function describe({ model, source }: { model: AiModelChoice; source: ModelSource }): string {
  if (source === "setting") return modelName(model);
  return source === "env"
    ? `Server configuration (${modelName(model)})`
    : `Default (${modelName(model)})`;
}

/** Le operazioni configurabili, nell'ordine dei gruppi, con modello e fonte. */
export async function listModels(): Promise<ModelRow[]> {
  const me = await gate("instance.listModels");
  if (!canRead(me)) throw forbidden();
  return AI_OPERATION_GROUPS.flatMap(({ group, operations }) =>
    operations
      .filter(isConfigurableAiOperation)
      .map((operation) => ({ operation, group, ...modelFor(operation) })),
  );
}

/** Imposta il modello di un'operazione; `null` torna all'env o al default. */
export async function setModel(
  operation: AiOperation,
  model: AiModelChoice | null,
): Promise<InstanceResult> {
  const me = await writer("instance.setModel");
  if (!canI(me, "settings.manage")) return refuse.forbidden();
  if (!(operation in OPERATION_NAMES) || !isConfigurableAiOperation(operation))
    return refuse.invalid("operation");
  if (model !== null && !(AI_MODEL_CHOICES as readonly string[]).includes(model))
    return refuse.invalid("model");
  if ((state.instance.models[operation] ?? null) === model) return { ok: true };

  const before = describe(modelFor(operation));
  if (model === null) delete state.instance.models[operation];
  else state.instance.models[operation] = model;
  recordChange({
    kind: "model.changed",
    actorId: me,
    projectId: null,
    object: { type: "ai_settings", id: operation, label: OPERATION_NAMES[operation] },
    before,
    after: describe(modelFor(operation)),
  });
  return { ok: true };
}
