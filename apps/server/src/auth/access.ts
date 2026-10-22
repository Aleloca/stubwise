/**
 * Nucleo dell'accesso sul server (appartenenza ai progetti, ruoli e permessi —
 * design `docs/plans/2026-10-22-permessi-progetto-design.md`).
 *
 * Il server è l'unica autorità: i permessi si RISOLVONO qui (ruolo d'istanza
 * dell'utente + ruolo di progetto della sua appartenenza) e ogni rotta li
 * DICHIARA in `config.access`, letta da UN hook globale (`accessPreHandler`,
 * registrato in `app.ts`). Una rotta non decide più da sé con un `preHandler`
 * scritto a mano: dichiara cosa serve, e la regola su come si verifica sta in
 * un posto solo.
 *
 * Transizione: una rotta SENZA `config.access` non è toccata dall'hook e
 * continua a usare i suoi `preHandler: requireAuth/requireAdmin`. Il test
 * `route-access.test.ts` tiene l'elenco di queste rotte, e l'elenco può solo
 * scendere.
 */
import { and, eq } from "drizzle-orm";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { Db } from "@stubwise/db";
import { projectMembers, projects, roles } from "@stubwise/db";
import {
  effectiveProjectPermissions,
  INSTANCE_PERMISSIONS,
  type InstancePermission,
  type ProjectPermission,
} from "@stubwise/shared";
import { apiError } from "../errors.js";
import { requireAuth, type SessionUser } from "./session.js";

/**
 * Risolve il progetto a cui appartiene la risorsa di una richiesta (dai
 * parametri del path). `null` = la risorsa non esiste: l'hook risponde 404,
 * esattamente come per un progetto invisibile. Implementazioni in
 * `project-resolvers.ts`.
 */
export type ProjectResolver = (req: FastifyRequest, db: Db) => Promise<string | null>;

/**
 * Cosa serve per entrare in una rotta, dichiarato in `config.access`.
 *
 * - `public`: nessuna autenticazione.
 * - `user`: basta essere autenticati.
 * - `instance`: un permesso d'istanza.
 * - `project`: un permesso sul progetto della risorsa (`"member"` = basta
 *   vedere il progetto, cioè esserne membri o full admin).
 */
export type RouteAccess =
  | { kind: "public" }
  | { kind: "user" }
  | { kind: "instance"; permission: InstancePermission }
  | { kind: "project"; permission: ProjectPermission | "member"; project: ProjectResolver };

/** Il progetto della richiesta e i permessi di chi la fa, risolti una volta. */
export interface RequestProjectAccess {
  projectId: string;
  permissions: ReadonlySet<ProjectPermission>;
}

declare module "fastify" {
  interface FastifyContextConfig {
    /** Accesso richiesto dalla rotta, applicato dall'hook globale. */
    access?: RouteAccess;
  }
  interface FastifyRequest {
    /** Impostato dall'hook globale sulle rotte `project`. */
    access?: RequestProjectAccess;
  }
}

/**
 * Permessi effettivi di `user` sul progetto, in UNA query (progetto +
 * appartenenza + ruolo). `null` = invisibile: progetto inesistente, oppure
 * utente non membro e non full admin. Un full admin li ha tutti, membro o no.
 */
export async function projectPermissionsFor(
  db: Db,
  user: SessionUser,
  projectId: string,
): Promise<ReadonlySet<ProjectPermission> | null> {
  const [row] = await db
    .select({ memberRolePermissions: roles.permissions })
    .from(projects)
    .leftJoin(
      projectMembers,
      and(eq(projectMembers.projectId, projects.id), eq(projectMembers.userId, user.id)),
    )
    .leftJoin(roles, eq(roles.id, projectMembers.roleId))
    .where(eq(projects.id, projectId));
  if (!row) return null;
  return effectiveProjectPermissions(new Set(user.instancePermissions), row.memberRolePermissions);
}

const INSTANCE_PERMISSION_SET: ReadonlySet<string> = new Set(INSTANCE_PERMISSIONS);

function isInstancePermission(
  permission: InstancePermission | ProjectPermission,
): permission is InstancePermission {
  return INSTANCE_PERMISSION_SET.has(permission);
}

/**
 * `user` ha `permission`? Un permesso d'istanza si legge dal SessionUser; uno
 * di progetto vuole il `projectId` (senza → `false`: un permesso di progetto
 * non vale «su un progetto qualsiasi»).
 */
export async function can(
  db: Db,
  user: SessionUser,
  permission: InstancePermission | ProjectPermission,
  projectId?: string,
): Promise<boolean> {
  if (isInstancePermission(permission)) return user.instancePermissions.has(permission);
  if (!projectId) return false;
  const permissions = await projectPermissionsFor(db, user, projectId);
  return permissions?.has(permission) ?? false;
}

/**
 * I progetti che `user` vede: `"all"` per un full admin (che vede anche i
 * progetti creati dopo, senza esserne membro), altrimenti quelli di cui è
 * membro. Da usare come filtro degli elenchi.
 */
export async function visibleProjectIds(db: Db, user: SessionUser): Promise<"all" | string[]> {
  if (user.instancePermissions.has("instance.full_admin")) return "all";
  const rows = await db
    .select({ projectId: projectMembers.projectId })
    .from(projectMembers)
    .where(eq(projectMembers.userId, user.id));
  return rows.map((r) => r.projectId);
}

/**
 * Hook `preHandler` globale: applica `config.access` della rotta. Le rotte
 * senza dichiarazione passano intatte (transizione, vedi il docblock del
 * modulo). L'autenticazione è quella di `requireAuth` (PAT, poi cookie).
 *
 * Un progetto che non si vede risponde 404 come uno che non esiste: un non
 * membro non deve poter scoprire che un ticket c'è. Il 403 è solo per chi il
 * progetto lo vede ma non ha il permesso.
 */
export async function accessPreHandler(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const access = request.routeOptions.config.access;
  if (!access || access.kind === "public") return;

  await requireAuth(request, reply);
  if (reply.sent) return;
  const user = request.user!;

  if (access.kind === "user") return;

  if (access.kind === "instance") {
    if (!user.instancePermissions.has(access.permission)) {
      await apiError(reply, 403, "forbidden", "Missing permission");
    }
    return;
  }

  const db = request.server.db;
  const projectId = await access.project(request, db);
  const permissions = projectId ? await projectPermissionsFor(db, user, projectId) : null;
  if (!projectId || !permissions) {
    await apiError(reply, 404, "not_found", "Not found");
    return;
  }
  if (access.permission !== "member" && !permissions.has(access.permission)) {
    await apiError(reply, 403, "forbidden", "Missing permission");
    return;
  }
  request.access = { projectId, permissions };
}
