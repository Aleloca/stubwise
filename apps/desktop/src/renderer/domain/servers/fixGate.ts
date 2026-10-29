import type { Conversation, ConversationEvent, ServerSshAccess, Task } from "../../data/model";
import { CLAUDE_ID } from "../../data/seed/people";
import { accessUsable } from "./sshAccess";

// La correzione di un server ha due condizioni, sempre (anti-obiettivo 2):
// parte solo da una task legata a QUEL server, avviata da chi ha
// `servers.operate` nel suo progetto; e nessun comando di correzione
// (`server.fix`) precede un piano approvato da una persona — nemmeno se chi
// avvia può approvare. Qui le regole pure; i dati le applicano.

/** Perché la correzione non si può avviare adesso; `null` se si può. */
export type FixStartBlock =
  | "no_permission"
  | "not_server_task"
  | "no_fix_access"
  | "fix_access_unverified"
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
  | "resolved"
  | "not_resolved"
  | "closed";

/**
 * Il motivo, in quest'ordine, per cui `task` non può avviare una correzione:
 * il permesso prima di tutto, poi la task (di server, il cui server è
 * ancora in un ambiente del SUO progetto, aperta, senza una sessione viva),
 * poi il server (nessun'altra correzione viva), poi l'accesso di correzione
 * del SUO server (un accesso di un altro server non vale).
 *
 * `serverInProject`: il server di `serverRef` esiste ed è in un ambiente del
 * progetto della task (R-L2). Un server tolto dal progetto non si corregge
 * da lì, anche se chi avvia lo vede per un altro progetto (R-G5).
 */
export function fixStartBlock(input: {
  hasOperate: boolean;
  task: Task;
  serverInProject: boolean;
  access: ServerSshAccess | undefined;
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
  const access = input.access?.serverCode === task.serverRef.serverCode ? input.access : undefined;
  if (!access || (access.keys === null && access.pending === null)) return "no_fix_access";
  if (!accessUsable(access, "fix")) return "fix_access_unverified";
  return null;
}

type PlanEvent = Extract<ConversationEvent, { type: "plan" }>;

/** Approvato da una PERSONA: con chi ha deciso, e mai Claude (R-L9, R-L11). */
const approvedByPerson = (p: PlanEvent) =>
  p.status === "approved" && p.decidedById !== undefined && p.decidedById !== CLAUDE_ID;

/**
 * Quanti comandi di correzione (`tool: "server.fix"`) nel flusso non hanno
 * prima un piano approvato da una persona: vale l'ultimo piano che li
 * precede, quindi un piano nuovo rimette il cancello. Un `pre_approved` non
 * vale. Deve essere sempre 0.
 */
export function fixCommandsBeforeApproval(events: ConversationEvent[]): number {
  let latestPlan: PlanEvent | null = null;
  let count = 0;
  for (const e of events) {
    if (e.type === "plan") latestPlan = e;
    else if (e.type === "action" && e.tool === "server.fix") {
      if (latestPlan === null || !approvedByPerson(latestPlan)) count++;
    }
  }
  return count;
}

type WorkResult = Extract<ConversationEvent, { type: "work_result" }>;

/**
 * Lo stato di una task di server, dall'ultima sessione di correzione (`run`,
 * `null` se non ce n'è). «Risolto/non risolto» lo dice SOLO il campo
 * `resolved` del `work_result` `server_check` (R-L3), mai l'esito della
 * sessione: una sessione finita senza controllo (errore, tempo scaduto,
 * accesso revocato, Stop) si legge `stopped`, che non afferma niente sul
 * problema. Un rifiuto senza indicazioni chiude la sessione (`stopped`) e
 * si legge «piano rifiutato»; con indicazioni Claude riscrive il piano.
 */
export function serverTaskState(
  task: Task,
  run: { c: Conversation; events: ConversationEvent[] } | null,
): ServerTaskState {
  if (task.closedAt !== null) return "closed";
  if (run === null) return "diagnosis_ready";
  const { c, events } = run;
  const plan = events.filter((e): e is PlanEvent => e.type === "plan").at(-1) ?? null;
  const check = events
    .filter(
      (e): e is WorkResult =>
        e.type === "work_result" && e.kind === "server_check" && e.resolved !== undefined,
    )
    .at(-1);

  if (check) return check.resolved ? "resolved" : "not_resolved";
  if (c.state === "finished") {
    const rejected = c.outcome === "stopped" && plan?.status === "rejected" && !plan.instructions;
    return rejected ? "plan_rejected" : "stopped";
  }
  if (plan === null) return "fix_planning";
  if (approvedByPerson(plan)) return "fixing";
  if (plan.status === "rejected") return "fix_planning";
  return "plan_awaiting";
}
