import type { EngineState } from "../../domain/automations/engine";
import { visitSteps } from "../../domain/automations/fields";
import { projectOf } from "../../domain/automations/preview";
import { PEOPLE } from "../seed/people";
import { copy, now, state, visibleProjectIds } from "../store";
import type {
  Automation,
  AutomationFlow,
  AutomationMeta,
  AutomationRun,
  ClientProjectLink,
  DataField,
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
import { templateFlow, type AutomationTemplateKind } from "./templates";
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

/**
 * Una bozza nuova, mai accesa: di un progetto (`automations.manage` lì) o
 * generale (d'istanza). `template`: il flusso di uno dei due modelli, con le
 * scelte personali vuote (`templates.ts`).
 */
export async function createAutomation(input: {
  name: string;
  description?: string;
  projectId: string | null;
  flow?: AutomationFlow;
  template?: AutomationTemplateKind;
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
      {
        n: 1,
        flow: copy(input.flow ?? (input.template ? templateFlow(input.template) : emptyFlow(name))),
        publishedAt: null,
        publishedById: null,
        savedAt: now(),
        savedById: me,
        rev: ++state.counter,
      },
    ],
    createdAt: now(),
    createdById: me,
  };
  state.automations.push(automation);
  return copy(automation);
}

/**
 * «Duplicate» (anche il modo di riprendere una versione vecchia, shape
 * [A 11]): una bozza nuova, mai accesa, nello stesso progetto, col flusso
 * della versione indicata (di base l'ultima). Il nome lo scrive chi duplica.
 */
export async function duplicateAutomation(
  id: string,
  opts: { version?: number; name: string },
): Promise<Automation> {
  const me = await writer("automations.duplicateAutomation");
  const source = managedAutomation(me, id);
  const version =
    opts.version === undefined
      ? source.versions.at(-1)!
      : source.versions.find((v) => v.n === opts.version);
  if (!version) throw invalid("version");
  const name = opts.name.trim();
  if (!name) throw invalid("name");
  const key = source.projectId ?? "";
  const n = (state.automationCodeSeq.get(key) ?? 0) + 1;
  state.automationCodeSeq.set(key, n);
  const project = source.projectId ? state.projectsById.get(source.projectId) : null;
  const automation: Automation = {
    id: `aut-new-${++state.counter}`,
    code: project ? `${project.code}-A${n}` : `AUT-${n}`,
    name,
    description: source.description,
    projectId: source.projectId,
    ownerId: null,
    status: "draft",
    versions: [{ n: 1, flow: copy(version.flow), publishedAt: null, publishedById: null }],
    createdAt: now(),
    createdById: me,
  };
  state.automations.push(automation);
  return copy(automation);
}

/**
 * Salva la bozza: modificare un'automazione accesa crea la bozza della
 * versione successiva (quella pubblicata resta com'è, con le sue
 * esecuzioni); una bozza si sostituisce.
 *
 * `expected` (il costruttore, shape builder [A 12]): il `rev` della
 * bozza che chi salva ha letto (null = nessuna bozza). Se adesso la bozza è
 * un'altra — salvata da un'altra persona, o pubblicata nel frattempo —
 * niente fusione silenziosa: `invalid: stale`, e chi salva ricarica. I
 * salvataggi propri di fila non si fermano da soli.
 */
export async function saveDraft(
  id: string,
  flow: AutomationFlow,
  meta: AutomationMeta = {},
  opts: { expected?: number | null } = {},
): Promise<Automation> {
  const me = await writer("automations.saveDraft");
  const a = managedAutomation(me, id);
  if (meta.name !== undefined && !meta.name.trim()) throw invalid("name");
  const last = a.versions.at(-1)!;
  const isDraft = last.publishedAt === null;
  if (opts.expected !== undefined) {
    const current = isDraft ? (last.rev ?? null) : null;
    if (current !== opts.expected && !(isDraft && last.savedById === me)) throw invalid("stale");
  }
  const saved = { savedAt: now(), savedById: me, rev: ++state.counter };
  if (isDraft) Object.assign(last, { flow: copy(flow) }, saved);
  else
    a.versions.push({
      n: last.n + 1,
      flow: copy(flow),
      publishedAt: null,
      publishedById: null,
      ...saved,
    });
  if (meta.name !== undefined) a.name = meta.name.trim();
  if (meta.description !== undefined) a.description = meta.description.trim();
  return copy(a);
}

/** Pubblica la bozza (e accende una mai accesa): chi pubblica diventa il proprietario. */
/** Il permesso che serve per creare quello che un passo crea. */
const CREATE_PERMISSION = {
  createTask: "tickets.create",
  createMilestone: "tickets.edit",
  createRequest: "backlog.create",
} as const;

/**
 * I controlli di chi diventa proprietario (shape automations.md [A 12],
 * [A 13]), rifatti qui qualunque cosa mostri il dialogo:
 * - in un progetto fisso (o quello dell'automazione) deve poter creare ciò
 *   che il flusso crea (`invalid: permission`); un progetto ricavato dal
 *   cliente si saprà solo a runtime;
 * - se il flusso manda email, una sua casella collegata (`invalid:
 *   mailbox_missing`), non scaduta (`invalid: mailbox_expired`): quella
 *   indicata, o la prima.
 * Restituisce la casella scelta (null se non servono email).
 */
function ownerChecks(
  me: string,
  a: Automation,
  flow: AutomationFlow,
  mailbox?: string,
): string | null {
  const viewer = viewerFor(me);
  let emails = false;
  visitSteps(flow.steps, (step) => {
    if (step.kind === "sendEmail") emails = true;
    if (
      step.kind !== "createTask" &&
      step.kind !== "createMilestone" &&
      step.kind !== "createRequest"
    )
      return;
    const target = projectOf(step);
    const projectId =
      target?.mode === "fixed" ? target.projectId : target?.mode === "own" ? a.projectId : null;
    if (projectId === null) return;
    if (
      !visibleProjectIds(me).has(projectId) ||
      !can(viewer, CREATE_PERMISSION[step.kind], projectId)
    )
      throw invalid("permission");
  });
  if (!emails) return null;
  const boxes = state.mailboxes.filter((b) => b.personId === me);
  const chosen = mailbox === undefined ? boxes[0] : boxes.find((b) => b.email === mailbox);
  if (!chosen) throw invalid("mailbox_missing");
  if (state.googleAccounts.find((g) => g.personId === me)?.status === "expired")
    throw invalid("mailbox_expired");
  return chosen.email;
}

function publishAs(me: string, a: Automation, mailbox?: string): void {
  const draft = a.versions.at(-1)!;
  if (draft.publishedAt !== null) throw invalid("no_draft");
  if (configErrorsOf(a, draft.flow, me).length > 0) throw invalid("config");
  const box = ownerChecks(me, a, draft.flow, mailbox);
  draft.publishedAt = now();
  draft.publishedById = me;
  a.ownerId = me;
  a.mailbox = box;
  if (a.status === "draft") a.status = "active";
}

/**
 * «Pubblica»: la bozza diventa la versione con cui partono le esecuzioni
 * nuove (quelle in corso finiscono con la loro); chi pubblica diventa il
 * proprietario. Con errori di configurazione non si pubblica
 * (`invalid: config`).
 */
export async function publish(id: string, opts: { mailbox?: string } = {}): Promise<Automation> {
  const me = await writer("automations.publish");
  const a = managedAutomation(me, id);
  publishAs(me, a, opts.mailbox);
  return copy(a);
}

/**
 * «Accendi»: una bozza mai accesa si pubblica; una in pausa torna attiva e
 * le sue esecuzioni sospese riprendono. Chi accende diventa il proprietario.
 * La versione pubblicata deve essere senza errori (es. la sorgente è
 * scollegata → `invalid: config`).
 */
export async function activate(id: string, opts: { mailbox?: string } = {}): Promise<Automation> {
  const me = await writer("automations.activate");
  const a = managedAutomation(me, id);
  if (a.status === "active") return copy(a);
  if (a.status === "draft") {
    publishAs(me, a, opts.mailbox);
    return copy(a);
  }
  const live = publishedVersion(a);
  if (!live || configErrorsOf(a, live.flow, me).length > 0) throw invalid("config");
  a.mailbox = ownerChecks(me, a, live.flow, opts.mailbox);
  a.ownerId = me;
  a.status = "active";
  a.pausedById = null;
  a.pausedAt = null;
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
  a.pausedById = me;
  a.pausedAt = now();
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
/**
 * I dati di un evento mandato a mano («Edit and send» di un webhook):
 * un oggetto, coi campi dichiarati del tipo giusto. `invalid: event_types`
 * se un numero non è un numero (shape sources: «Received with errors» e non
 * parte nulla).
 */
const PAYLOAD_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PAYLOAD_DATE = /^\d{4}-\d{2}-\d{2}(T[\d:.]+(Z|[+-]\d{2}:?\d{2})?)?$/;

/** Un valore è del tipo del campo? Numeri, sì/no, date, email, elenchi (coi loro campi). */
function fitsType(f: DataField, v: unknown): boolean {
  switch (f.type) {
    case "number":
      return typeof v === "number" && Number.isFinite(v);
    case "boolean":
      return typeof v === "boolean";
    case "date":
      return typeof v === "string" && PAYLOAD_DATE.test(v) && !Number.isNaN(Date.parse(v));
    case "email":
      return typeof v === "string" && PAYLOAD_EMAIL.test(v);
    case "list":
      return (
        Array.isArray(v) &&
        (!f.of ||
          v.every((item) => !!item && typeof item === "object" && fieldsFit(f.of!, item as object)))
      );
    default:
      return true;
  }
}

/** I campi presenti in un oggetto hanno il loro tipo (gli assenti non si controllano). */
function fieldsFit(fields: DataField[], obj: object): boolean {
  return fields.every((f) => {
    const v = f.key
      .split(".")
      .reduce<unknown>(
        (o, k) => (o && typeof o === "object" ? (o as Record<string, unknown>)[k] : undefined),
        obj,
      );
    return v === undefined || v === null || fitsType(f, v);
  });
}

function checkPayload(source: { fields: DataField[] }, payload: unknown) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw invalid("event");
  if (!fieldsFit(source.fields, payload)) throw invalid("event_types");
  return payload as Record<string, unknown>;
}

export async function simulateSourceEvent(
  sourceId: string,
  sample: number | { payload: unknown },
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
  const event =
    typeof sample === "number" ? source.sampleEvents[sample] : checkPayload(source, sample.payload);
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

/** Le correzioni di un'approvazione, per il tipo del passo: `invalid: edited` se non ammesse (anche nella prova). */
export function checkEdited(kind: string | undefined, edited: Record<string, string>): void {
  const allowed = EDITABLE[kind ?? ""] ?? [];
  for (const [k, v] of Object.entries(edited)) {
    if (!allowed.includes(k) || typeof v !== "string") throw invalid("edited");
  }
}

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
  if (edited) checkEdited(stepOfRun(run)?.kind, edited);
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
/**
 * «Scegli il progetto» (il proprietario): fra quelli che vede. Con
 * `remember` (shape [A 26], solo con `integrations.manage`) la scelta entra
 * nella tabella cliente → progetto, a nome di chi sceglie.
 */
export async function chooseProject(
  runId: string,
  projectId: string,
  opts: { remember?: boolean } = {},
): Promise<void> {
  const me = await writer("automations.chooseProject");
  const run = decision(me, runId, "waiting_project");
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
  // Ricollegare (anche da un altro): ne diventa «chi l'ha collegata» (shape sources [A 5]).
  if (source.connectedAt) {
    source.reconnectedById = me;
    source.reconnectedAt = now();
  } else source.connectedAt = now();
  source.status = "connected";
  source.connectedById = me;
  source.expiredAt = null;
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
  putClientLink(me, { clientKey, clientName: link.clientName.trim(), projectId: link.projectId });
}

/** Scrive una riga cliente → progetto: una nuova porta chi e quando, una cambiata li conserva. */
function putClientLink(me: string, row: ClientProjectLink): void {
  const i = state.clientProjectLinks.findIndex((l) => l.clientKey === row.clientKey);
  if (i >= 0) {
    const old = state.clientProjectLinks[i]!;
    state.clientProjectLinks[i] = { ...row, addedById: old.addedById, addedAt: old.addedAt };
  } else state.clientProjectLinks.push({ ...row, addedById: me, addedAt: now() });
}

export async function removeClientLink(clientKey: string): Promise<void> {
  const me = await writer("automations.removeClientLink");
  if (!canManageIntegrations(me)) throw forbidden();
  const before = state.clientProjectLinks.length;
  state.clientProjectLinks = state.clientProjectLinks.filter((l) => l.clientKey !== clientKey);
  if (state.clientProjectLinks.length === before) throw notFound();
}
