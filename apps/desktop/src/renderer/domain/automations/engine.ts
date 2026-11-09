import type { AutomationFlow, ReasonCode, RunLogEntry, RunStatus, Step } from "../../data/types";
import { handle } from "./engineInputs";
import { run, type Ctx } from "./engineLoop";
import type { ActionStep, ApprovalWho } from "./preview";

// Il motore delle automazioni: puro. `advance` prende lo stato e un input
// (l'evento d'inizio, un'approvazione, il tempo che passa, l'esito di un
// effetto…) e restituisce lo stato nuovo, gli effetti da eseguire e le righe
// del registro (senza `at`: la data la mette chi registra). Non esegue
// niente: le azioni le fa un esecutore (Task 3), e il loro esito rientra
// come input. Il tempo arriva solo dagli input, mai dall'orologio.
//
// Le tre regole dell'anti-obiettivo stanno qui:
// 1. un passo con `approval.mode = "ask"` porta lo stato in
//    `waiting_approval` senza effetti, e solo `approved` lo sblocca: ogni
//    altro input in quello stato è ignorato (nessun effetto, nessuna riga);
// 2. il risultato di Claude passa da `checkClaudeResult`: uscita o campi
//    fuori dal dichiarato fanno fallire il passo, e la motivazione non è mai
//    interpretata;
// 3. ogni passo eseguito scrive una riga, con dati, esito, motivazione e
//    chi ha approvato.
// Un input che lo stato non aspetta è ignorato allo stesso modo.
//
// R-J8 — chi approva lo controlla l'esecutore (Task 3), che risolve `who`
// (persona, ruolo nel progetto, proprietario) e verifica che veda il
// progetto: il motore si fida che `approved`/`rejected` gli arrivino solo da
// un approvatore ammesso. Controlla invece il PERCORSO: un'approvazione vale
// solo per il passo che la aspetta (`path === awaiting.path`), così quella di
// un giro precedente, ripetuta, non sblocca il giro dopo né vi porta le sue
// correzioni (`edited`).
//
// Note per il Task 3 (esecutore e livello dati):
// - un effetto in volo (`awaiting.kind` `"effect"` o `"claude"`) viene
//   riemesso dopo `restoreState`: sospendere (pausa) solo negli stati senza
//   un effetto in volo, o l'effetto partirebbe due volte;
// - una risposta in ritardo si abbina per id del passo `sendEmail`, non per
//   giro: la risposta al promemoria del giro 0 sblocca anche l'attesa del
//   giro 1 (stesso passo);
// - il limite di 20 email vale per esecuzione: le catene di avvii
//   (`startAutomation` che avvia sé stessa o un ciclo, shape [A 16]) e un
//   `automationId` inesistente sono dell'esecutore — validazione coi dati e
//   profondità massima della catena 3 a runtime.
//
// Le anteprime e la lettura dei dati stanno in `preview.ts`, la ripresa di
// un'esecuzione salvata in `restore.ts`.
// Il ciclo (entrare nei passi, eseguire finché si può) sta in `engineLoop.ts`,
// gli input in `engineInputs.ts`.

export type ClaudeStep = Extract<Step, { kind: "claude" }>;
export type WaitStep = Extract<Step, { kind: "wait" }>;
export type ActionKind = ActionStep["kind"];

/** Cosa può arrivare a un'attesa: la risposta a un'email (per id del passo), una task chiusa. */
export type EnginePayload =
  | { kind: "reply"; to: string; text: string }
  | { kind: "task_closed"; taskStepId: string };

export type EngineInput =
  | { kind: "start"; event: Record<string, unknown> }
  /** `path`: il passo approvato; vale solo se è quello che aspetta (R-J8). */
  | { kind: "approved"; path: string; byId: string; edited?: Record<string, string> }
  | { kind: "rejected"; path: string; byId: string }
  | { kind: "event"; payload: EnginePayload }
  | { kind: "time"; now: string }
  | { kind: "project_chosen"; projectId: string; byId?: string }
  | {
      kind: "effect_result";
      ok: boolean;
      codes?: string[];
      error?: string;
      reason?: string;
      /** La motivazione per l'interfaccia (B1). */
      why?: ReasonCode;
    }
  | { kind: "claude_result"; outcome?: string; fields?: Record<string, unknown>; reason: string };

/** Il progetto in cui agisce un effetto: quello dell'automazione, o uno risolto. */
export type ResolvedTarget = { mode: "own" } | { mode: "fixed"; projectId: string };

export type EffectRequest =
  | {
      kind: ActionKind;
      stepId: string;
      path: string;
      args: Record<string, unknown>;
      projectTarget?: ResolvedTarget;
    }
  | {
      kind: "claude";
      stepId: string;
      path: string;
      step: ClaudeStep;
      vars: Record<string, unknown>;
    }
  /** Trova il progetto dal cliente (tabella cliente → progetto); risponde `project_chosen`, o `effect_result` con `ok: false` se non lo trova. */
  | { kind: "resolve_project"; stepId: string; path: string; clientRef: string; clientKey: string };

/** L'errore di `effect_result` che porta in «scegli il progetto». */
export const PROJECT_NOT_FOUND = "project_not_found";

export type Frame =
  /** Una lista di passi; `i` è il prossimo da eseguire. */
  | { t: "list"; base: string; i: number }
  /** Un `forEach`: gli elementi fissati all'ingresso, il giro corrente (-1 prima del primo). */
  | { t: "forEach"; path: string; as: string; items: unknown[]; current: number }
  /** Un `repeatUntil`: i giri fatti, e se si sta eseguendo `onLimit`. */
  | { t: "repeat"; path: string; round: number; onLimit: boolean };

/** Cosa aspetta l'esecuzione, al passo del cursore. */
export type Awaiting =
  /** `asked`: il progetto non è stato trovato e lo sceglie il proprietario (`waiting_project`). */
  | { kind: "project"; path: string; clientKey: string; asked: boolean }
  | {
      kind: "approval";
      path: string;
      who: ApprovalWho;
      preview: Record<string, unknown>;
    }
  | { kind: "effect"; path: string; preview: Record<string, unknown> }
  | { kind: "claude"; path: string; input: Record<string, unknown> }
  | { kind: "wait"; path: string; until: string };

export interface EngineState {
  flow: AutomationFlow;
  status: RunStatus;
  started: boolean;
  event: Record<string, unknown>;
  /** Le variabili scritte dai passi (chiavi piatte, es. "analisi.task"). */
  vars: Record<string, unknown>;
  /** L'ultima ora nota (dall'inizio o da un input `time`). */
  now: string;
  stack: Frame[];
  /** Il percorso (R-J5) del passo corrente. */
  cursor: string | null;
  awaiting: Awaiting | null;
  waitingUntil: string | null;
  /** Cliente → progetto, risolti in questa esecuzione. */
  projects: Record<string, string>;
  /** I codici creati da ogni passo (per `milestoneRef`). */
  created: Record<string, string[]>;
  emailsSent: number;
  /** Azioni e chiamate a Claude emesse (R-J9). */
  effectsSent: number;
  /** Gli elementi di ogni `forEach` in corso, fissati all'ingresso (per percorso). */
  loops: Record<string, unknown[]>;
  /** Un codice macchina (`permission_lost`, `unknown_outcome`, `limit`…). */
  error: string | null;
}

export type LogRow = Omit<RunLogEntry, "at">;

export interface EngineStep {
  state: EngineState;
  effects: EffectRequest[];
  log: LogRow[];
}

/** Uno stato nuovo, prima dell'inizio: lo avvia l'input `start`. */
export function initialState(flow: AutomationFlow, now: string): EngineState {
  return {
    flow,
    status: "running",
    started: false,
    event: {},
    vars: {},
    now,
    stack: [],
    cursor: null,
    awaiting: null,
    waitingUntil: null,
    projects: {},
    created: {},
    emailsSent: 0,
    effectsSent: 0,
    loops: {},
    error: null,
  };
}

/**
 * Un passo del motore. Puro: lo stato in ingresso non cambia. Un input che
 * lo stato non aspetta non produce effetti né righe (regola 1).
 */
export function advance(state: EngineState, input: EngineInput): EngineStep {
  const c: Ctx = { st: structuredClone(state), effects: [], log: [] };
  const terminal =
    state.status === "done" || state.status === "failed" || state.status === "cancelled";
  if (terminal || (!state.started && input.kind !== "start")) {
    if (input.kind === "time" && Date.parse(input.now) > Date.parse(state.now))
      c.st.now = input.now;
    return { state: c.st, effects: [], log: [] };
  }
  handle(c, input);
  run(c);
  return { state: c.st, effects: c.effects, log: c.log };
}
