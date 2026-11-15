import { ApiError } from "@stubwise/api-client";
import type { Reader, ServerCommandView, ServerFixView, ServerTaskView } from "@stubwise/shared";
import type { ServerCommandRow } from "../../../domain/servers/commands";
import type {
  FixStartBlock,
  FixStepStatus,
  ServerTaskState,
} from "../../../domain/servers/fixGate";
import type { ServerFixInfo, ServerTaskInfo } from "../../servers/reads";
import type { Conversation, EpisodeReason } from "../../types";
import { inPrototypeWords } from "./automationRefs";
import { appClient } from "./client";
import { analysisOf } from "./servers";

// La sezione Server della task nella build app (area 8, F4b): `GET
// /api/tasks/:id/server` (72) e il registro per task (`fixCommands`), nelle
// forme del prototipo (`getServerTaskInfo`). Permessi, blocchi e impronta del
// piano li dice il server; lo stato della task (pianifica, aspetta, risolta…)
// si deriva qui dallo stato della correzione, come concordato con 72.
// Le azioni: chiedi un piano, approva col digest della vista, rifiuta con la
// nota, ferma (`client.serverOps`).

export interface ServerTaskApi {
  taskServer(ticketId: string): Promise<Reader<ServerTaskView>>;
  fixCommands(ticketId: string): Promise<{ commands: Reader<ServerCommandView>[] }>;
  requestPlan(ticketId: string): Promise<Reader<ServerFixView>>;
  approve(ticketId: string, planDigest: string): Promise<Reader<ServerFixView>>;
  reject(ticketId: string, note: string): Promise<Reader<ServerFixView>>;
  stop(ticketId: string): Promise<Reader<ServerFixView>>;
}

type Fix = NonNullable<Reader<ServerTaskView>["fix"]>;
type Status = ServerFixInfo["status"];

const STATUSES: readonly Status[] = [
  "none",
  "proposing",
  "awaiting_approval",
  "approved",
  "running",
  "done",
  "failed",
  "stopped",
  "rejected",
];

const statusOf = (s: string): Status => (STATUSES.includes(s as Status) ? (s as Status) : "none");

/** Lo stato della task dalla correzione (e dal blocco `closed` della task chiusa). */
function taskState(fix: Fix | null, startBlock: string | null): ServerTaskState {
  const status = fix ? statusOf(fix.status) : "none";
  switch (status) {
    case "none":
      // Una proposta che non ha dato un piano (`no_plan`, `timeout`,
      // `monthly_budget`, `no_provider:*`, un piano scartato…): «no plan».
      if (fix?.planError) return "no_plan";
      return startBlock === "closed" ? "closed" : "diagnosis_ready";
    case "proposing":
      return "fix_planning";
    case "awaiting_approval":
      return "plan_awaiting";
    case "approved":
    case "running":
      return "fixing";
    case "rejected":
      return "plan_rejected";
    case "stopped":
      return "stopped";
    case "failed":
      // Un passo con esito negativo o scaduto: «non risolta»; un ricontrollo
      // che non tiene (`recheck:…`, revoca, operazioni spente…) o il worker
      // riavviato: «fermata».
      return /^step_(failed|expired):/.test(fix?.planError ?? "") ? "not_resolved" : "stopped";
    case "done":
      // Ogni passo con esito positivo: se il server è rientrato lo dice l'episodio.
      return "resolved";
  }
}

/** I blocchi del server nelle parole del prototipo (il budget lo dice la riga del blocco AI). */
function startBlockOf(b: string | null): FixStartBlock | null {
  switch (b) {
    case "no_permission":
    case "operations_off":
    case "closed":
    case "server_gone":
      return b;
    case "server_not_in_project":
      return "server_gone";
    case "busy":
    // Un piano che aspetta l'approvazione: prima si decide quello (72, 94be88606).
    case "plan_awaiting":
      return "run_live";
    default:
      return null;
  }
}

const STEP_STATUSES: readonly FixStepStatus[] = ["waiting", "running", "done", "failed", "skipped"];

/** Un comando del registro nella riga del prototipo; l'uscita resta NON fidata. */
export function commandRowOf(c: Reader<ServerCommandView>): ServerCommandRow {
  return {
    id: c.id,
    action: c.action,
    params: { ...c.params },
    kind: c.kind === "change" ? "change" : "read",
    via: c.via === "ssh" ? "ssh" : "agent",
    status:
      c.status === "done" ||
      c.status === "failed" ||
      c.status === "cancelled" ||
      c.status === "expired"
        ? c.status
        : "delivered",
    requestedById: c.requestedBy?.id ?? null,
    approvalId: c.approvalId,
    issuedAt: c.issuedAt,
    exitCode: c.exitCode,
    output: c.output,
  };
}

function fixInfoOf(fix: Fix, commands: ServerCommandRow[]): ServerFixInfo {
  return {
    status: statusOf(fix.status),
    planError: fix.planError,
    steps: fix.steps.map((s) => ({
      index: s.index,
      action: s.action,
      params: { ...s.params },
      why: s.why,
      status: STEP_STATUSES.includes(s.status as FixStepStatus)
        ? (s.status as FixStepStatus)
        : "waiting",
    })),
    approval: fix.approval ? { byId: fix.approval.by.id, at: fix.approval.at } : null,
    rejection: fix.rejection
      ? { byId: fix.rejection.by.id, at: fix.rejection.at, note: fix.rejection.note }
      : null,
    operationsOn: fix.operationsOn,
    canRequestPlan: fix.canRequestPlan,
    canApprove: fix.canApprove,
    // Il server decide approvazione e rifiuto con lo stesso permesso.
    canReject: fix.canApprove,
    canStop: fix.canStop,
    // Chi l'ha chiesta il server non lo dice: niente «You started this fix».
    startedByViewer: false,
    commands,
    // Un avviso senza altri progetti non dice niente (review F4b I2).
    pruneWarning:
      fix.pruneWarning && (fix.pruneWarning.projects.length > 0 || fix.pruneWarning.hiddenCount > 0)
        ? { projects: [...fix.pruneWarning.projects], hiddenCount: fix.pruneWarning.hiddenCount }
        : null,
    planDigest: fix.planDigest,
    sessionId: fix.sessionId,
  };
}

/** Un motivo dell'episodio nella forma del prototipo; uno che l'app non conosce non si mostra. */
function reasonOf(
  r: Reader<ServerTaskView>["episode"] extends infer E
    ? E extends { reasons: (infer R)[] }
      ? R
      : never
    : never,
): EpisodeReason | null {
  if ((r.kind === "cpu" || r.kind === "memory" || r.kind === "disk") && r.valuePct !== undefined)
    return { kind: r.kind, valuePct: r.valuePct, thresholdPct: r.thresholdPct ?? 0 };
  if (r.kind === "agent_silent" && r.since) return { kind: "agent_silent", since: r.since };
  if (r.kind === "check") return { kind: "check", checkId: "" };
  return null;
}

export function serverTaskInfoOf(
  v: Reader<ServerTaskView>,
  commands: ServerCommandRow[],
): ServerTaskInfo {
  const code = v.server.code ?? "";
  const visible = v.server.code !== null && v.server.name !== null;
  const state = taskState(v.fix, v.startBlock);
  const fix = v.fix ? fixInfoOf(v.fix, commands) : null;
  const analysis = v.analysis ? analysisOf(v.analysis, code) : null;
  return {
    server:
      visible && !v.server.gone
        ? { code: v.server.code!, name: v.server.name!, projectCode: v.server.projectCode }
        : null,
    serverGone: v.server.gone,
    ...(v.server.gone && v.server.code ? { goneCode: v.server.code } : {}),
    episode: v.episode
      ? {
          id: "",
          serverCode: code,
          severity: v.episode.severity === "__unknown__" ? "trouble" : v.episode.severity,
          reasons: v.episode.reasons.flatMap((r) => reasonOf(r) ?? []),
          startedAt: v.episode.startedAt,
          recoveredAt: v.episode.recoveredAt,
          analysisId: null,
        }
      : null,
    state,
    startBlock: startBlockOf(v.startBlock),
    fix,
    fixConversationId: fix?.sessionId ?? null,
    // La salute del server la dice la sua pagina; qui non arriva.
    health: null,
    analysis: analysis
      ? { outcome: analysis.outcome, proposal: null, conversationId: analysis.sessionId }
      : null,
    checkNames: {},
    stateAt:
      state === "plan_rejected"
        ? (fix?.rejection?.at ?? null)
        : state === "fixing"
          ? (fix?.approval?.at ?? null)
          : null,
    stop:
      state === "stopped"
        ? {
            byId: null,
            reason:
              fix?.planError === "operations_off"
                ? "operations_off"
                : fix?.planError === "server_not_in_project"
                  ? "server_gone"
                  : null,
            outcome: fix?.status === "failed" ? "failed" : "stopped",
          }
        : null,
  };
}

export function createRealServerTask(api: ServerTaskApi) {
  return {
    /** La sezione Server di una task; `null` per una task non nata da un server (404). */
    async getServerTaskInfo(taskId: string): Promise<ServerTaskInfo | null> {
      let view: Reader<ServerTaskView>;
      try {
        view = await api.taskServer(taskId);
      } catch (error) {
        if (error instanceof ApiError && error.status === 404) return null;
        throw error;
      }
      // Il registro: chi non ha servers.operate nel progetto riceve 403 → niente righe.
      const commands = view.fix
        ? await api.fixCommands(taskId).then(
            (r) => r.commands.map(commandRowOf),
            () => [],
          )
        : [];
      return serverTaskInfoOf(view, commands);
    },

    /** «Start fix»: chiede un piano (la sessione di Claude lo propone). Le note non le prende il server. */
    async startServerFix(taskId: string): Promise<Conversation> {
      const fix = await inPrototypeWords(() => api.requestPlan(taskId));
      return { id: fix.sessionId ?? "" } as Conversation;
    },

    async approveServerFix(taskId: string, planDigest: string): Promise<void> {
      await inPrototypeWords(() => api.approve(taskId, planDigest));
    },

    async rejectServerFix(taskId: string, note: string): Promise<void> {
      await inPrototypeWords(() => api.reject(taskId, note));
    },

    async stopServerFix(taskId: string): Promise<void> {
      await inPrototypeWords(() => api.stop(taskId));
    },
  };
}

export const liveServerTask = createRealServerTask({
  taskServer: (id) => appClient().serverOps.taskServer(id),
  fixCommands: (id) => appClient().serverOps.fixCommands(id),
  requestPlan: (id) => appClient().serverOps.requestPlan(id),
  approve: (id, digest) => appClient().serverOps.approve(id, digest),
  reject: (id, note) => appClient().serverOps.reject(id, note),
  stop: (id) => appClient().serverOps.stop(id),
});
