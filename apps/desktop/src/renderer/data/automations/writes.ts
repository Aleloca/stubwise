import { visitSteps } from "../../domain/automations/fields";
import { projectOf } from "../../domain/automations/preview";
import { copy, now, state, visibleProjectIds } from "../store";
import type { Automation, AutomationFlow, AutomationMeta } from "../types";
import { can, viewerFor } from "../viewer";
import { forbidden, invalid, notFound, writer } from "../writer";
import { configErrorsOf } from "./reads";
import { aiWaitingOf, hasQueued, publishedVersion, resume, suspend } from "./runner";
import { templateFlow, type AutomationTemplateKind } from "./templates";
import { keepHiddenProjects } from "./visibility";
import { managedAutomation } from "./writeGuards";

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
//
// Le scritture sulle esecuzioni stanno in `runWrites.ts`, quelle delle
// sorgenti e della tabella cliente → progetto in `sourceWrites.ts`, i
// controlli comuni in `writeGuards.ts`.

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
  /** La lingua dei testi del modello (di base l'italiano del seme). */
  language?: string;
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
        flow: copy(
          input.flow ??
            (input.template ? templateFlow(input.template, input.language) : emptyFlow(name)),
        ),
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
  const next = copy(flow);
  // Il flusso si legge senza i progetti che non vedo (R-G5): salvarlo non li perde.
  keepHiddenProjects(me, last.flow, next);
  if (isDraft) Object.assign(last, { flow: next }, saved);
  else
    a.versions.push({
      n: last.n + 1,
      flow: next,
      publishedAt: null,
      publishedById: null,
      ...saved,
    });
  if (meta.name !== undefined) a.name = meta.name.trim();
  if (meta.description !== undefined) a.description = meta.description.trim();
  return copy(a);
}

/**
 * Nome e descrizione (il costruttore, «Rename and describe»): sono
 * dell'automazione, non di una versione, quindi non creano mai una bozza —
 * nemmeno su un'attiva senza bozza, dove ne nascerebbe una identica alla
 * pubblicata.
 */
export async function renameAutomation(id: string, meta: AutomationMeta): Promise<Automation> {
  const me = await writer("automations.renameAutomation");
  const a = managedAutomation(me, id);
  if (meta.name !== undefined && !meta.name.trim()) throw invalid("name");
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
    } else if (run.status === "running" && aiWaitingOf(run.id)) {
      // Ferma al confine di un passo per un blocco d'istanza (area 9b): nessun
      // effetto in volo, si sospende adesso ed esce dalla fila.
      suspend(run, "running");
    }
  }
  return copy(a);
}

/**
 * Elimina la bozza: tutta l'automazione se non è mai stata accesa, altrimenti
 * la versione in bozza. `expected` (il costruttore, shape builder [A 12]):
 * come per `saveDraft`, se la bozza è cambiata da un'altra persona dopo
 * averla letta non si butta niente (`invalid: stale`).
 */
export async function deleteDraft(
  id: string,
  opts: { expected?: number | null } = {},
): Promise<void> {
  const me = await writer("automations.deleteDraft");
  const a = managedAutomation(me, id);
  const last = a.versions.at(-1)!;
  if (last.publishedAt !== null) throw invalid("no_draft");
  if (opts.expected !== undefined && (last.rev ?? null) !== opts.expected && last.savedById !== me)
    throw invalid("stale");
  if (a.versions.length === 1) state.automations = state.automations.filter((x) => x !== a);
  else a.versions.pop();
}
