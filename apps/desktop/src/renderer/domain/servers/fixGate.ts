import type { Conversation, ConversationEvent, ServerSshAccess, Task } from "../../data/model";
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
  | "run_live";

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
 * il permesso prima di tutto, poi la task (di server, aperta, senza una
 * sessione viva), poi l'accesso di correzione del SUO server (un accesso di
 * un altro server non vale).
 */
export function fixStartBlock(input: {
  hasOperate: boolean;
  task: Task;
  access: ServerSshAccess | undefined;
  liveRun: boolean;
}): FixStartBlock | null {
  const { hasOperate, task, liveRun } = input;
  if (!hasOperate) return "no_permission";
  if (!task.serverRef) return "not_server_task";
  if (task.closedAt !== null) return "closed";
  if (liveRun) return "run_live";
  const access = input.access?.serverCode === task.serverRef.serverCode ? input.access : undefined;
  if (!access || (access.keys === null && access.pending === null)) return "no_fix_access";
  if (!accessUsable(access, "fix")) return "fix_access_unverified";
  return null;
}

type PlanEvent = Extract<ConversationEvent, { type: "plan" }>;

const approvedByPerson = (p: PlanEvent) => p.status === "approved" && p.decidedById !== undefined;

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

/**
 * Lo stato di una task di server, dall'ultima sessione di correzione (`run`,
 * `null` se non ce n'è). Convenzione con la correzione (Task 6): finito il
 * controllo in sola lettura (`work_result` `server_check`), la sessione si
 * chiude con esito `ok` se il problema è risolto, `failed` se no. Un rifiuto
 * senza indicazioni chiude la sessione (`stopped`) e si legge «piano
 * rifiutato»; con indicazioni Claude riscrive il piano.
 */
export function serverTaskState(
  task: Task,
  run: { c: Conversation; events: ConversationEvent[] } | null,
): ServerTaskState {
  if (task.closedAt !== null) return "closed";
  if (run === null) return "diagnosis_ready";
  const { c, events } = run;
  const plans = events.filter((e): e is PlanEvent => e.type === "plan");
  const plan = plans.at(-1) ?? null;

  if (c.state === "finished") {
    if (c.outcome === "stopped") {
      return plan?.status === "rejected" && !plan.instructions ? "plan_rejected" : "stopped";
    }
    return c.outcome === "ok" ? "resolved" : "not_resolved";
  }
  if (plan === null) return "fix_planning";
  if (approvedByPerson(plan)) return "fixing";
  if (plan.status === "rejected") return "fix_planning";
  return "plan_awaiting";
}
