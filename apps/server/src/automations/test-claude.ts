import type { Db } from "@stubwise/db";
import { aiBudgetState } from "@stubwise/notifications";
import {
  buildClaudePrompt,
  CLAUDE_INPUT_MAX,
  checkClaudeResult,
  estimateCostUsd,
  lookup,
  parseClaudeAnswer,
  resolveApiModelId,
  stepAt,
  type AutomationFlow,
  type Step,
} from "@stubwise/shared";
import { resolveChatModel, type ChatLlm } from "../routes/chat-llm.js";
import { AutomationError, managedAutomation, versionsOf, type Viewer } from "./model.js";

type ClaudeStep = Extract<Step, { kind: "claude" }>;

/**
 * LA PROVA CON CLAUDE VERO (area 7, F3, S6; D4 = a). La prova gira nel client,
 * tranne i passi di Claude, che passano da qui (il client non chiama mai il
 * modello). Solo chi GESTISCE l'automazione (403 altrimenti, senza spendere);
 * il budget mensile si ricontrolla a ogni passo (409 `budget`, nessuna
 * chiamata); il prompt è LO STESSO dell'esecuzione (`buildClaudePrompt` di
 * shared); la forma la verifica `checkClaudeResult`, come il motore. Non scrive
 * niente fuori dalla riga dei consumi (`agent_runs`, owner `automation_id`
 * senza run: è una prova).
 */

export const AUTOMATION_STEP_DEFAULT_MODEL = resolveApiModelId("sonnet");
/** I token di sistema e d'uscita che la stima aggiunge (prudente: si dice prima di spendere). */
const OVERHEAD_TOKENS = 600;
const OUTPUT_TOKENS_BASE = 300;
const OUTPUT_TOKENS_PER_FIELD = 150;
const MAX_ROUNDS = 50;

async function versionFlow(db: Db, viewer: Viewer, code: string, version: number | "draft", rev?: number | null) {
  const a = await managedAutomation(db, viewer, code);
  const versions = await versionsOf(db, a.id);
  const last = versions.at(-1)!;
  const v = version === "draft" ? (last.publishedAt === null ? last : undefined) : versions.find((x) => x.n === version);
  if (!v) throw new AutomationError(400, version === "draft" ? "no_draft" : "version", "Unknown version");
  // Review renderer F3: la prova gira sul passo che il client controlla, non su una bozza cambiata nel frattempo.
  if (rev !== undefined && v.rev !== rev) throw new AutomationError(409, "stale", "The version changed", { rev: v.rev });
  return { a, flow: v.flow as AutomationFlow };
}

const inputsOf = (step: ClaudeStep, vars: Record<string, unknown>) => Object.fromEntries(step.inputs.map((k) => [k, lookup(vars, k) ?? ""]));

/**
 * Gli input per la STIMA (review F3, M8): un input che l'esempio non ha (lo
 * ricava un passo prima, es. un campo di Claude) non conta come vuoto, ma
 * pieno fino al taglio: la stima è un tetto, e lo dice.
 */
function estimateInputs(step: ClaudeStep, event: Record<string, unknown>): { inputs: Record<string, unknown>; guessed: boolean } {
  let guessed = false;
  const inputs = Object.fromEntries(
    step.inputs.map((k) => {
      const v = lookup(event, k);
      if (v === undefined || v === null || v === "") {
        guessed = true;
        return [k, "x".repeat(CLAUDE_INPUT_MAX)];
      }
      return [k, v];
    }),
  );
  return { inputs, guessed };
}

/**
 * La stima (C-F3-2, gratuita): `estimateCostUsd` sui token stimati (4
 * caratteri l'uno) del prompt vero di ogni passo di Claude raggiungibile, coi
 * giri di un «per ogni» contati dall'esempio (al più 50). Un modello senza
 * tariffa → `estimateUsd: null` (mai uno zero inventato).
 */
export async function estimateTest(db: Db, viewer: Viewer, code: string, input: { version: number | "draft"; event: Record<string, unknown> }) {
  const { flow } = await versionFlow(db, viewer, code, input.version);
  const model = await resolveChatModel(db, "automation_step", AUTOMATION_STEP_DEFAULT_MODEL, undefined);
  let claudeSteps = 0;
  let total = 0;
  let priced = true;
  // Review renderer F3: un «per ogni» su un elenco che l'esempio non ha (lo decide Claude) conta il MASSIMO dei giri.
  let upperBound = false;
  const walk = (steps: Step[], rounds: number) => {
    for (const s of steps) {
      if (s.kind === "claude") {
        claudeSteps += rounds;
        const est = estimateInputs(s, input.event);
        if (est.guessed) upperBound = true;
        const { prompt } = buildClaudePrompt(s, est.inputs);
        const cost = estimateCostUsd(model, {
          inputTokens: Math.ceil(prompt.length / 4) + OVERHEAD_TOKENS,
          outputTokens: OUTPUT_TOKENS_BASE + OUTPUT_TOKENS_PER_FIELD * s.fields.length,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
        });
        if (cost === null) priced = false;
        else total += cost * rounds;
        for (const branch of Object.values(s.branches)) walk(branch, rounds);
      } else if (s.kind === "forEach") {
        const items = lookup(input.event, s.list);
        if (!Array.isArray(items)) upperBound = true;
        walk(s.steps, rounds * (Array.isArray(items) ? Math.max(1, Math.min(items.length, MAX_ROUNDS)) : MAX_ROUNDS));
      } else if (s.kind === "repeatUntil") {
        walk(s.steps, rounds * Math.min(s.max, 10));
        walk(s.onLimit, rounds);
      } else if (s.kind === "condition") {
        walk(s.then, rounds);
        walk(s.else, rounds);
      }
    }
  };
  walk(flow.steps, 1);
  return { claudeSteps, estimateUsd: claudeSteps === 0 ? 0 : priced ? Math.round(total * 10_000) / 10_000 : null, model, upperBound };
}

/**
 * Una prova alla volta per automazione (review F3, M9): richieste parallele
 * passerebbero tutte il controllo del budget prima che la prima abbia speso.
 * Il server è un processo solo: basta un insieme in memoria.
 */
const testsRunning = new Set<string>();

/** Un passo di Claude della prova: il budget, la chiamata, la verifica. */
export async function runTestClaude(db: Db, llm: ChatLlm, viewer: Viewer, code: string, input: { version: number | "draft"; rev?: number | null; path: string; vars: Record<string, unknown> }) {
  const { a, flow } = await versionFlow(db, viewer, code, input.version, input.rev);
  const step = stepAt(flow.steps, input.path);
  if (!step || step.kind !== "claude") throw new AutomationError(400, "path", "That step is not a Claude step");
  if (testsRunning.has(a.id)) throw new AutomationError(409, "test_busy", "Another test step of this automation is running");
  testsRunning.add(a.id);
  try {
    return await testStep(db, llm, viewer, a, step, input.vars);
  } finally {
    testsRunning.delete(a.id);
  }
}

async function testStep(db: Db, llm: ChatLlm, viewer: Viewer, a: { id: string; projectId: string }, step: ClaudeStep, vars: Record<string, unknown>) {
  if ((await aiBudgetState(db)).exhausted) throw new AutomationError(409, "budget", "The monthly AI budget is used up");
  const { prompt, truncated } = buildClaudePrompt(step, inputsOf(step, vars));
  let text = "";
  for await (const delta of llm.stream({
    system: "",
    messages: [{ role: "user", content: prompt }],
    usage: { operation: "automation_step", projectId: a.projectId, automationId: a.id, defaultModel: AUTOMATION_STEP_DEFAULT_MODEL, userId: viewer.id },
  })) {
    text += delta;
  }
  const answer = parseClaudeAnswer(text);
  if (!answer) throw new AutomationError(422, "claude_invalid", "Claude's answer is not a JSON object", { result: { raw: text.slice(0, 2_000) } });
  const check = checkClaudeResult(step, answer);
  if (!check.ok) throw new AutomationError(422, "claude_invalid", "Claude's answer doesn't fit the step", { result: answer, error: check.error });
  return { ...answer, truncated };
}
