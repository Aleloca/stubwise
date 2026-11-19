import { randomBytes } from "node:crypto";
import { deletedProjectMembers, deletedProjects, gitAccounts, projects, repositories, type Db } from "@stubwise/db";
import type { DetachedRepository } from "@stubwise/shared";
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { projectIdsWithPermission, projectPermissionsFor, scopeProjectIds } from "../auth/access.js";
import type { SessionUser } from "../auth/session.js";
import { recordChange } from "./change-log.js";
import { repositoryObject } from "./settings-entries.js";

/**
 * Area 9, F6 (D-8): i repository STACCATI (il loro progetto è stato
 * eliminato, 0193). Li vede solo l'Amministrazione, cioè chi ha `repos.manage`
 * in almeno un progetto aperto o è full admin (il prototipo,
 * `data/instance/repositories.ts`):
 * - collegarli a un progetto: `repos.manage` nel progetto di DESTINAZIONE
 *   (L-4 = a), senza riconferma (non tocca segreti in lettura);
 * - eliminarli: solo il full admin, con la riconferma.
 * Il nome intero e la provenienza solo a chi conosceva il progetto di prima.
 */

type Viewer = Pick<SessionUser, "id" | "email" | "instancePermissions">;

export class DetachedRepositoryError extends Error {
  constructor(
    readonly status: 403 | 404 | 409,
    readonly code: "forbidden" | "not_found" | "not_detached" | "name_taken",
    message: string,
  ) {
    super(message);
  }
}

const isFullAdmin = (viewer: Viewer) => viewer.instancePermissions.has("instance.full_admin");

/** `owner/nome` dall'URL del repository (senza host né `.git`); `null` se non si ricava. */
function fullNameOf(repoUrl: string): string | null {
  const path = repoUrl.replace(/^[a-z]+:\/\/[^/]+\//i, "").replace(/^git@[^:]+:/i, "").replace(/\.git$/i, "").replace(/\/+$/, "");
  return path.length > 0 ? path : null;
}

/** I progetti aperti dove chi guarda può collegare: `repos.manage` lì (tutti per un full admin). */
async function linkTargetsOf(db: Db, viewer: Viewer): Promise<{ projectId: string; code: string; name: string }[]> {
  const ids = await scopeProjectIds(db, await projectIdsWithPermission(db, viewer, "repos.manage"));
  if (ids.length === 0) return [];
  return (
    await db.select({ projectId: projects.id, code: projects.code, name: projects.name }).from(projects).where(and(inArray(projects.id, ids), isNull(projects.archivedAt))).orderBy(asc(projects.code))
  ).map((p) => ({ ...p }));
}

/** I progetti eliminati che chi guarda conosceva (ne era membro, o è full admin). */
async function knownDeleted(db: Db, viewer: Viewer, ids: string[]): Promise<Map<string, { code: string; name: string }>> {
  if (ids.length === 0) return new Map();
  const memory = await db.select().from(deletedProjects).where(inArray(deletedProjects.id, ids));
  const mine = isFullAdmin(viewer)
    ? new Set(memory.map((m) => m.id))
    : new Set((await db.select({ id: deletedProjectMembers.projectId }).from(deletedProjectMembers).where(and(inArray(deletedProjectMembers.projectId, ids), eq(deletedProjectMembers.userId, viewer.id)))).map((r) => r.id));
  return new Map(memory.filter((m) => mine.has(m.id)).map((m) => [m.id, { code: m.code, name: m.name }]));
}

export async function listDetachedRepositories(db: Db, viewer: Viewer): Promise<DetachedRepository[]> {
  const linkTargets = await linkTargetsOf(db, viewer);
  if (linkTargets.length === 0 && !isFullAdmin(viewer)) throw new DetachedRepositoryError(403, "forbidden", "You need repos.manage in a project");
  const rows = await db
    .select({ r: repositories, accountName: gitAccounts.name, accountProvider: gitAccounts.provider })
    .from(repositories)
    .leftJoin(gitAccounts, eq(gitAccounts.id, repositories.gitAccountId))
    .where(isNull(repositories.projectId))
    .orderBy(asc(repositories.name));
  const known = await knownDeleted(db, viewer, [...new Set(rows.map((x) => x.r.detachedFromProjectId).filter((id): id is string => id !== null))]);
  return rows.map(({ r, accountName, accountProvider }) => {
    const formerProject = r.detachedFromProjectId ? (known.get(r.detachedFromProjectId) ?? null) : null;
    const full = fullNameOf(r.repoUrl);
    return {
      id: r.id,
      name: r.name,
      fullName: full === null ? null : formerProject ? full : (full.split("/").at(-1) ?? null),
      repoUrl: formerProject ? r.repoUrl : null,
      provider: r.provider,
      gitAccountName: accountName ?? null,
      gitAccountProvider: accountProvider ?? null,
      detachedAt: r.detachedAt?.toISOString() ?? null,
      formerProject,
      canDelete: isFullAdmin(viewer),
      linkTargets: linkTargets.map((t) => ({ ...t })),
    };
  });
}

/**
 * Collega uno staccato a un progetto aperto (`repos.manage` lì). Torna fra i
 * repository del progetto col webhook da configurare: il segreto si rigenera,
 * così il webhook di prima non entra più. La voce `repository.linked` sta nel
 * progetto di destinazione e non nomina quello eliminato.
 */
export async function linkRepository(db: Db, viewer: Viewer, repositoryId: string, projectId: string): Promise<void> {
  const perms = await projectPermissionsFor(db, viewer, projectId);
  if (!perms) throw new DetachedRepositoryError(404, "not_found", "Project not found");
  if (!perms.has("repos.manage")) throw new DetachedRepositoryError(403, "forbidden", "You need repos.manage in the destination project");
  await db.transaction(async (tx) => {
    const [r] = await tx.select().from(repositories).where(eq(repositories.id, repositoryId)).for("update");
    if (!r) throw new DetachedRepositoryError(404, "not_found", "Repository not found");
    if (r.projectId !== null) throw new DetachedRepositoryError(409, "not_detached", "The repository already belongs to a project");
    const [taken] = await tx.select({ id: repositories.id }).from(repositories).where(and(eq(repositories.projectId, projectId), eq(repositories.name, r.name)));
    if (taken) throw new DetachedRepositoryError(409, "name_taken", "A repository with this name is already in the project");
    await tx
      .update(repositories)
      .set({ projectId, detachedAt: null, detachedFromProjectId: null, webhookConfiguredAt: null, webhookSecret: randomBytes(16).toString("hex") })
      .where(eq(repositories.id, repositoryId));
    await recordChange(tx, { type: "repository.linked", actor: viewer, projectId, data: { object: repositoryObject(r) } });
  });
}

/**
 * Elimina uno staccato: solo un full admin (la riconferma la dichiara la
 * rotta). La voce d'istanza `repository.deleted` tiene il nome e
 * `formerProjectId`, che la lettura risolve (e non fa mai uscire).
 */
export async function deleteDetachedRepository(db: Db, viewer: Viewer, repositoryId: string): Promise<void> {
  if (!isFullAdmin(viewer)) throw new DetachedRepositoryError(403, "forbidden", "Only a full admin can delete a repository");
  await db.transaction(async (tx) => {
    const [r] = await tx.select().from(repositories).where(eq(repositories.id, repositoryId)).for("update");
    if (!r) throw new DetachedRepositoryError(404, "not_found", "Repository not found");
    if (r.projectId !== null) throw new DetachedRepositoryError(409, "not_detached", "Only a repository without a project can be deleted");
    await tx.delete(repositories).where(eq(repositories.id, repositoryId));
    await recordChange(tx, {
      type: "repository.deleted",
      actor: viewer,
      projectId: null,
      data: { object: repositoryObject(r), ...(r.detachedFromProjectId ? { params: { formerProjectId: r.detachedFromProjectId } } : {}) },
    });
  });
}
