import type { ApprovalWho } from "../../domain/automations/preview";
import { stepAt } from "../../domain/automations/fields";
import { PEOPLE } from "../seed/people";
import { state, visibleProjectIds } from "../store";
import type { Automation, AutomationFlow, AutomationRun, Step } from "../types";
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
  return can(viewerFor(me), "automations.manage");
}

export function canManageAutomation(me: string, a: Automation): boolean {
  if (a.projectId !== null) {
    return (
      visibleProjectIds(me).has(a.projectId) &&
      can(viewerFor(me), "automations.manage", a.projectId)
    );
  }
  return can(viewerFor(me), "automations.manage");
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

/** I membri di un progetto con un ruolo, in ordine alfabetico. */
export function holdersOfRole(projectId: string, role: string): string[] {
  const project = state.projectsById.get(projectId);
  if (!project) return [];
  return project.memberIds
    .filter((id) => !PEOPLE.find((p) => p.id === id)?.isClaude)
    .filter((id) => projectRoleOf(id, projectId) === role)
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
  return ids.filter((id) => projectId === null || visibleProjectIds(id).has(projectId));
}

/** Il progetto in cui decide chi approva il passo in attesa di un'esecuzione. */
export function pendingProjectOf(run: AutomationRun, a: Automation): string | null {
  return approvalProjectOf(run.pending?.preview ?? {}, a);
}

/** Il progetto di un passo da approvare, dalla sua anteprima: quello risolto, o quello dell'automazione. */
export function approvalProjectOf(preview: Record<string, unknown>, a: Automation): string | null {
  return typeof preview.progetto === "string" ? preview.progetto : a.projectId;
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
    can(viewer, "automations.manage") ||
    state.projects.some(
      (p) => visibleProjectIds(me).has(p.id) && can(viewer, "automations.manage", p.id),
    )
  );
}
