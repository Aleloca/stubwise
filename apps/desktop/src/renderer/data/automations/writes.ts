import type { EngineState } from "../../domain/automations/engine";
import { PEOPLE } from "../seed/people";
import { copy, now, state, visibleProjectIds } from "../store";
import type {
  Automation,
  AutomationFlow,
  AutomationMeta,
  AutomationRun,
  ClientProjectLink,
} from "../types";
import { can, viewerFor } from "../viewer";
import { forbidden, invalid, notFound, writer } from "../writer";
import { configErrorsOf } from "./reads";
import {
  enqueue,
  hasQueued,
  isOpen,
  sweepApprovals,
  note,
  publishedVersion,
  resume,
  runNow,
  startRun,
  suspend,
} from "./runner";
import { dueSchedules } from "./sources";
import {
  automationById,
  canManageAutomation,
  canManageIntegrations,
  canSeeAutomation,
  canSeeRun,
  decidersOf,
  runById,
  stepOfRun,
} from "./visibility";

// Le scritture delle Automations (area 7). Come le altre: `writer()` prima
// di tutto (latenza, `failNext`, ripristino), ogni controllo prima di ogni
// scrittura. Un'automazione o un'esecuzione che chi agisce non vede è
// `not_found` (R-G5); una che vede ma non può toccare `forbidden`.
//
// - Accendere, riaccendere o pubblicare fa diventare proprietario chi lo fa:
//   da lì gli effetti girano coi suoi permessi e la sua casella.
// - Pausa: le esecuzioni in attesa si sospendono subito, quella con un
//   effetto in volo al confine del passo (runner). Riaccendendo riprendono
//   da dove erano.
// - Le esecuzioni partono e avanzano in coda: una scrittura che le avvia o
//   le sblocca torna subito; `whenAutomationsIdle` aspetta che si fermino.

const personName = (id: string) => PEOPLE.find((p) => p.id === id)?.name ?? id;

function visibleAutomation(me: string, id: string): Automation {
  const a = automationById(id);
  if (!a || !canSeeAutomation(me, a)) throw notFound();
  return a;
}

function managedAutomation(me: string, id: string): Automation {
  const a = visibleAutomation(me, id);
  if (!canManageAutomation(me, a)) throw forbidden();
  return a;
}

function visibleRun(me: string, id: string): AutomationRun {
  const run = runById(id);
  if (!run || !canSeeRun(me, run)) throw notFound();
  return run;
}

function managedRun(me: string, id: string): { run: AutomationRun; automation: Automation } {
  const run = visibleRun(me, id);
  const automation = automationById(run.automationId)!;
  if (!canManageAutomation(me, automation)) throw forbidden();
  return { run, automation };
}

const emptyFlow = (name: string): AutomationFlow => ({
  trigger: { kind: "manual" },
  steps: [],
  titleTemplate: name,
});

// --- automazioni ------------------------------------------------------------------

/** Una bozza nuova, mai accesa: di un progetto (`automations.manage` lì) o generale (d'istanza). */
export async function createAutomation(input: {
  name: string;
  description?: string;
  projectId: string | null;
  flow?: AutomationFlow;
}): Promise<Automation> {
  const me = await writer("automations.createAutomation");
  const name = input.name.trim();
  if (!name) throw invalid("name");
  const project = input.projectId === null ? null : state.projectsById.get(input.projectId);
  if (input.projectId !== null && (!project || !visibleProjectIds(me).has(project.id)))
    throw notFound();
  const allowed = project
    ? can(viewerFor(me), "automations.manage", project.id)
    : can(viewerFor(me), "automations.manage");
  if (!allowed) throw forbidden();
  const key = project?.id ?? "";
  const n = (state.automationCodeSeq.get(key) ?? 0) + 1;
  state.automationCodeSeq.set(key, n);
  const automation: Automation = {
    id: `aut-new-${++state.counter}`,
    code: project ? `${project.code}-A${n}` : `AUT-${n}`,
    name,
    description: input.description?.trim() ?? "",
    projectId: project?.id ?? null,
    ownerId: null,
    status: "draft",
    versions: [
      { n: 1, flow: copy(input.flow ?? emptyFlow(name)), publishedAt: null, publishedById: null },
    ],
    createdAt: now(),
  };
  state.automations.push(automation);
  return copy(automation);
}

/**
 * Salva la bozza: modificare un'automazione accesa crea la bozza della
 * versione successiva (quella pubblicata resta com'è, con le sue
 * esecuzioni); una bozza si sostituisce.
 */
export async function saveDraft(
  id: string,
  flow: AutomationFlow,
  meta: AutomationMeta = {},
): Promise<Automation> {
  const me = await writer("automations.saveDraft");
  const a = managedAutomation(me, id);
  if (meta.name !== undefined && !meta.name.trim()) throw invalid("name");
  const last = a.versions.at(-1)!;
  if (last.publishedAt === null) last.flow = copy(flow);
  else a.versions.push({ n: last.n + 1, flow: copy(flow), publishedAt: null, publishedById: null });
  if (meta.name !== undefined) a.name = meta.name.trim();
  if (meta.description !== undefined) a.description = meta.description.trim();
  return copy(a);
}

/** Pubblica la bozza (e accende una mai accesa): chi pubblica diventa il proprietario. */
function publishAs(me: string, a: Automation): void {
  const draft = a.versions.at(-1)!;
  if (draft.publishedAt !== null) throw invalid("no_draft");
  if (configErrorsOf(a, draft.flow, me).length > 0) throw invalid("config");
  draft.publishedAt = now();
  draft.publishedById = me;
  a.ownerId = me;
  if (a.status === "draft") a.status = "active";
}

/**
 * «Pubblica»: la bozza diventa la versione con cui partono le esecuzioni
 * nuove (quelle in corso finiscono con la loro); chi pubblica diventa il
 * proprietario. Con errori di configurazione non si pubblica
 * (`invalid: config`).
 */
export async function publish(id: string): Promise<Automation> {
  const me = await writer("automations.publish");
  const a = managedAutomation(me, id);
  publishAs(me, a);
  return copy(a);
}

/**
 * «Accendi»: una bozza mai accesa si pubblica; una in pausa torna attiva e
 * le sue esecuzioni sospese riprendono. Chi accende diventa il proprietario.
 * La versione pubblicata deve essere senza errori (es. la sorgente è
 * scollegata → `invalid: config`).
 */
export async function activate(id: string): Promise<Automation> {
  const me = await writer("automations.activate");
  const a = managedAutomation(me, id);
  if (a.status === "active") return copy(a);
  if (a.status === "draft") {
    publishAs(me, a);
    return copy(a);
  }
  const live = publishedVersion(a);
  if (!live || configErrorsOf(a, live.flow, me).length > 0) throw invalid("config");
  a.ownerId = me;
  a.status = "active";
  for (const run of state.automationRuns) {
    if (run.automationId === a.id && run.status === "suspended") resume(run, me);
  }
  return copy(a);
}

/**
 * «Metti in pausa»: nessun inizio nuovo; le esecuzioni ferme su
 * un'attesa si sospendono adesso, quella con un effetto in volo al passo
 * successivo. Gli eventi che arrivano in pausa non si recuperano.
 */
export async function pause(id: string): Promise<Automation> {
  const me = await writer("automations.pause");
  const a = managedAutomation(me, id);
  if (a.status !== "active") throw invalid("not_active");
  a.status = "paused";
  for (const run of state.automationRuns) {
    if (run.automationId !== a.id) continue;
    // Con un input già in coda (un'approvazione appena data) la decisione si
    // applica prima: il runner sospende al passo dopo.
    if (hasQueued(run.id)) continue;
    if (
      run.status === "waiting_approval" ||
      run.status === "waiting_event" ||
      run.status === "waiting_project"
    ) {
      suspend(run, run.status);
    }
  }
  return copy(a);
}

/** Elimina la bozza: tutta l'automazione se non è mai stata accesa, altrimenti la versione in bozza. */
export async function deleteDraft(id: string): Promise<void> {
  const me = await writer("automations.deleteDraft");
  const a = managedAutomation(me, id);
  const last = a.versions.at(-1)!;
  if (last.publishedAt !== null) throw invalid("no_draft");
  if (a.versions.length === 1) state.automations = state.automations.filter((x) => x !== a);
  else a.versions.pop();
}

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

/**
 * «Simula un evento» di una sorgente (solo prototipo): l'evento d'esempio
 * n. `sampleIndex` arriva e fa partire ogni automazione attiva con
 * quell'inizio. Lo fa chi gestisce le integrazioni o un'automazione con
 * quell'inizio; la sorgente deve essere collegata. Restituisce le
 * esecuzioni nate che chi agisce vede.
 */
export async function simulateSourceEvent(
  sourceId: string,
  sampleIndex: number,
): Promise<string[]> {
  const me = await writer("automations.simulateSourceEvent");
  const source = state.automationSources.find((s) => s.id === sourceId);
  const listeners = state.automations.filter((a) => {
    const t = publishedVersion(a)?.flow.trigger;
    return t?.kind === "source" && t.sourceId === sourceId;
  });
  if (!source) throw notFound();
  if (!canManageIntegrations(me) && !listeners.some((a) => canManageAutomation(me, a)))
    throw forbidden();
  if (source.status !== "connected") throw invalid("source_not_connected");
  const event = source.sampleEvents[sampleIndex];
  if (!event) throw invalid("sample");
  const started = listeners
    .filter((a) => a.status === "active")
    .map((a) => startRun(a, event, { origin: "source" }))
    .filter((r): r is AutomationRun => r !== null);
  return started.filter((r) => canSeeRun(me, r)).map((r) => r.id);
}

/** Le date e le ricorrenze che cadono adesso: partono le automazioni non ancora partite oggi. */
export async function runDueSchedules(): Promise<string[]> {
  const me = await writer("automations.runDueSchedules");
  const at = now();
  return dueSchedules(at)
    .map((a) => startRun(a, { avvio: { data: at.slice(0, 10) } }, { origin: "schedule" }))
    .filter((r): r is AutomationRun => r !== null)
    .filter((r) => canSeeRun(me, r))
    .map((r) => r.id);
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

/** Chi decide su un'esecuzione ferma: deve vederla, e deve essere fra chi decide ADESSO (R-J8). */
function decision(me: string, id: string, status: AutomationRun["status"]): AutomationRun {
  sweepApprovals();
  const run = visibleRun(me, id);
  if (run.status === "suspended") throw invalid("suspended");
  if (run.status !== status) throw invalid("not_waiting");
  if (!decidersOf(run).includes(me)) throw forbidden();
  return run;
}

/**
 * «Approva» (con le correzioni, per un'email da sistemare): solo chi è
 * indicato nel passo e vede il progetto, risolto adesso. Il passo
 * approvato è quello in attesa (`path` = il cursore): il motore lo
 * ricontrolla.
 */
export async function approve(runId: string, edited?: Record<string, string>): Promise<void> {
  const me = await writer("automations.approve");
  const run = decision(me, runId, "waiting_approval");
  if (edited) {
    const allowed = EDITABLE[stepOfRun(run)?.kind ?? ""] ?? [];
    for (const [k, v] of Object.entries(edited)) {
      if (!allowed.includes(k) || typeof v !== "string") throw invalid("edited");
    }
  }
  void enqueue(run.id, {
    kind: "approved",
    path: run.cursor!,
    byId: me,
    ...(edited ? { edited: { ...edited } } : {}),
  });
}

/** «Rifiuta»: l'esecuzione si ferma, annullata (R-J7). */
export async function reject(runId: string): Promise<void> {
  const me = await writer("automations.reject");
  const run = decision(me, runId, "waiting_approval");
  void enqueue(run.id, { kind: "rejected", path: run.cursor!, byId: me });
}

/** «Scegli il progetto» (il proprietario): fra quelli che vede. */
export async function chooseProject(runId: string, projectId: string): Promise<void> {
  const me = await writer("automations.chooseProject");
  const run = decision(me, runId, "waiting_project");
  if (!state.projectsById.has(projectId) || !visibleProjectIds(me).has(projectId)) throw notFound();
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
export async function advanceTime(runId: string, days: number): Promise<void> {
  const me = await writer("automations.advanceTime");
  const { run } = managedRun(me, runId);
  if (!Number.isInteger(days) || days < 1 || days > 30) throw invalid("days");
  if (!isOpen(run)) throw invalid("finished");
  const at = new Date(Date.parse(runNow(run)) + days * 86_400_000)
    .toISOString()
    .replace(".000Z", "Z");
  state.automationClock.set(run.id, at);
  if (run.status !== "suspended") void enqueue(run.id, { kind: "time", now: at });
}

// --- sorgenti e tabella cliente → progetto -------------------------------------------

function managedSource(me: string, id: string) {
  if (!canManageIntegrations(me)) throw forbidden();
  const source = state.automationSources.find((s) => s.id === id);
  if (!source) throw notFound();
  return source;
}

/** Collega (o ricollega) una sorgente: `integrations.manage`. */
export async function connectSource(id: string): Promise<void> {
  const me = await writer("automations.connectSource");
  const source = managedSource(me, id);
  source.status = "connected";
  source.connectedById = me;
}

/** Scollega una sorgente: le automazioni che ne partono lo dicono negli errori di configurazione. */
export async function disconnectSource(id: string): Promise<void> {
  const me = await writer("automations.disconnectSource");
  managedSource(me, id).status = "disconnected";
}

/** Aggiunge o cambia una riga cliente → progetto (verso un progetto che chi agisce vede). */
export async function setClientLink(link: ClientProjectLink): Promise<void> {
  const me = await writer("automations.setClientLink");
  if (!canManageIntegrations(me)) throw forbidden();
  const clientKey = link.clientKey.trim().toLowerCase();
  if (!clientKey || !link.clientName.trim()) throw invalid("client");
  if (!state.projectsById.has(link.projectId) || !visibleProjectIds(me).has(link.projectId))
    throw notFound();
  const row = { clientKey, clientName: link.clientName.trim(), projectId: link.projectId };
  const i = state.clientProjectLinks.findIndex((l) => l.clientKey === clientKey);
  if (i >= 0) state.clientProjectLinks[i] = row;
  else state.clientProjectLinks.push(row);
}

export async function removeClientLink(clientKey: string): Promise<void> {
  const me = await writer("automations.removeClientLink");
  if (!canManageIntegrations(me)) throw forbidden();
  const before = state.clientProjectLinks.length;
  state.clientProjectLinks = state.clientProjectLinks.filter((l) => l.clientKey !== clientKey);
  if (state.clientProjectLinks.length === before) throw notFound();
}
