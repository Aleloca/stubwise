import type { EngineState } from "../../domain/automations/engine";
import { now, state, visibleProjectIds } from "../store";
import type { AutomationRun } from "../types";
import { forbidden, invalid, notFound, writer } from "../writer";
import {
  enqueue,
  isOpen,
  note,
  publishedVersion,
  runNow,
  startRun,
  sweepApprovals,
} from "./runner";
import { putClientLink } from "./sourceWrites";
import { canManageIntegrations, decidersOf, stepOfRun } from "./visibility";
import { managedAutomation, managedRun, personName, visibleRun } from "./writeGuards";

// Le scritture sulle esecuzioni: avviarle a mano, decidere (approva,
// rifiuta, scegli il progetto), annullare, riprovare, saltare, far passare
// il tempo. Regole comuni in `writes.ts`.

// --- avvii ------------------------------------------------------------------------

/**
 * «Avvia ora» (chi gestisce l'automazione): un'esecuzione con l'evento dato;
 * per l'inizio «a mano», di base la data dell'avvio.
 */
export async function startManual(id: string, event?: Record<string, unknown>): Promise<string> {
  const me = await writer("automations.startManual");
  const a = managedAutomation(me, id);
  if (a.status !== "active") throw invalid("not_active");
  const trigger = publishedVersion(a)!.flow.trigger;
  const data =
    event ?? (trigger.kind === "manual" ? { avvio: { data: now().slice(0, 10) } } : null);
  if (!data || typeof data !== "object") throw invalid("event");
  const run = startRun(a, data, { origin: "manual" });
  if (!run) throw invalid("run_limit");
  return run.id;
}

// --- decisioni sulle esecuzioni ------------------------------------------------------

/** Le correzioni ammesse prima di approvare, per tipo di passo: solo testi dell'anteprima. */
const EDITABLE: Partial<Record<string, string[]>> = {
  createTask: ["titolo", "descrizione"],
  createMilestone: ["nome"],
  createRequest: ["titolo", "descrizione"],
  sendEmail: ["to", "subject", "body"],
  notify: ["testo"],
};

/** Le correzioni di un'approvazione, per il tipo del passo: `invalid: edited` se non ammesse (anche nella prova). */
export function checkEdited(kind: string | undefined, edited: Record<string, string>): void {
  const allowed = EDITABLE[kind ?? ""] ?? [];
  for (const [k, v] of Object.entries(edited)) {
    if (!allowed.includes(k) || typeof v !== "string") throw invalid("edited");
  }
}

/**
 * Chi decide su un'esecuzione ferma: deve vederla, e deve essere fra chi
 * decide ADESSO (R-J8). `expectedPath` è il passo su cui chi decide ha
 * cliccato (la decisione può partire 5 s dopo, con l'«Undo»): se nel
 * frattempo l'esecuzione è passata a un altro passo — un altro ha deciso —
 * la decisione non cade su quello nuovo.
 */
function decision(
  me: string,
  id: string,
  status: AutomationRun["status"],
  expectedPath?: string,
): AutomationRun {
  sweepApprovals();
  const run = visibleRun(me, id);
  if (run.status === "suspended") throw invalid("suspended");
  if (run.status !== status) throw invalid("not_waiting");
  if (expectedPath !== undefined && run.cursor !== expectedPath) throw invalid("not_waiting");
  if (!decidersOf(run).includes(me)) throw forbidden();
  return run;
}

/**
 * «Approva» (con le correzioni, per un'email da sistemare): solo chi è
 * indicato nel passo e vede il progetto, risolto adesso. Il passo
 * approvato è quello in attesa (`path` = il cursore): il motore lo
 * ricontrolla.
 */
export async function approve(
  runId: string,
  edited?: Record<string, string>,
  opts: { expectedPath?: string } = {},
): Promise<void> {
  const me = await writer("automations.approve");
  const run = decision(me, runId, "waiting_approval", opts.expectedPath);
  if (edited) checkEdited(stepOfRun(run)?.kind, edited);
  void enqueue(run.id, {
    kind: "approved",
    path: run.cursor!,
    byId: me,
    ...(edited ? { edited: { ...edited } } : {}),
  });
}

/** «Rifiuta»: l'esecuzione si ferma, annullata (R-J7). */
export async function reject(runId: string, opts: { expectedPath?: string } = {}): Promise<void> {
  const me = await writer("automations.reject");
  const run = decision(me, runId, "waiting_approval", opts.expectedPath);
  void enqueue(run.id, { kind: "rejected", path: run.cursor!, byId: me });
}

/** «Scegli il progetto» (il proprietario): fra quelli che vede. */
/**
 * «Scegli il progetto» (il proprietario): fra quelli che vede. Con
 * `remember` (shape [A 26], solo con `integrations.manage`) la scelta entra
 * nella tabella cliente → progetto, a nome di chi sceglie.
 */
export async function chooseProject(
  runId: string,
  projectId: string,
  opts: { remember?: boolean; expectedPath?: string } = {},
): Promise<void> {
  const me = await writer("automations.chooseProject");
  const run = decision(me, runId, "waiting_project", opts.expectedPath);
  if (!state.projectsById.has(projectId) || !visibleProjectIds(me).has(projectId)) throw notFound();
  if (opts.remember) {
    if (!canManageIntegrations(me)) throw forbidden();
    const preview = run.pending?.preview ?? {};
    const clientKey = String(preview.clientKey ?? "")
      .trim()
      .toLowerCase();
    const clientName = String(preview.clientName ?? "").trim();
    if (!clientKey || !clientName) throw invalid("client");
    putClientLink(me, { clientKey, clientName, projectId });
  }
  void enqueue(run.id, { kind: "project_chosen", projectId, byId: me });
}

// --- annulla, riprova, salta, il tempo -------------------------------------------------

/** «Annulla» un'esecuzione non finita (chi gestisce l'automazione). */
export async function cancelRun(runId: string): Promise<void> {
  const me = await writer("automations.cancelRun");
  const { run } = managedRun(me, runId);
  if (!isOpen(run)) throw invalid("finished");
  note(run, {
    outcome: "cancelled",
    byId: me,
    reason: `Esecuzione annullata da ${personName(me)}.`,
  });
  run.status = "cancelled";
  run.error = "cancelled";
  run.endedAt = runNow(run);
  run.pending = null;
  run.waitingUntil = null;
  delete run.suspendedFrom;
}

/**
 * Rimette in corsa una fallita, dal passo al cursore o (`skip`) da quello
 * dopo. Con l'automazione in pausa il runner la sospende prima del primo
 * effetto: riparte riaccendendola.
 */
function restart(run: AutomationRun, me: string, reason: string, skip: boolean) {
  note(run, { outcome: skip ? "skipped" : "retried", byId: me, reason });
  run.error = null;
  run.endedAt = null;
  run.status = "running";
  void enqueue(run.id, { kind: "time", now: runNow(run) }, skip ? skipTop : undefined);
}

/** Il passo al cursore è saltato: si riparte da quello dopo. */
function skipTop(st: EngineState): void {
  const top = st.stack.at(-1);
  if (top?.t === "list") top.i += 1;
}

/** «Riprova» il passo fallito. */
export async function retryStep(runId: string): Promise<void> {
  const me = await writer("automations.retryStep");
  const { run } = managedRun(me, runId);
  if (run.status !== "failed" || run.cursor === null) throw invalid("not_failed");
  restart(run, me, `Riprova chiesta da ${personName(me)}.`, false);
}

/** «Salta» il passo fallito: l'esecuzione prosegue da quello dopo. */
export async function skipStep(runId: string): Promise<void> {
  const me = await writer("automations.skipStep");
  const { run } = managedRun(me, runId);
  if (run.status !== "failed" || run.cursor === null) throw invalid("not_failed");
  restart(run, me, `Passo saltato da ${personName(me)}.`, true);
}

/**
 * «Fai passare il tempo» (solo prototipo): l'«adesso» dell'esecuzione va
 * avanti di `days` giorni e le attese scadute si chiudono. Non scavalca
 * nulla: un'approvazione o un progetto da scegliere aspettano ancora.
 */
export async function advanceTime(runId: string, days: number, hours = 0): Promise<void> {
  const me = await writer("automations.advanceTime");
  const { run } = managedRun(me, runId);
  if (!Number.isInteger(days) || !Number.isInteger(hours) || days < 0 || hours < 0 || hours > 23)
    throw invalid("days");
  const ms = days * 86_400_000 + hours * 3_600_000;
  if (ms < 3_600_000 || ms > 30 * 86_400_000) throw invalid("days");
  if (!isOpen(run)) throw invalid("finished");
  const at = new Date(Date.parse(runNow(run)) + ms).toISOString().replace(".000Z", "Z");
  state.automationClock.set(run.id, at);
  if (run.status !== "suspended") void enqueue(run.id, { kind: "time", now: at });
}
