import { isOpen, note, runNow } from "../automations/runner";
import { recordChange } from "../changelog/index";
import { dropHeld } from "../instance/queue";
import type { Project } from "../model";
import { statusOf } from "../releases/visibility";
import {
  archivedProjectIdsFor,
  canSeeConversation,
  gate,
  now,
  objectCodeOf,
  state,
  visibleProjectIds,
} from "../store";
import { projectRoleOf } from "../access/index";
import { CLAUDE_ID } from "../seed/people";
import { viewerFor } from "../viewer";
import { writer } from "../writer";
import { MANAGE_SETTINGS, canI, nameOf, projectObject, reauthRefusal, refuse } from "./common";
import { purgeProject } from "./purge";
import { settingsOf } from "./reads";
import type { ProjectSwitch } from "./state";
import type { BusyReason, ProjectRefusal, ProjectResult } from "./types";

// Archivia, riapri, elimina (area 9c, Task 5), livello dati.
//
// - Archive e Reopen: `project.settings.manage` nel progetto, senza
//   riconferma (si tornano indietro). Archiviare non tocca interruttori,
//   appartenenze, notifiche né fissati: tutto torna a lettura riaprendo.
//   Le esecuzioni aperte delle automazioni del progetto si annullano con la
//   nota «Project archived» (maintainer, 31 ott 2026, domanda 4 (a)) e non
//   rendono il progetto `busy`; lo rendono `busy` le sessioni di Claude non
//   finite (anche in attesa per la coda) e i rilasci in corso.
// - Un archiviato non è in `visibleProjectIds` di nessuno: lo leggono, in
//   sola lettura, i suoi ex membri e i full admin (`archivedProjectIdsFor`),
//   dalla scheda «Archived» e dalla sua pagina. Per gli altri è come un
//   progetto che non esiste (R-G5).
// - Delete: solo il full admin, solo su un archiviato, col codice scritto
//   esatto e la riconferma (+R). Cosa toglie lo dice `purge.ts`.
//
// Ordine dei controlli di `common.ts`: `not_found` → `forbidden` → l'input
// (`invalid`) → `busy` → `reauth_required` → la scrittura e la sua voce.

export type DeletionCountKey =
  | "tasks"
  | "requests"
  | "docPages"
  | "conversations"
  | "channels"
  | "driveFiles"
  | "automations"
  | "environments"
  | "envFiles"
  | "releases";
export type DeletionCounts = Record<DeletionCountKey, number>;

export interface ArchivedProjectRow {
  projectId: string;
  code: string;
  name: string;
  clientName: string | null;
  archivedAt: string;
  /** Il nome di chi l'ha archiviato. */
  archivedBy: string;
  canReopen: boolean;
  canDelete: boolean;
}

export interface ArchivedProjectView extends ArchivedProjectRow {
  description: string;
  /** I membri umani, col ruolo di progetto per nome; Claude non c'è. */
  members: { personId: string; name: string; role: string }[];
  counts: DeletionCounts;
  /** I nomi: a Delete restano senza progetto. */
  repositories: string[];
  /** Gli interruttori com'erano all'archiviazione: tornano così riaprendo. */
  switchesOnReopen: Record<ProjectSwitch, boolean>;
}

const isFullAdmin = (me: string): boolean =>
  viewerFor(me).instancePermissions.includes("instance.full_admin");

/** Un progetto che chi guarda vede, aperto o da archiviato; `undefined` altrimenti (R-G5). */
function seenProject(me: string, projectId: string): Project | undefined {
  const project = state.projectsById.get(projectId);
  if (!project) return undefined;
  const seen = project.archived
    ? archivedProjectIdsFor(me).has(project.id)
    : visibleProjectIds(me).has(project.id);
  return seen ? project : undefined;
}

/**
 * Perché il progetto non si archivia adesso: le sessioni di Claude del
 * progetto non finite (anche ferme per la coda in pausa: `waiting`) e i
 * rilasci in corso. Senza `viewerId` è la regola nuda (codici e titoli);
 * con `viewerId`, il titolo e il codice di una sessione che chi guarda non
 * vede sono `null` (P23).
 */
export function busyReasonsOf(projectId: string, viewerId?: string): BusyReason[] {
  const sessions = state.conversations
    .filter((c) => c.projectId === projectId && c.state !== "finished")
    .map((c): BusyReason => {
      const seen = viewerId === undefined || canSeeConversation(viewerId, c);
      return {
        kind: "claude_session",
        code: seen ? objectCodeOf(c) : null,
        title: seen ? c.title : null,
        waiting: !!c.waiting,
      };
    });
  const releases = state.releases
    .filter((r) => r.projectId === projectId && statusOf(r).kind === "running")
    .map((r): BusyReason => ({ kind: "release", code: r.code }));
  return [...sessions, ...releases];
}

/** Le esecuzioni aperte delle automazioni del progetto: quelle che archiviare annulla. */
const openRunsOf = (projectId: string) => {
  const own = new Set(state.automations.filter((a) => a.projectId === projectId).map((a) => a.id));
  return state.automationRuns.filter((r) => own.has(r.automationId) && isOpen(r));
};

/**
 * Cosa dice il dialogo prima di archiviare (ruling del controller, 31 ott
 * 2026, [AR 3]): le esecuzioni aperte che si annulleranno e le ragioni di
 * `busy`. `not_found` su un progetto invisibile o già archiviato.
 */
export async function getArchivePreview(
  projectId: string,
): Promise<ProjectResult<{ openAutomationRuns: number; busy: BusyReason[] }>> {
  const me = await gate("projectSettings.getArchivePreview");
  if (!visibleProjectIds(me).has(projectId)) return refuse.notFound();
  if (!canI(me, MANAGE_SETTINGS, projectId)) return refuse.forbidden();
  return {
    ok: true,
    openAutomationRuns: openRunsOf(projectId).length,
    busy: busyReasonsOf(projectId, me),
  };
}

/** Archivia: `busy` se Claude ci lavora o un rilascio è in corso; `already_archived` se lo è già. */
export async function archiveProject(projectId: string): Promise<ProjectResult> {
  const me = await writer("projectSettings.archiveProject");
  const project = seenProject(me, projectId);
  if (!project) return refuse.notFound();
  if (!canI(me, MANAGE_SETTINGS, project.id)) return refuse.forbidden();
  if (project.archived) return refuse.invalid("already_archived");
  const busy = busyReasonsOf(project.id, me);
  if (busy.length > 0) return refuse.busy(busy);

  for (const run of openRunsOf(project.id)) {
    note(run, {
      outcome: "cancelled",
      byId: me,
      reason: "Project archived",
      why: { code: "projectArchived" },
    });
    run.status = "cancelled";
    run.error = "project_archived";
    run.endedAt = runNow(run);
    run.pending = null;
    run.waitingUntil = null;
    delete run.suspendedFrom;
    dropHeld(run.id);
  }
  project.archived = { at: now(), byId: me };
  recordChange({
    kind: "project.archived",
    actorId: me,
    projectId: project.id,
    object: projectObject(project),
  });
  return { ok: true };
}

/**
 * Riapre un archiviato: torna com'era (interruttori, notifiche, fissati si
 * rileggono, nessuna riscrittura). Le automazioni ripartono dagli eventi
 * nuovi, senza recuperare ciò che è successo nel frattempo (scelta del
 * controller). `not_archived` se qualcuno l'ha già riaperto.
 */
export async function reopenProject(projectId: string): Promise<ProjectResult> {
  const me = await writer("projectSettings.reopenProject");
  const project = seenProject(me, projectId);
  if (!project) return refuse.notFound();
  if (!canI(me, MANAGE_SETTINGS, project.id)) return refuse.forbidden();
  if (!project.archived) return refuse.invalid("not_archived");
  project.archived = null;
  recordChange({
    kind: "project.reopened",
    actorId: me,
    projectId: project.id,
    object: projectObject(project),
  });
  return { ok: true };
}

function rowOf(me: string, p: Project): ArchivedProjectRow {
  return {
    projectId: p.id,
    code: p.code,
    name: p.name,
    clientName: p.clientName ?? null,
    archivedAt: p.archived!.at,
    archivedBy: nameOf(p.archived!.byId) ?? "",
    canReopen: canI(me, MANAGE_SETTINGS, p.id),
    canDelete: isFullAdmin(me),
  };
}

/** La scheda «Archived»: gli archiviati che chi guarda vede, dal più recente. */
export async function listArchivedProjects(): Promise<ArchivedProjectRow[]> {
  const me = await gate("projectSettings.listArchivedProjects");
  const mine = archivedProjectIdsFor(me);
  return state.projects
    .filter((p) => mine.has(p.id))
    .map((p) => rowOf(me, p))
    .sort((a, b) => b.archivedAt.localeCompare(a.archivedAt) || a.code.localeCompare(b.code));
}

/** Quante cose del progetto: la pagina dell'archiviato e l'anteprima di Delete. */
function countsOf(projectId: string): DeletionCounts {
  const of = <T extends { projectId: string | null }>(rows: T[]) =>
    rows.filter((r) => r.projectId === projectId).length;
  const repos = new Set(
    state.repositories.filter((r) => r.projectId === projectId).map((r) => r.id),
  );
  return {
    tasks: of(state.tasks),
    requests: of(state.requests),
    docPages: of(state.docPages),
    conversations: of(state.conversations),
    channels: of(state.channels),
    driveFiles: of(state.driveFiles),
    automations: of(state.automations),
    environments: of(state.environments),
    envFiles: state.envFiles.filter((f) => repos.has(f.repositoryId)).length,
    releases: of(state.releases),
  };
}

/**
 * La pagina dell'archiviato (`/archived/<CODE>`); `null` per chi non ne era
 * membro e non è full admin, come per un codice che non c'è (R-G5).
 */
export async function getArchivedProject(code: string): Promise<ArchivedProjectView | null> {
  const me = await gate("projectSettings.getArchivedProject");
  const mine = archivedProjectIdsFor(me);
  const project = state.projects.find((p) => p.code === code && mine.has(p.id));
  if (!project) return null;
  return {
    ...rowOf(me, project),
    description: project.description ?? "",
    members: project.memberIds
      .filter((id) => id !== CLAUDE_ID)
      .map((personId) => ({
        personId,
        name: nameOf(personId) ?? personId,
        role: projectRoleOf(personId, project.id)?.name ?? "",
      }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    counts: countsOf(project.id),
    repositories: state.repositories
      .filter((r) => r.projectId === project.id)
      .map((r) => r.name)
      .sort((a, b) => a.localeCompare(b)),
    switchesOnReopen: { ...settingsOf(project).switches },
  };
}

/** Il progetto da eliminare: visto, del full admin, archiviato (o il rifiuto). */
function deletable(
  me: string,
  projectId: string,
): { project: Project } | { refusal: ProjectRefusal } {
  const project = seenProject(me, projectId);
  if (!project) return { refusal: refuse.notFound() };
  if (!isFullAdmin(me)) return { refusal: refuse.forbidden() };
  if (!project.archived) return { refusal: refuse.invalid("not_archived") };
  return { project };
}

/** I server che resterebbero senza ambienti: li usano solo ambienti del progetto (R-L7). */
function orphanServersOf(projectId: string): string[] {
  const uses = (code: string, mine: boolean) =>
    state.environments.some(
      (e) => (e.projectId === projectId) === mine && e.servers.some((s) => s.serverCode === code),
    );
  return state.servers
    .filter((s) => uses(s.code, true) && !uses(s.code, false))
    .map((s) => s.code)
    .sort((a, b) => Number(a.slice(4)) - Number(b.slice(4)));
}

/**
 * Cosa toglie Delete, e cosa resta senza progetto: i server (R-L7) e i
 * repository (maintainer, 31 ott 2026). Solo il full admin, solo su un
 * archiviato.
 */
export async function getDeletionPreview(projectId: string): Promise<
  ProjectResult<{
    counts: DeletionCounts;
    /** Codici `SRV-`. */
    orphanServers: string[];
    /** Nomi. */
    detachedRepositories: string[];
  }>
> {
  const me = await gate("projectSettings.getDeletionPreview");
  const found = deletable(me, projectId);
  if ("refusal" in found) return found.refusal;
  const { project } = found;
  return {
    ok: true,
    counts: countsOf(project.id),
    orphanServers: orphanServersOf(project.id),
    detachedRepositories: state.repositories
      .filter((r) => r.projectId === project.id)
      .map((r) => r.name)
      .sort((a, b) => a.localeCompare(b)),
  };
}

/**
 * Elimina per sempre un archiviato (+R): il codice si confronta esatto
 * (`code_mismatch`, minuscole comprese). Lascia la voce d'istanza
 * `project.deleted` col numero dei repository rimasti senza progetto.
 */
export async function deleteProject(
  projectId: string,
  input: { confirmCode: string },
): Promise<ProjectResult> {
  const me = await writer("projectSettings.deleteProject");
  const found = deletable(me, projectId);
  if ("refusal" in found) return found.refusal;
  const { project } = found;
  if (input.confirmCode !== project.code) return refuse.invalid("code_mismatch");
  const blocked = reauthRefusal(me, "projectSettings.deleteProject");
  if (blocked) return blocked;

  const detached = purgeProject(project, me);
  recordChange({
    kind: "project.deleted",
    actorId: me,
    projectId: null,
    // L'etichetta resta vuota: codice e nome si risolvono a lettura, per chi può saperli (R-G5).
    object: { type: "project", id: project.id, label: "" },
    params: { detachedRepositories: String(detached) },
  });
  return { ok: true };
}
