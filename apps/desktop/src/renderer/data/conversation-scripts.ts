import type { ScriptStep, Task } from "./types";

// I passi di Claude nelle sessioni di lavoro che le scritture del livello
// dati avviano (avvio, rilancio, correzione, refine): il prototipo non
// chiama la pipeline, quindi recita il suo percorso di oggi — piano, gate
// di approvazione, esecuzione, PR — con lo stream. Puri: il testo segue i
// flussi del seed (in inglese, come lì); id e date li dà `runScript`.

/** Il piano che Claude scrive per una task. */
export function planOf(task: Task): { planText: string; summary: string } {
  return {
    planText: [
      `## ${task.title}`,
      "",
      "### Changes",
      "",
      `1. Read the task ${task.code} and the related work to confirm the scope.`,
      "2. Make the change described in the task, keeping what already works unchanged.",
      "3. Check the result and describe it in the task.",
      "",
      "### Risks",
      "",
      "- Low. The change stays inside what the task asks.",
    ].join("\n"),
    summary: `Do what ${task.code} asks in three steps and report back in the task.`,
  };
}

/**
 * L'apertura di un lavoro: la fase del piano e lo stato «al lavoro». È la
 * parte che la scrittura aspetta (la sessione esiste e si vede).
 */
export function runOpening(
  phase: "plan" | "correction",
  authorId: string,
  instructions?: string,
): ScriptStep[] {
  const steps: ScriptStep[] = [{ step: "event", event: { type: "phase", phase, outcome: null } }];
  if (instructions) {
    steps.push({
      step: "event",
      event: { type: "user", authorId, text: instructions, attachments: [], delivery: "delivered" },
    });
  }
  steps.push({ step: "state", state: "working" });
  return steps;
}

/** Claude legge la task prima di scrivere il piano. */
export function planReading(task: Task): ScriptStep[] {
  return [
    { step: "action", tool: "stubwise.read_task", label: `Reads ${task.code} · ${task.title}` },
    { step: "action", tool: "repo.search", label: `Searches the related work of ${task.code}` },
    { step: "say", text: `I have read ${task.code}. Here is the plan.` },
  ];
}

/**
 * Il piano arriva. Con il gate (chi ha avviato non ha `plans.approve` e il
 * piano non è approvato in anticipo) Claude si ferma ad aspettare
 * l'approvazione; altrimenti prosegue con l'esecuzione.
 */
export function planGate(
  task: Task,
  gate: "awaiting" | "pre_approved" | "approved",
  approvedById: string,
): ScriptStep[] {
  const { planText, summary } = planOf(task);
  if (gate === "awaiting") {
    return [
      { step: "event", event: { type: "plan", planText, summary, status: "pending" } },
      { step: "say", text: "The plan waits for someone who can approve plans in this project." },
      { step: "state", state: "awaiting_approval" },
    ];
  }
  return [
    {
      step: "event",
      event: { type: "plan", planText, summary, status: gate, decidedById: approvedById },
    },
    ...execution(task),
  ];
}

/** L'esecuzione dopo il piano: modifiche, prove, PR aperta, fine. */
export function execution(task: Task): ScriptStep[] {
  return [
    { step: "event", event: { type: "phase", phase: "plan", outcome: "ok" } },
    { step: "event", event: { type: "phase", phase: "execution", outcome: null } },
    { step: "state", state: "working" },
    { step: "action", tool: "repo.edit", label: `Applies the changes for ${task.code}` },
    {
      step: "action",
      tool: "shell",
      label: "Runs the tests",
      input: "pnpm test",
      result: "passed",
    },
    {
      step: "say",
      text: `The changes for ${task.code} are in place and the tests pass. Opening the pull request.`,
    },
    {
      step: "event",
      event: {
        type: "work_result",
        kind: "pr_opened",
        text: `Pull request opened for ${task.code}`,
      },
    },
    { step: "event", event: { type: "phase", phase: "execution", outcome: "ok" } },
    { step: "state", state: "finished", outcome: "ok" },
  ];
}

/**
 * Dopo la risposta a una domanda Claude riprende da dove era: in pianificazione
 * scrive il piano (con il gate di chi ha avviato), in esecuzione finisce il
 * lavoro e lo scrive nella task.
 */
export function afterAnswer(
  task: Task,
  phase: string | null,
  label: string,
  gate: "awaiting" | "approved",
  approvedById: string,
): ScriptStep[] {
  const ack: ScriptStep = { step: "say", text: `Thanks: “${label}”. Continuing from there.` };
  if (phase === "plan") return [ack, ...planGate(task, gate, approvedById)];
  return [
    ack,
    { step: "action", tool: "stubwise.update_task", label: `Writes the result in ${task.code}` },
    { step: "event", event: { type: "phase", phase: phase ?? "execution", outcome: "ok" } },
    { step: "state", state: "finished", outcome: "ok" },
  ];
}

/** Il piano rifiutato con indicazioni: Claude lo riscrive e torna al gate. */
export function replanning(task: Task, instructions: string): ScriptStep[] {
  const { planText, summary } = planOf(task);
  return [
    { step: "state", state: "working" },
    { step: "say", text: "Understood. I am rewriting the plan with your instructions." },
    {
      step: "event",
      event: {
        type: "plan",
        planText: `${planText}\n\n### Instructions from the review\n\n${instructions}`,
        summary,
        status: "pending",
      },
    },
    { step: "state", state: "awaiting_approval" },
  ];
}

/** Una correzione sulla PR: la richiesta, le modifiche, la PR aggiornata. */
export function correction(task: Task): ScriptStep[] {
  return [
    { step: "action", tool: "repo.read", label: `Reads the review of ${task.code}` },
    { step: "action", tool: "repo.edit", label: `Applies the requested changes to ${task.code}` },
    {
      step: "action",
      tool: "shell",
      label: "Runs the tests",
      input: "pnpm test",
      result: "passed",
    },
    { step: "say", text: "The requested changes are in place. Pushing the correction." },
    {
      step: "event",
      event: {
        type: "work_result",
        kind: "correction",
        text: `Correction pushed for ${task.code}`,
      },
    },
    { step: "event", event: { type: "phase", phase: "correction", outcome: "ok" } },
    { step: "state", state: "finished", outcome: "ok" },
  ];
}

/** L'apertura di un refine: Claude legge la richiesta e aspetta chi scrive. */
export function refineOpening(code: string, title: string): ScriptStep[] {
  return [
    { step: "event", event: { type: "phase", phase: "refine", outcome: null } },
    { step: "state", state: "working" },
    { step: "action", tool: "stubwise.get_backlog_item", label: `Reads ${code} · ${title}` },
    {
      step: "say",
      text: `I have read ${code}. Tell me what is missing, and I will update its design and plan.`,
    },
    { step: "state", state: "idle" },
  ];
}
