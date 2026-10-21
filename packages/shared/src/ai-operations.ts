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
  "daily_report",
  "weekly_brief",
  "mail_classify",
  "chat",
  "backlog_merge",
  "plugin_smoke",
  "credential_test",
  "usage_probe",
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
  { group: "docs", operations: ["docs_generation"] },
  { group: "reports", operations: ["daily_report", "weekly_brief"] },
  { group: "mail", operations: ["mail_classify"] },
  { group: "chat", operations: ["chat", "backlog_merge"] },
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
