import {
  AI_MODEL_CHOICES,
  AI_OPERATIONS,
  AI_OPERATION_GROUPS,
  isConfigurableAiOperation,
  resolveApiModelId,
  type AiModelChoice,
  type AiOperation,
  type AiOperationGroupKey,
} from "@stubwise/shared";
import { recordChange } from "../changelog/index";
import { encodeModel } from "../changelog/settingValues";
import type { ConversationKind } from "../model";
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
 * L'operazione con cui gira ogni tipo di sessione (area 9b, Task 6): decide
 * il modello di una sessione nuova (`modelIdFor`) e la riga dei consumi. Una
 * `task_run` parte col modello di `fix_plan` e, all'esecuzione, i consumi
 * vanno su `fix_execute`. *Scelta del controller*: l'analisi di un server
 * gira come un piano (`fix_plan`), il web non ha un'operazione sua.
 */
export const OPERATION_OF_KIND: Record<ConversationKind, AiOperation> = {
  task_run: "fix_plan",
  pr_review: "pr_review",
  docs: "docs_generation",
  brief: "weekly_brief",
  daily_report: "daily_report",
  mail_classify: "mail_classify",
  intake: "backlog_intake",
  refine: "backlog_refine",
  free: "chat",
  server_analysis: "fix_plan",
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

/** Il modello di un'operazione adesso, come id («haiku» → «claude-haiku-5-5»): quello che una sessione nuova scrive. */
export function modelIdFor(operation: AiOperation): string {
  return resolveApiModelId(modelFor(operation).model);
}

/** La scelta come valore stabile del registro (Ruling T3): `set:opus`, `env:haiku`, `default:sonnet`. */
const stable = ({ model, source }: { model: AiModelChoice; source: ModelSource }): string =>
  encodeModel(source === "setting" ? "set" : source, model);

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
  if (
    !(AI_OPERATIONS as readonly string[]).includes(operation) ||
    !isConfigurableAiOperation(operation)
  )
    return refuse.invalid("operation");
  if (model !== null && !(AI_MODEL_CHOICES as readonly string[]).includes(model))
    return refuse.invalid("model");
  if ((state.instance.models[operation] ?? null) === model) return { ok: true };

  const before = stable(modelFor(operation));
  if (model === null) delete state.instance.models[operation];
  else state.instance.models[operation] = model;
  recordChange({
    kind: "model.changed",
    actorId: me,
    projectId: null,
    // L'id dell'operazione: il nome lo traduce la pagina (`usage.operations.<op>`).
    object: { type: "ai_settings", id: operation, label: operation },
    before,
    after: stable(modelFor(operation)),
  });
  return { ok: true };
}
