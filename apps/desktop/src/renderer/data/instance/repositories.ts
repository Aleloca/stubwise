import { recordChange } from "../changelog/index";
// Per effetto: registra `repository.linked` e `repository.deleted` (P5).
import "../projectSettings/changeTypes";
import { openProject } from "../projectSettings/reads";
import {
  MANAGE_REPOS,
  addDocSpace,
  nameTaken,
  notConfiguredWebhook,
  repositoryObject,
} from "../projectSettings/repositories";
import type { ProjectResult } from "../projectSettings/types";
import { gate, isFullAdmin, knownDeletedProject, state, visibleProjectIds } from "../store";
import { can, viewerFor } from "../viewer";
import { forbidden, writer } from "../writer";
import { canI, reauthRefusal, refuse } from "./common";
import type { GitAccount } from "./state";

// I repository di tutta l'istanza (area 9b, Task 7): Amministrazione →
// Repositories, un elenco del catalogo senza azioni — per cambiarne uno si
// apre nelle impostazioni del suo progetto (`href`). Lo legge chi ha
// `repos.manage` in almeno un progetto (la voce di `adminSections`), e
// elenca i progetti dove chi guarda ha `repos.view`: gli altri non
// compaiono, nemmeno contati (R-G5, shape «Repositories»). Il nome
// dell'account git è un fatto dell'istanza: lo vede chi vede il repository.

export interface InstanceRepositoryRow {
  id: string;
  name: string;
  /** `owner/repo`, se la piattaforma lo dà. */
  fullName: string | null;
  /** Il nome dell'account git d'istanza che ci lavora; `null` se non ne ha. */
  gitAccountName: string | null;
  /** Dove si cambia: le impostazioni dei repository del progetto. */
  href: string;
}

export interface InstanceRepositoryGroup {
  projectId: string;
  projectCode: string;
  projectName: string;
  repositories: InstanceRepositoryRow[];
}

/**
 * I repository dei progetti dove `me` ha `repos.view`, un gruppo per progetto
 * (alfabetico per nome, i repository per nome); un progetto senza repository
 * non compare. `forbidden` senza `repos.manage` in almeno un progetto.
 */
export async function listAllRepositories(): Promise<InstanceRepositoryGroup[]> {
  const me = await gate("instance.listAllRepositories");
  const viewer = viewerFor(me);
  if (!can(viewer, "repos.manage")) throw forbidden();
  const visible = visibleProjectIds(me);
  return state.projects
    .filter((p) => visible.has(p.id) && can(viewer, "repos.view", p.id))
    .map((p) => ({
      projectId: p.id,
      projectCode: p.code,
      projectName: p.name,
      repositories: state.repositories
        .filter((r) => r.projectId === p.id)
        .map((r) => ({
          id: r.id,
          name: r.name,
          fullName: r.fullName ?? null,
          gitAccountName:
            state.instance.gitAccounts.find((g) => g.id === r.gitAccountId)?.name ?? null,
          href: `#/p/${p.code}/settings/repositories`,
        }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    }))
    .filter((g) => g.repositories.length > 0)
    .sort((a, b) => a.projectName.localeCompare(b.projectName));
}

// --- i repository rimasti senza progetto (area 9c, Task 5) -------------------
//
// Dopo il Delete di un progetto i suoi repository restano senza progetto
// (`state.detachedRepositories`; maintainer, 31 ott 2026, domanda 2 (b)):
// il gruppo «Not in any project» di questa pagina. Li legge chi vede la
// voce (`repos.manage` in almeno un progetto) e il full admin. Da quale
// progetto vengono lo dice `formerProject`, solo a chi ne era membro o è
// full admin (R-G5): per gli altri quel progetto non c'è, in nessun campo.
// Collegarli: `repos.manage` nel progetto di destinazione (il full admin
// ovunque), senza riconferma (non tocca segreti). Eliminarli: solo il full
// admin, con la riconferma (+R; maintainer, domanda 4 (b)).

export interface DetachedRepositoryRow {
  id: string;
  name: string;
  fullName: string | null;
  gitAccountName: string | null;
  /** La piattaforma dell'account git («The repository on GitHub isn't touched»); `null` senza account. */
  gitAccountProvider: GitAccount["provider"] | null;
  detachedAt: string;
  /** Da quale progetto eliminato viene: solo a chi ne era membro e al full admin, altrimenti null (R-G5). */
  formerProject: { code: string; name: string } | null;
  /** Dove chi guarda può collegarlo: progetti visibili, non archiviati, con `repos.manage` (tutti per il full admin). */
  linkTargets: { projectId: string; code: string; name: string }[];
  /** Solo il full admin (confermata dal maintainer il 31 ott 2026, domanda 4 (b)). */
  canDelete: boolean;
}

const detachedById = (id: string) => state.detachedRepositories.find((d) => d.repository.id === id);

/**
 * Il nome completo per chi guarda (ruling T11): intero a chi sa da quale
 * progetto viene, altrimenti solo l'ultimo segmento, perché il workspace
 * può nominare il cliente (R-G5).
 */
function fullNameFor(fullName: string | undefined, knows: boolean): string | null {
  if (!fullName) return null;
  return knows ? fullName : (fullName.split("/").at(-1) ?? null);
}

/**
 * I repository senza progetto, per nome. `forbidden` a chi non ha
 * `repos.manage` in nessun progetto e non è full admin.
 */
export async function listDetachedRepositories(): Promise<DetachedRepositoryRow[]> {
  const me = await gate("instance.listDetachedRepositories");
  const viewer = viewerFor(me);
  if (!can(viewer, MANAGE_REPOS) && !isFullAdmin(me)) throw forbidden();
  const visible = visibleProjectIds(me);
  const linkTargets = state.projects
    .filter((p) => visible.has(p.id) && can(viewer, MANAGE_REPOS, p.id))
    .map((p) => ({ projectId: p.id, code: p.code, name: p.name }))
    .sort((a, b) => a.code.localeCompare(b.code));
  return state.detachedRepositories
    .map(({ repository: r, formerProjectId, detachedAt }) => {
      const formerProject = knownDeletedProject(me, formerProjectId);
      return {
        id: r.id,
        name: r.name,
        fullName: fullNameFor(r.fullName, formerProject !== null),
        gitAccountName:
          state.instance.gitAccounts.find((g) => g.id === r.gitAccountId)?.name ?? null,
        gitAccountProvider:
          state.instance.gitAccounts.find((g) => g.id === r.gitAccountId)?.provider ?? null,
        detachedAt,
        formerProject,
        linkTargets: linkTargets.map((t) => ({ ...t })),
        canDelete: isFullAdmin(me),
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Collega un repository senza progetto a un progetto attivo: torna fra i
 * repository col progetto nuovo, il webhook da configurare, nessun file
 * d'ambiente, e uno spazio dei Docs senza pagine. La voce
 * `repository.linked` sta nel progetto di destinazione e non nomina quello
 * eliminato. `not_found` anche se un altro collegamento l'ha appena preso.
 */
export async function linkRepository(
  repositoryId: string,
  projectId: string,
): Promise<ProjectResult> {
  const me = await writer("instance.linkRepository");
  const detached = detachedById(repositoryId);
  const project = openProject(me, projectId);
  if (!detached || !project) return refuse.notFound();
  if (!canI(me, MANAGE_REPOS, project.id)) return refuse.forbidden();
  if (nameTaken(project.id, detached.repository.name, null)) return refuse.invalid("name_taken");

  state.detachedRepositories = state.detachedRepositories.filter((d) => d !== detached);
  const repository = {
    ...detached.repository,
    projectId: project.id,
    webhook: notConfiguredWebhook(),
  };
  state.repositories.push(repository);
  addDocSpace(repository);
  recordChange({
    kind: "repository.linked",
    actorId: me,
    projectId: project.id,
    object: repositoryObject(repository),
  });
  return { ok: true };
}

/**
 * Elimina un repository senza progetto (+R, solo il full admin). L'account
 * git non lo conta più. La voce d'istanza `repository.deleted` tiene il
 * nome com'è e `formerProjectId`, risolto a lettura (R-G5).
 */
export async function deleteDetachedRepository(repositoryId: string): Promise<ProjectResult> {
  const me = await writer("instance.deleteDetachedRepository");
  const detached = detachedById(repositoryId);
  if (!detached) return refuse.notFound();
  if (!isFullAdmin(me)) return refuse.forbidden();
  const blocked = reauthRefusal(me, "instance.deleteDetachedRepository");
  if (blocked) return blocked;

  state.detachedRepositories = state.detachedRepositories.filter((d) => d !== detached);
  recordChange({
    kind: "repository.deleted",
    actorId: me,
    projectId: null,
    object: repositoryObject(detached.repository),
    params: { formerProjectId: detached.formerProjectId },
  });
  return { ok: true };
}
