import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Db } from "@stubwise/db";
import { aiBudgetState } from "@stubwise/notifications";
import { buildClaudePrompt, parseClaudeAnswer, untrustedText, type Step } from "@stubwise/shared";
import { NATIVE_TOOLS } from "../agent/native-tools.js";
import type { AgentRunner, UsageTag } from "../agent/runner.js";
import { textFromRun } from "../agent/text.js";

type ClaudeStep = Extract<Step, { kind: "claude" }>;

/**
 * IL PASSO DI CLAUDE (area 7, F3, S2 e S3; piano C-F3-1, C-F3-4, C-F3-6). È
 * l'eccezione dichiarata all'invariante delle serie (Q8): un'automazione può
 * far lavorare Claude senza un umano davanti, a queste condizioni, tutte qui.
 *
 * - **Il budget mensile prima di OGNI passo** (D1, `aiBudgetState`): esaurito
 *   → nessuna chiamata, l'esecuzione aspetta (`monthly_budget`).
 * - **Claude non esegue niente**: nessuno strumento (`NATIVE_TOOLS.text`),
 *   nessun MCP, un turno solo, una cartella vuota tolta alla fine. Le azioni
 *   sono i passi del flusso, coi permessi del proprietario (F1).
 * - **Il prompt**: l'istruzione del passo (scritta da chi gestisce: fidata),
 *   le uscite e i campi dichiarati col loro tipo, e gli input fra delimitatori
 *   come contenuto NON fidato — i delimitatori si tolgono dal testo, così un
 *   input non chiude il blocco (la tecnica di `google/meetings.ts`). Un input
 *   oltre 20 000 caratteri si taglia, e il registro lo dice (F3-5 = a).
 * - **La risposta** è un oggetto JSON `{ outcome?, fields?, reason }`; la
 *   verifica di forma la fa il motore (`checkClaudeResult`). Una risposta che
 *   non è un oggetto JSON è `claude_invalid`. Un errore del provider (limite,
 *   rete, uscita non zero) NON è un risultato: si aspetta e si riprova.
 * - Il consumo va in `agent_runs` col `UsageTag` `automation_step` e l'owner
 *   `automation_id` (+ `automation_run_id`, assente per una prova).
 */

/** Re-esportati per i test e per chi li usava: la regola sta in shared (`claudePrompt.ts`). */
export { buildClaudePrompt, untrustedText as untrusted };

export type ClaudeStepOutcome =
  /** Il risultato, da rimettere nel motore (la forma la verifica lui). */
  | { kind: "result"; outcome?: string; fields?: Record<string, unknown>; reason: string; truncated: string[] }
  /** Una risposta che non è un oggetto JSON. */
  | { kind: "invalid"; reason: string }
  /** Il budget del mese è finito: nessuna chiamata. */
  | { kind: "budget" }
  /** Il provider non ha risposto (limite, rete, uscita non zero): si riprova. */
  | { kind: "provider_error"; reason: string };

export interface ClaudeStepDeps {
  db: Db;
  runner: AgentRunner;
  /** Solo nei test. */
  monthlyCostUsdFn?: (db: Db) => Promise<number>;
}

/**
 * La chiamata al modello di un passo di Claude, con le opzioni dell'esecuzione
 * vera (nessuno strumento, un turno, una cartella vuota tolta alla fine): la
 * usano l'esecutore (dopo il budget) e lo scenario golden `automation-step`.
 */
export async function callClaudeModel(
  runner: AgentRunner,
  input: { step: ClaudeStep; inputs: Record<string, unknown>; usage: UsageTag; model?: string },
): Promise<ClaudeStepOutcome & { raw?: string }> {
  const { prompt, truncated } = buildClaudePrompt(input.step, input.inputs);
  const cwd = await mkdtemp(join(tmpdir(), "stubwise-automation-step-"));
  try {
    let text: string | null;
    let raw = "";
    try {
      const result = await runner.run({
        cwd,
        prompt,
        usage: input.usage,
        ...(input.model ? { model: input.model } : {}),
        builtinTools: NATIVE_TOOLS.text,
        permissionMode: "default",
        maxTurns: 1,
        timeoutMs: 120_000,
      });
      raw = result.output;
      text = textFromRun(result);
    } catch (err) {
      return { kind: "provider_error", reason: err instanceof Error ? err.message : String(err) };
    }
    if (text === null) return { kind: "provider_error", reason: "Nessuna risposta dal modello.", raw };
    const answer = parseClaudeAnswer(text);
    if (!answer) return { kind: "invalid", reason: "La risposta di Claude non è un oggetto JSON.", raw };
    return { kind: "result", ...(answer.outcome !== undefined ? { outcome: answer.outcome } : {}), ...(answer.fields !== undefined ? { fields: answer.fields } : {}), reason: answer.reason, truncated, raw };
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

export async function runClaudeStep(
  deps: ClaudeStepDeps,
  input: { step: ClaudeStep; inputs: Record<string, unknown>; projectId: string | null; automationId: string; automationRunId: string | null },
): Promise<ClaudeStepOutcome> {
  if ((await aiBudgetState(deps.db, deps.monthlyCostUsdFn)).exhausted) return { kind: "budget" };
  const { raw: _raw, ...out } = await callClaudeModel(deps.runner, {
    step: input.step,
    inputs: input.inputs,
    usage: { operation: "automation_step", projectId: input.projectId, automationId: input.automationId, ...(input.automationRunId ? { automationRunId: input.automationRunId } : {}) },
  });
  void _raw;
  return out;
}
