import type { ClaudeWorkState, RequestStatus } from "../data/types";

// Il PASSO SUCCESSIVO di una richiesta (`deriveNextStep` di
// `@stubwise/shared`, la riga «prossimo passo» del web): dove sta nel
// percorso idea → task → modifica pronta. Deterministico per costruzione:
// solo dallo stato della richiesta, della task nata da lei e del lavoro di
// Claude, MAI scritto da un modello — una frase sbagliata su cosa fare
// adesso è peggio di nessuna frase.

export type NextStep =
  | "clarify"
  | "readyToConvert"
  | "convertedNoRun"
  | "preparingPlan"
  /** Area 9b: il lavoro è partito ma aspetta la coda in pausa (o il budget). */
  | "waitingQueue"
  | "awaitingApproval"
  | "executing"
  | "prReady"
  | "done"
  | "merged"
  | "workFinished"
  | "needsAttention";

export interface NextStepInput {
  status: RequestStatus;
  /** La task nata dalla richiesta, se chi guarda la vede. */
  task: { closed: boolean; claude: ClaudeWorkState } | null;
  /** La fase della sessione di Claude in corso, se chi guarda la vede. */
  phase: string | null;
  /** La PR della task: una aperta, altrimenti mergiata, altrimenti chiusa senza merge; o nessuna. */
  pr: "open" | "merged" | "closed" | null;
}

/** Le fasi in cui Claude sta ancora preparando il piano. */
const PLANNING = new Set(["triage", "plan", "replanning"]);

export function requestNextStep(input: NextStepInput): NextStep | null {
  if (input.status === "archived") return null;
  if (input.status === "new" || input.status === "refining") return "clarify";
  if (input.status === "ready") return "readyToConvert";
  // Trasformata: la riga parla della task, e se chi guarda non la vede tace.
  const task = input.task;
  if (!task) return null;
  if (task.closed) return "done";
  switch (task.claude) {
    case "none":
      return "convertedNoRun";
    case "working":
      return input.phase !== null && PLANNING.has(input.phase) ? "preparingPlan" : "executing";
    case "waiting":
      return "waitingQueue";
    case "awaiting_approval":
      return "awaitingApproval";
    case "awaiting_answer":
    case "stopped":
      return "needsAttention";
    // Claude ha finito ma la task è aperta: la riga non dice «fatto».
    case "done":
      if (input.pr === "open") return "prReady";
      if (input.pr === "merged") return "merged";
      // Una PR chiusa senza merge, e nessuna aperta: c'è da guardarci.
      if (input.pr === "closed") return "needsAttention";
      return "workFinished";
  }
}
