/**
 * Catalogo delle operazioni AI e dei modelli Anthropic selezionabili
 * (design: docs/plans/2026-10-21-modelli-e-consumi-design.md, §1).
 *
 * Aggiungere un'operazione qui richiede anche la migrazione che aggiorna il
 * CHECK sulle colonne `operation` (testo + CHECK, mai un enum Postgres).
 * Modulo foglia: importa solo zod, si carica da solo.
 */
import { z } from "zod";

export const AI_OPERATIONS = [
  "triage",
  "fix_plan",
  "fix_execute",
  "pr_review",
  "summary",
  "backlog_intake",
  "backlog_refine",
  "commit_summary",
  "release_notes",
  "docs_nightly",
  "docs_generation",
  // Il riassunto di un file del Drive (area 5, fetta 3): Haiku, senza tool.
  "drive_summary",
  "daily_report",
  "weekly_brief",
  "mail_classify",
  // La bozza di Claude nella Posta (area 6, F3): un gesto della persona, Sonnet di default.
  "mail_draft",
  // Il riassunto e le proposte di una riunione registrata (area 6, F5a): Sonnet, senza tool.
  "meeting_summary",
  // Un passo di Claude di un'automazione (area 7, F3): Sonnet di default (F3-2), senza strumenti.
  "automation_step",
  "chat",
  // La conversazione libera con Claude (chat, fetta 1): i turni del runner a turni del worker.
  "claude_chat",
  "backlog_merge",
  "plugin_smoke",
  "credential_test",
  "usage_probe",
  // Area 8, F3: il giudizio sul triage dopo il silenzio (Haiku) e la bozza della risposta al cliente.
  "support_triage_check",
  "server_analysis",
  "server_fix_plan",
  // Area 8, «Clienti in attesa»: il giudizio «serve una MIA risposta?» su un thread (Haiku).
  "mail_reply_judgment",
  // Area 11, F5: Claude aggiorna la doc di prodotto dalle fonti (fatti strutturati, nessuno strumento).
  "product_doc_update",
] as const;

export type AiOperation = (typeof AI_OPERATIONS)[number];

export const aiOperationSchema = z.enum(AI_OPERATIONS);

export type AiOperationGroupKey =
  | "tickets"
  | "backlog"
  | "nightly"
  | "docs"
  | "reports"
  | "mail"
  | "automations"
  | "support"
  | "servers"
  | "chat"
  | "technical";

/** Raggruppamento mostrato nella UI delle impostazioni. */
export const AI_OPERATION_GROUPS: {
  group: AiOperationGroupKey;
  operations: AiOperation[];
}[] = [
  { group: "tickets", operations: ["triage", "fix_plan", "fix_execute", "pr_review", "summary"] },
  { group: "backlog", operations: ["backlog_intake", "backlog_refine"] },
  { group: "nightly", operations: ["commit_summary", "release_notes", "docs_nightly"] },
  { group: "docs", operations: ["docs_generation", "drive_summary", "product_doc_update"] },
  { group: "reports", operations: ["daily_report", "weekly_brief"] },
  { group: "mail", operations: ["mail_classify", "mail_draft", "meeting_summary", "mail_reply_judgment"] },
  { group: "automations", operations: ["automation_step"] },
  { group: "support", operations: ["support_triage_check"] },
  { group: "servers", operations: ["server_analysis", "server_fix_plan"] },
  { group: "chat", operations: ["chat", "claude_chat", "backlog_merge"] },
  { group: "technical", operations: ["plugin_smoke", "credential_test", "usage_probe"] },
];

const TECHNICAL: readonly AiOperation[] = ["plugin_smoke", "credential_test", "usage_probe"];

export const CONFIGURABLE_AI_OPERATIONS: AiOperation[] = AI_OPERATIONS.filter(
  (op) => !TECHNICAL.includes(op),
);

export function isConfigurableAiOperation(op: AiOperation): boolean {
  return !TECHNICAL.includes(op);
}

export const AI_MODEL_ALIASES = ["opus", "sonnet", "haiku"] as const;
export const AI_MODEL_IDS = [
  "claude-fable-5-1",
  "claude-opus-5-5",
  "claude-sonnet-5-5",
  "claude-haiku-5-5",
  "claude-opus-4-8",
] as const;
export const AI_MODEL_CHOICES = [...AI_MODEL_ALIASES, ...AI_MODEL_IDS] as const;

export type AiModelChoice = (typeof AI_MODEL_CHOICES)[number];

export const aiModelChoiceSchema = z.enum(AI_MODEL_CHOICES);

const ALIAS_TO_ID: Record<(typeof AI_MODEL_ALIASES)[number], string> = {
  opus: "claude-opus-5-5",
  sonnet: "claude-sonnet-5-5",
  haiku: "claude-haiku-5-5",
};

/** Alias -> id più recente, id -> sé stesso. Serve all'SDK, che non accetta alias. */
export function resolveApiModelId(choice: AiModelChoice): string {
  return choice in ALIAS_TO_ID ? ALIAS_TO_ID[choice as keyof typeof ALIAS_TO_ID] : choice;
}

/**
 * Un valore di `ai_model_settings` vale SOLO se è nel catalogo: una riga
 * fuori catalogo (scritta prima di un deploy che l'ha ristretto) non arriva
 * mai al CLI. UNA regola per il resolver del worker e per la fonte che il
 * server mostra (area 9, F3, Task 7).
 */
export function isKnownModelChoice(value: string | null | undefined): value is AiModelChoice {
  return value != null && (AI_MODEL_CHOICES as readonly string[]).includes(value);
}

/** Da dove viene il modello di un'operazione: l'impostazione, un'env del worker, il default di codice. */
export type AiModelSource = "setting" | "env" | "default";

/**
 * La fonte del modello, con la precedenza del worker: un'impostazione valida
 * vince, poi l'env (le operazioni che il worker pubblica in
 * `worker_model_env_operations`), poi il default.
 */
export function aiModelSourceOf(operation: AiOperation, setting: string | null | undefined, envOperations: readonly string[] | null | undefined): AiModelSource {
  if (isKnownModelChoice(setting)) return "setting";
  return envOperations?.includes(operation) ? "env" : "default";
}

/**
 * `GET`/`PATCH /api/settings/models` (area 9, F3: qui perché lo leggono
 * server e client). `source` è additivo, col default.
 */
export const modelSettingsViewSchema = z.object({
  operations: z.array(
    z.object({
      operation: aiOperationSchema,
      configurable: z.boolean(),
      model: aiModelChoiceSchema.nullable(),
      workerDefault: z.string().nullable(),
      /** Da dove viene il modello che il worker userebbe ora (`aiModelSourceOf`). */
      source: z.enum(["setting", "env", "default"]).default("default"),
      /**
       * Dove riporta «Use default»: la fonte SENZA l'impostazione, cioè l'env
       * del worker o il default di codice (il modello è `workerDefault`, la
       * stringa dell'env com'è: un alias o un id intero). Additivo.
       */
      fallbackSource: z.enum(["env", "default"]).default("default"),
    }),
  ),
  choices: z.array(aiModelChoiceSchema),
});
export type ModelSettingsView = z.infer<typeof modelSettingsViewSchema>;
