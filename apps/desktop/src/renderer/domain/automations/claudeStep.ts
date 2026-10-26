import type { DataField, FieldType, Step } from "../../data/types";
import { AUTOMATION_LIMITS } from "./fields";

// Regola 2 dell'anti-obiettivo: un passo di Claude restituisce solo una delle
// uscite dichiarate e/o i campi dichiarati, col loro tipo. Tutto il resto è
// un errore del passo: Claude legge e risponde, non esegue azioni.

export interface ClaudeResult {
  outcome?: string;
  fields?: Record<string, unknown>;
  /** La motivazione, per il registro (regola 3). Mai interpretata. */
  reason: string;
}

export type ClaudeCheck =
  | { ok: true }
  | { ok: false; error: "unknown_outcome" | "bad_field" | "too_many" };

const SCALAR: Record<Exclude<FieldType, "list" | "file">, (v: unknown) => boolean> = {
  text: (v) => typeof v === "string",
  number: (v) => typeof v === "number" && Number.isFinite(v),
  date: (v) =>
    typeof v === "string" && /^\d{4}-\d{2}-\d{2}/.test(v) && !Number.isNaN(Date.parse(v)),
  email: (v) => typeof v === "string" && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v),
  person: (v) => typeof v === "string" && v.trim() !== "",
  boolean: (v) => typeof v === "boolean",
};

const isRecord = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);

/** Il valore rispetta il campo? `too_many` per un elenco oltre il limite. */
function checkValue(field: DataField, value: unknown): "ok" | "bad_field" | "too_many" {
  if (field.type === "file") return isRecord(value) ? "ok" : "bad_field";
  if (field.type !== "list") return SCALAR[field.type](value) ? "ok" : "bad_field";
  if (!Array.isArray(value)) return "bad_field";
  if (value.length > AUTOMATION_LIMITS.forEachRounds) return "too_many";
  for (const item of value) {
    if (!field.of) {
      if (typeof item !== "string") return "bad_field";
      continue;
    }
    const r = checkRecord(field.of, item);
    if (r !== "ok") return r;
  }
  return "ok";
}

/** Esattamente i campi dichiarati, ciascuno del suo tipo. */
function checkRecord(fields: DataField[], value: unknown): "ok" | "bad_field" | "too_many" {
  if (!isRecord(value)) return "bad_field";
  const declared = new Map(fields.map((f) => [f.key, f]));
  for (const key of Object.keys(value)) if (!declared.has(key)) return "bad_field";
  for (const f of fields) {
    if (!(f.key in value)) return "bad_field";
    const r = checkValue(f, value[f.key]);
    if (r !== "ok") return r;
  }
  return "ok";
}

/**
 * Un risultato è valido se l'uscita è una di quelle dichiarate (obbligatoria
 * se il passo ne dichiara, vietata se non ne dichiara) e i campi sono
 * esattamente quelli dichiarati, del loro tipo, con gli elenchi entro il
 * limite dei giri di un `forEach`.
 */
export function checkClaudeResult(
  step: Extract<Step, { kind: "claude" }>,
  result: ClaudeResult,
): ClaudeCheck {
  const outcomeOk =
    step.outcomes.length === 0
      ? result.outcome === undefined
      : result.outcome !== undefined && step.outcomes.includes(result.outcome);
  if (!outcomeOk) return { ok: false, error: "unknown_outcome" };
  const r = checkRecord(step.fields, result.fields ?? {});
  return r === "ok" ? { ok: true } : { ok: false, error: r };
}
