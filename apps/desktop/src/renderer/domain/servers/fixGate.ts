import type { Conversation, ConversationEvent, Task } from "../../data/model";
import { CLAUDE_ID } from "../../data/ids";

// La correzione di un server (area 8, F4b; anti-obiettivo 2) ha due
// condizioni, sempre: parte solo da una task legata a QUEL server, avviata
// da chi ha `servers.operate` nel suo progetto; e nessun comando che CAMBIA
// precede un piano approvato da una persona con `plans.approve` in quel
// progetto — nemmeno se chi avvia può approvare. Il piano è una sequenza di
// azioni dell'insieme CHIUSO (`SERVER_ACTIONS`), eseguite dall'AGENTE di
// monitoraggio una alla volta, mai via SSH: senza le operazioni dell'agente
// accese non parte niente. Qui le regole pure; i dati le applicano.

/** Perché la correzione non si può avviare adesso; `null` se si può. */
export type FixStartBlock =
  | "no_permission"
  | "not_server_task"
  /** L'agente del server non ha le operazioni accese (F4b): nessun piano si eseguirebbe. */
  | "operations_off"
  | "closed"
  | "run_live"
  /** Il server non è più in un ambiente del progetto della task (R-L2), o non esiste più. */
  | "server_gone"
  /** Sullo stesso server c'è già una correzione viva (da un'altra task). */
  | "server_busy";

/** A che punto è una task di server. */
export type ServerTaskState =
  | "diagnosis_ready"
  | "fix_planning"
  | "plan_awaiting"
  | "plan_rejected"
  | "fixing"
  | "stopped"
  /** Claude ha guardato e nessuna azione dell'insieme chiuso serve: nessun piano. */
  | "no_plan"
  | "resolved"
  | "not_resolved"
  | "closed";

/**
 * Il motivo, in quest'ordine, per cui `task` non può avviare una correzione:
 * il permesso prima di tutto, poi la task (di server, il cui server è
 * ancora in un ambiente del SUO progetto, aperta, senza una sessione viva),
 * poi il server (nessun'altra correzione viva, le operazioni dell'agente
 * accese).
 *
 * `serverInProject`: il server di `serverRef` esiste ed è in un ambiente del
 * progetto della task (R-L2). Un server tolto dal progetto non si corregge
 * da lì, anche se chi avvia lo vede per un altro progetto (R-G5).
 */
export function fixStartBlock(input: {
  hasOperate: boolean;
  task: Task;
  serverInProject: boolean;
  operationsOn: boolean;
  liveRun: boolean;
  serverBusy: boolean;
}): FixStartBlock | null {
  const { hasOperate, task, liveRun } = input;
  if (!hasOperate) return "no_permission";
  if (!task.serverRef) return "not_server_task";
  if (!input.serverInProject) return "server_gone";
  if (task.closedAt !== null) return "closed";
  if (liveRun) return "run_live";
  if (input.serverBusy) return "server_busy";
  if (!input.operationsOn) return "operations_off";
  return null;
}

type PlanEvent = Extract<ConversationEvent, { type: "plan" }>;
type ActionEvent = Extract<ConversationEvent, { type: "action" }>;

/** Approvato da una PERSONA: con chi ha deciso, e mai Claude (R-L9, R-L11). */
const approvedByPerson = (p: PlanEvent) =>
  p.status === "approved" && p.decidedById !== undefined && p.decidedById !== CLAUDE_ID;

/** Un comando che cambia il server: dal suo `serverCommand`, o dallo strumento della correzione. */
const isChange = (e: ActionEvent) => e.serverCommand?.kind === "change" || e.tool === "server.fix";

/**
 * Quanti comandi che CAMBIANO il server nel flusso non sono coperti da un
 * piano approvato da una persona: vale l'ultimo piano che li precede, e il
 * comando deve portarne l'id (`approvalId`) — un piano nuovo rimette il
 * cancello, e un'approvazione di un altro piano non vale. Un
 * `pre_approved` non vale. Deve essere sempre 0.
 */
export function fixCommandsBeforeApproval(events: ConversationEvent[]): number {
  let latestPlan: PlanEvent | null = null;
  let count = 0;
  for (const e of events) {
    if (e.type === "plan") latestPlan = e;
    else if (e.type === "action" && isChange(e)) {
      const covered =
        latestPlan !== null &&
        approvedByPerson(latestPlan) &&
        e.serverCommand?.approvalId === latestPlan.id;
      if (!covered) count++;
    }
  }
  return count;
}

type WorkResult = Extract<ConversationEvent, { type: "work_result" }>;

/** L'ultima sessione di correzione di una task, col suo flusso. */
export type FixRun = { c: Conversation; events: ConversationEvent[] };

const lastPlan = (events: ConversationEvent[]) =>
  events.filter((e): e is PlanEvent => e.type === "plan").at(-1) ?? null;

/** Lo stato della correzione senza guardare se la task è chiusa (`serverTaskState` lo aggiunge). */
function runState(run: FixRun | null): Exclude<ServerTaskState, "closed"> {
  if (run === null) return "diagnosis_ready";
  const { c, events } = run;
  const plan = lastPlan(events);
  const check = events
    .filter(
      (e): e is WorkResult =>
        e.type === "work_result" && e.kind === "server_check" && e.resolved !== undefined,
    )
    .at(-1);

  if (check) return check.resolved ? "resolved" : "not_resolved";
  if (c.state === "finished") {
    const rejected = c.outcome === "stopped" && plan?.status === "rejected" && !plan.instructions;
    if (rejected) return "plan_rejected";
    // Finita bene senza un piano: nessuna azione dell'insieme chiuso serviva.
    return plan === null && c.outcome === "ok" ? "no_plan" : "stopped";
  }
  if (plan === null) return "fix_planning";
  if (approvedByPerson(plan)) return "fixing";
  if (plan.status === "rejected") return "fix_planning";
  return "plan_awaiting";
}

/**
 * Lo stato di una task di server, dall'ultima sessione di correzione (`run`,
 * `null` se non ce n'è). «Risolto/non risolto» lo dice SOLO il campo
 * `resolved` del `work_result` `server_check` (R-L3), mai l'esito della
 * sessione: una sessione finita senza controllo (errore, tempo scaduto,
 * operazioni spente, Stop) si legge `stopped`, che non afferma niente sul
 * problema. Un rifiuto senza indicazioni chiude la sessione (`stopped`) e
 * si legge «piano rifiutato»; con indicazioni Claude riscrive il piano.
 */
export function serverTaskState(task: Task, run: FixRun | null): ServerTaskState {
  if (task.closedAt !== null) return "closed";
  return runState(run);
}

/** Lo stato di un passo del piano (`serverFixStepViewSchema`). */
export type FixStepStatus = "waiting" | "running" | "done" | "failed" | "skipped";

export interface FixStep {
  index: number;
  action: string;
  params: Record<string, unknown>;
  why: string;
  status: FixStepStatus;
}

/**
 * I passi dell'ultimo piano, con lo stato di ognuno: il passo `i` è l'i-esimo
 * comando che cambia coperto da QUEL piano (`approvalId`). Una sessione
 * finita lascia `skipped` i passi mai partiti.
 */
export function fixSteps(run: FixRun | null): FixStep[] {
  if (run === null) return [];
  const plan = lastPlan(run.events);
  if (!plan?.serverPlan) return [];
  const ran = run.events.filter(
    (e): e is ActionEvent =>
      e.type === "action" && isChange(e) && e.serverCommand?.approvalId === plan.id,
  );
  const finished = run.c.state === "finished";
  return plan.serverPlan.steps.map((step, index) => {
    const cmd = ran[index];
    const status: FixStepStatus = cmd
      ? cmd.state === "running"
        ? "running"
        : cmd.state === "failed"
          ? "failed"
          : "done"
      : finished && approvedByPerson(plan)
        ? "skipped"
        : "waiting";
    return {
      index,
      action: step.action,
      params: { ...step.params },
      why: step.why,
      status,
    };
  });
}

/** Lo stato della correzione come lo dice `serverFixViewSchema`. */
export type ServerFixStatus =
  | "none"
  | "proposing"
  | "awaiting_approval"
  | "approved"
  | "running"
  | "done"
  | "failed"
  | "stopped"
  | "rejected";

/**
 * Lo stato della correzione per la vista (`serverFixViewSchema.status`),
 * dalla stessa lettura di `serverTaskState`. «approved»: approvato, nessun
 * comando partito ancora; «failed»: un errore, il tempo scaduto, o nessun
 * piano possibile con le azioni ammesse.
 */
export function serverFixStatus(_task: Task, run: FixRun | null): ServerFixStatus {
  switch (runState(run)) {
    case "diagnosis_ready":
      return "none";
    case "fix_planning":
      return "proposing";
    case "plan_awaiting":
      return "awaiting_approval";
    case "plan_rejected":
      return "rejected";
    case "fixing":
      return run!.events.some((e) => e.type === "action" && isChange(e)) ? "running" : "approved";
    case "resolved":
    case "not_resolved":
      return "done";
    case "no_plan":
      return "failed";
    case "stopped":
      return run!.c.outcome === "failed" || run!.c.outcome === "timed_out" ? "failed" : "stopped";
  }
}
