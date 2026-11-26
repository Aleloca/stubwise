import { approvalProjectOf } from "../../domain/automations/runRules";
export { approvalProjectOf };
import type { ApprovalWho } from "@stubwise/shared";
import { stepAt, visitSteps } from "@stubwise/shared";
import { PEOPLE } from "../seed/people";
import { isHiddenId, personMasker } from "../access/hidden";
import { knownPeopleFor } from "../access/whoCan";
import { invalid } from "../writer";
import { copy, state, visibleProjectIds } from "../store";
import type { Automation, AutomationFlow, AutomationRun, ProjectTarget, Step } from "../types";
import { can, projectRoleOf, viewerFor } from "../viewer";

// Chi vede e chi gestisce un'automazione — l'unica regola, per letture e
// scritture (area 7). Le automazioni di un progetto le vedono i membri e le
// gestisce chi ha `automations.manage` nel progetto; le generali le vede e
// le gestisce chi ha `automations.manage` d'istanza. Le esecuzioni seguono
// la loro automazione; in più chi deve decidere su un'esecuzione ferma (chi
// approva, il proprietario che sceglie il progetto) la vede finché decide.
// Nascosto e inesistente rispondono uguale (R-G5).

export const automationById = (id: string): Automation | undefined =>
  state.automations.find((a) => a.id === id);

export const runById = (id: string): AutomationRun | undefined =>
  state.automationRuns.find((r) => r.id === id);

export function canSeeAutomation(me: string, a: Automation): boolean {
  if (a.projectId !== null) return visibleProjectIds(me).has(a.projectId);
  return can(viewerFor(me), "automations.general.manage");
}

export function canManageAutomation(me: string, a: Automation): boolean {
  if (a.projectId !== null) {
    return (
      visibleProjectIds(me).has(a.projectId) &&
      can(viewerFor(me), "automations.manage", a.projectId)
    );
  }
  return can(viewerFor(me), "automations.general.manage");
}

/** Il codice di un'esecuzione: «AUD-A1 #2». */
export function runCode(run: AutomationRun): string {
  return `${automationById(run.automationId)?.code ?? "?"} #${run.n}`;
}

/** Il flusso con cui gira un'esecuzione: quello della versione con cui è partita. */
export function flowOf(run: AutomationRun): AutomationFlow | null {
  return automationById(run.automationId)?.versions.find((v) => v.n === run.version)?.flow ?? null;
}

/** Il passo al cursore di un'esecuzione. */
export function stepOfRun(run: AutomationRun): Step | null {
  const flow = flowOf(run);
  return flow && run.cursor !== null ? stepAt(flow.steps, run.cursor) : null;
}

const byName = (a: string, b: string) =>
  (PEOPLE.find((p) => p.id === a)?.name ?? a).localeCompare(
    PEOPLE.find((p) => p.id === b)?.name ?? b,
  );

// Una persona disattivata (area 9a) non riceve task né approva: resta fra i
// membri del progetto, ma le automazioni non la scelgono. La regola è UNA,
// in `access/effective.ts`.
import { isDeactivated } from "../access/index";
export { isDeactivated };

/** I membri ATTIVI di un progetto con un ruolo, in ordine alfabetico. */
export function holdersOfRole(projectId: string, role: string): string[] {
  const project = state.projectsById.get(projectId);
  if (!project) return [];
  return project.memberIds
    .filter((id) => !PEOPLE.find((p) => p.id === id)?.isClaude && !isDeactivated(id))
    .filter((id) => projectRoleOf(id, projectId) === role)
    .sort(byName);
}

/**
 * Chi riceve «Avvisa» un reparto (area 10b): i membri ATTIVI del reparto
 * (dagli accessi, la fonte vera) che vedono il progetto del passo, in
 * ordine alfabetico; `projectId` null (una generale senza progetto): tutti.
 * Chi non lo vede non è avvisato e non si conta (R-G5).
 */
export function departmentRecipients(departmentId: string, projectId: string | null): string[] {
  const members = state.access.departments.find((d) => d.departmentId === departmentId);
  return (members?.memberIds ?? [])
    .filter((id) => {
      const person = PEOPLE.find((p) => p.id === id);
      return !!person && !person.isClaude && !isDeactivated(id);
    })
    .filter((id) => projectId === null || visibleProjectIds(id).has(projectId))
    .sort(byName);
}

/**
 * Chi può approvare adesso, per `who` nel progetto del passo (R-J8): la
 * persona indicata, chi ha il ruolo nel progetto o il proprietario di
 * ADESSO — e solo chi vede il progetto. `projectId` null (un passo senza
 * progetto di un'automazione generale): nessun controllo sul progetto.
 */
export function approversFor(a: Automation, who: ApprovalWho, projectId: string | null): string[] {
  let ids: string[];
  if ("owner" in who) ids = a.ownerId ? [a.ownerId] : [];
  else if ("personId" in who) ids = who.personId ? [who.personId] : [];
  else ids = projectId ? holdersOfRole(projectId, who.projectRole) : [];
  // Un disattivato non approva, chiunque l'abbia indicato (persona, ruolo, proprietario).
  return ids.filter(
    (id) => !isDeactivated(id) && (projectId === null || visibleProjectIds(id).has(projectId)),
  );
}

/** Il progetto in cui decide chi approva il passo in attesa di un'esecuzione. */
export function pendingProjectOf(run: AutomationRun, a: Automation): string | null {
  return approvalProjectOf(run.pending?.preview ?? {}, a);
}

/**
 * Chi decide adesso su un'esecuzione ferma: per un'approvazione chi può
 * approvare il passo (risolto ora, non quando si è fermata: un proprietario
 * nuovo o un approvatore uscito dal progetto contano subito), per «scegli il
 * progetto» il proprietario. Una sospesa (pausa) non aspetta nessuno.
 */
export function decidersOf(run: AutomationRun): string[] {
  const a = automationById(run.automationId);
  if (!a) return [];
  if (run.status === "waiting_project") return a.ownerId ? [a.ownerId] : [];
  if (run.status !== "waiting_approval") return [];
  const step = stepOfRun(run);
  if (!step || !("approval" in step) || step.approval.mode !== "ask") return [];
  return approversFor(a, step.approval.who, pendingProjectOf(run, a));
}

export function canSeeRun(me: string, run: AutomationRun): boolean {
  const a = automationById(run.automationId);
  if (!a) return false;
  return canSeeAutomation(me, a) || decidersOf(run).includes(me);
}

export function canManageRun(me: string, run: AutomationRun): boolean {
  const a = automationById(run.automationId);
  return !!a && canManageAutomation(me, a);
}

/** Chi gestisce sorgenti e tabella cliente → progetto. */
export const canManageIntegrations = (me: string): boolean =>
  can(viewerFor(me), "integrations.manage");

/** Chi vede le sorgenti: chi le gestisce, o chi gestisce automazioni (il costruttore le usa). */
export function canSeeSources(me: string): boolean {
  const viewer = viewerFor(me);
  return (
    canManageIntegrations(me) ||
    can(viewer, "automations.general.manage") ||
    state.projects.some(
      (p) => visibleProjectIds(me).has(p.id) && can(viewer, "automations.manage", p.id),
    )
  );
}

// --- R-G5 dentro un flusso -------------------------------------------------------

type FixedStep = Step & { project: Extract<ProjectTarget, { mode: "fixed" }> };

function fixedSteps(flow: AutomationFlow): FixedStep[] {
  const out: FixedStep[] = [];
  visitSteps(flow.steps, (s) => {
    const p = (s as { project?: { mode: string } }).project;
    if (p?.mode === "fixed") out.push(s as FixedStep);
  });
  return out;
}

type StartStep = Extract<Step, { kind: "startAutomation" }>;

function startSteps(flow: AutomationFlow): StartStep[] {
  const out: StartStep[] = [];
  visitSteps(flow.steps, (s) => {
    if (s.kind === "startAutomation") out.push(s);
  });
  return out;
}

/** `me` vede l'automazione `id` (un id vuoto o inesistente non è «nascosto»). */
const seesAutomation = (me: string, id: string) => {
  const a = automationById(id);
  return !a || canSeeAutomation(me, a);
};

/**
 * Un flusso come lo legge `me`: un progetto fisso che non vede (archiviato,
 * eliminato o di altri) resta senza id (`""`), come nel registro (R-J12), e
 * col segno `unavailable` che il costruttore dice «A project that's no
 * longer available» (area 9c, [PX 5]); così l'automazione che un passo
 * avvia, se non la vede (R-G5). Un passo mai scelto (`""` senza segno)
 * resta com'è.
 */
export function flowFor(
  me: string,
  flow: AutomationFlow,
  // R.1414 (revisione del lotto 2-3): il masker della risposta.
  mask: ReturnType<typeof personMasker> = personMasker(me),
): AutomationFlow {
  const out = copy(flow);
  // Le persone dei passi (incaricato, chi avvisare, chi approva): segnaposti
  // per chi chi guarda non conosce.
  visitSteps(out.steps, (s) => {
    for (const slot of Object.values(personSlots(s)))
      if (typeof slot?.personId === "string") slot.personId = mask(slot.personId);
  });
  const visible = visibleProjectIds(me);
  for (const s of fixedSteps(out)) {
    if (visible.has(s.project.projectId)) continue;
    if (s.project.projectId === "" && !s.project.unavailable) continue;
    s.project = { mode: "fixed", projectId: "", unavailable: true };
  }
  for (const s of startSteps(out)) if (!seesAutomation(me, s.automationId)) s.automationId = "";
  return out;
}

/**
 * Il rovescio per chi salva un flusso letto con `flowFor`: un passo che
 * aveva un progetto fisso (o un'automazione da avviare) che `me` non vede,
 * e che torna senza id, lo riprende dalla versione di prima (per id del
 * passo).
 */
type Slot = Record<string, unknown> | undefined;

/** I posti di un passo che possono nominare una persona: incaricato, chi avvisare, chi approva. */
function personSlots(step: Step): Record<"assignee" | "who" | "approver", Slot> {
  const s = step as {
    assignee?: unknown;
    who?: unknown;
    approval?: { mode: string; who?: unknown };
  };
  const obj = (v: unknown): Slot =>
    v && typeof v === "object" ? (v as Record<string, unknown>) : undefined;
  return {
    assignee: obj(s.assignee),
    who: obj(s.who),
    approver: s.approval?.mode === "ask" ? obj(s.approval.who) : undefined,
  };
}

/**
 * Il rovescio di `flowFor` per le persone (r.1414, revisione del lotto 2-3):
 * un segnaposto non si salva (`invalid: flow`); un posto che torna vuoto (la
 * persona omessa, `{}`) riprende quella della versione di prima, per id del
 * passo, se chi salva non la conosce (revisione M-7). Lo stesso contratto
 * del server (72).
 */
export function keepHiddenPeople(me: string, prev: AutomationFlow, next: AutomationFlow): void {
  // Revisione M-7, come il server: la persona di prima torna solo se chi salva
  // non la conosce; una che conosce, svuotata apposta, resta svuotata.
  const known = knownPeopleFor(me);
  const before = new Map<string, ReturnType<typeof personSlots>>();
  visitSteps(prev.steps, (s) => before.set(s.id, personSlots(s)));
  visitSteps(next.steps, (s) => {
    const slots = personSlots(s);
    for (const [name, slot] of Object.entries(slots) as [keyof typeof slots, Slot][]) {
      if (!slot) continue;
      if (isHiddenId(slot.personId as string | undefined)) throw invalid("flow");
      const old = before.get(s.id)?.[name];
      if (
        Object.keys(slot).length === 0 &&
        old &&
        typeof old.personId === "string" &&
        !known.has(old.personId)
      )
        slot.personId = old.personId;
    }
  });
}

export function keepHiddenProjects(me: string, prev: AutomationFlow, next: AutomationFlow): void {
  const visible = visibleProjectIds(me);
  const before = new Map(fixedSteps(prev).map((s) => [s.id, s.project.projectId]));
  for (const s of fixedSteps(next)) {
    const old = before.get(s.id);
    if (s.project.projectId === "" && old && !visible.has(old)) s.project.projectId = old;
    // Il segno di `flowFor` è della lettura: nello stato resta solo senza id
    // (il progetto eliminato, `purge.ts`).
    if (s.project.projectId !== "") delete s.project.unavailable;
  }
  const targets = new Map(startSteps(prev).map((s) => [s.id, s.automationId]));
  for (const s of startSteps(next)) {
    const old = targets.get(s.id);
    if (s.automationId === "" && old && !seesAutomation(me, old)) s.automationId = old;
  }
}
