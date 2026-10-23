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
 * OGNI rotta dichiara `config.access`, anche quelle pubbliche (`public`, che
 * tengono la propria autenticazione: firma HMAC, chiave del server, token del
 * widget). Lo pretende `route-access.test.ts`, senza elenco di eccezioni, e
 * l'hook rifiuta comunque (500) una rotta senza dichiarazione.
 */
import { and, eq, inArray, sql, type AnyColumn, type SQL } from "drizzle-orm";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { Db } from "@stubwise/db";
import { projectMembers, projects, roles } from "@stubwise/db";
import {
  effectiveProjectPermissions,
  INSTANCE_PERMISSIONS,
  type InstancePermission,
  type ProjectPermission,
} from "@stubwise/shared";
import { projectPermissionsOfUser as notificationsProjectPermissionsOfUser } from "@stubwise/notifications";
import { apiError } from "../errors.js";
import { hasConfirmedTotp } from "./second-factor/totp.js";
import { requireAuth, type SessionStage, type SessionUser } from "./session.js";

/**
 * Risolve il progetto a cui appartiene la risorsa di una richiesta (dai
 * parametri del path). `null` = la risorsa non esiste: l'hook risponde 404,
 * esattamente come per un progetto invisibile. Implementazioni in
 * `project-resolvers.ts`.
 */
export type ProjectResolver = (req: FastifyRequest, db: Db) => Promise<string | null>;

/**
 * Visibilità della SINGOLA risorsa dentro un progetto visibile, quando non
 * basta essere membri: per esempio un ticket altrui per chi non ha
 * `tickets.view_all`. `false` → 404, esattamente come un progetto invisibile
 * (non si conferma che la risorsa esiste). Si valuta PRIMA del permesso della
 * rotta: chi non vede un ticket riceve 404 anche dove non avrebbe il permesso.
 * Implementazioni in `project-resolvers.ts`.
 */
export type ResourceGuard = (
  req: FastifyRequest,
  db: Db,
  user: SessionUser,
  permissions: ReadonlySet<ProjectPermission>,
) => Promise<boolean>;

/**
 * Cosa serve per entrare in una rotta, dichiarato in `config.access`.
 *
 * - `public`: nessuna autenticazione.
 * - `user`: basta essere autenticati.
 * - `instance`: un permesso d'istanza.
 * - `project`: un permesso sul progetto della risorsa (`"member"` = basta
 *   vedere il progetto, cioè esserne membri o full admin).
 * - `second_factor`: SOLO una sessione parziale (login a metà); con `stage`,
 *   solo quello stadio. Una sessione completa o un PAT ricevono 409
 *   `second_factor_done`, uno stadio sbagliato 409
 *   `second_factor_stage_mismatch`. Sono le uniche rotte che una sessione
 *   parziale raggiunge: l'elenco è chiuso in `route-access.test.ts`.
 */
export type RouteAccess =
  | { kind: "public" }
  | { kind: "user" }
  | { kind: "second_factor"; stage?: Exclude<SessionStage, "full"> }
  | { kind: "instance"; permission: InstancePermission }
  | {
      kind: "project";
      permission: ProjectPermission | "member";
      project: ProjectResolver;
      /** Visibilità della risorsa oltre a quella del progetto (vedi {@link ResourceGuard}). */
      resource?: ResourceGuard;
    };

/**
 * Riconferma recente, dichiarata in `config.reauth` accanto a `config.access`
 * (azioni sensibili: token, password, ruoli, identità collegate, 2FA).
 *
 * - `true`: serve una sessione (mai un PAT), un'app configurata e un secondo
 *   fattore usato negli ultimi {@link REAUTH_WINDOW_MS} (login o riconferma).
 * - `"setup_allowed"`: come `true`, ma chi un'app NON l'ha ancora (sessione
 *   di prima del rilascio) passa: sono le rotte con cui la configura.
 *
 * L'elenco delle rotte che la chiedono è chiuso in `route-access.test.ts`.
 */
export type RouteReauth = true | "setup_allowed";

/** Quanto vale un secondo fattore per le azioni sensibili: 10 minuti. */
export const REAUTH_WINDOW_MS = 10 * 60 * 1000;

/** Il progetto della richiesta e i permessi di chi la fa, risolti una volta. */
export interface RequestProjectAccess {
  projectId: string;
  permissions: ReadonlySet<ProjectPermission>;
}

declare module "fastify" {
  interface FastifyContextConfig {
    /** Accesso richiesto dalla rotta, applicato dall'hook globale. */
    access?: RouteAccess;
    /** Riconferma recente richiesta dalla rotta (vedi {@link RouteReauth}). */
    reauth?: RouteReauth;
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
  db: Pick<Db, "select">,
  user: Pick<SessionUser, "id" | "instancePermissions">,
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

/**
 * Come {@link projectPermissionsFor}, ma per un utente di cui si ha solo l'id
 * (chi agisce da Slack o dall'inbox con un attore senza sessione): legge anche
 * il ruolo d'istanza. `null` = utente inesistente o progetto invisibile. La
 * regola vive in `@stubwise/notifications` (`project-access.ts`), perché la
 * usa anche il worker: qui la si ri-esporta, non la si riscrive.
 */
export const projectPermissionsOfUser: (
  db: Db,
  userId: string,
  projectId: string,
) => Promise<ReadonlySet<ProjectPermission> | null> = notificationsProjectPermissionsOfUser;

/**
 * I progetti in cui `user` ha `permission`: `"all"` per un full admin,
 * altrimenti quelli in cui il ruolo della sua appartenenza lo contiene. Da
 * usare come filtro degli elenchi che dipendono da un permesso (es. i ticket
 * altrui con `tickets.view_all`).
 */
export async function projectIdsWithPermission(
  db: Db,
  user: Pick<SessionUser, "id" | "instancePermissions">,
  permission: ProjectPermission,
): Promise<"all" | string[]> {
  if (user.instancePermissions.has("instance.full_admin")) return "all";
  const rows = await db
    .select({ projectId: projectMembers.projectId })
    .from(projectMembers)
    .innerJoin(roles, eq(roles.id, projectMembers.roleId))
    .where(
      and(eq(projectMembers.userId, user.id), sql`${roles.permissions} @> array[${permission}]::text[]`),
    );
  return rows.map((r) => r.projectId);
}

/**
 * I permessi di chi chiede nel progetto della rotta, risolti dall'hook globale.
 * Si chiama solo da un handler di una rotta `config.access` di tipo `project`:
 * altrove `request.access` non c'è, ed è un errore di programmazione.
 */
export function routePermissions(request: {
  access?: RequestProjectAccess;
  routeOptions?: { url?: string };
}): ReadonlySet<ProjectPermission> {
  if (!request.access) {
    throw new Error(`request.access assente dopo config.access (${request.routeOptions?.url ?? "?"})`);
  }
  return request.access.permissions;
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
export async function visibleProjectIds(
  db: Db,
  user: Pick<SessionUser, "id" | "instancePermissions">,
): Promise<"all" | string[]> {
  if (user.instancePermissions.has("instance.full_admin")) return "all";
  const rows = await db
    .select({ projectId: projectMembers.projectId })
    .from(projectMembers)
    .where(eq(projectMembers.userId, user.id));
  return rows.map((r) => r.projectId);
}

/**
 * I permessi di progetto di `user` per OGNI progetto che vede (id → chiavi),
 * in una query: è ciò che `/api/auth/me` espone ai client, che li leggono
 * invece di dedurli dal ruolo. Un full admin li ha tutti su tutti i progetti.
 */
export async function projectPermissionsMap(
  db: Db,
  user: Pick<SessionUser, "id" | "instancePermissions">,
): Promise<Record<string, ProjectPermission[]>> {
  const instance = new Set(user.instancePermissions);
  const rows = instance.has("instance.full_admin")
    ? (await db.select({ projectId: projects.id }).from(projects)).map((r) => ({
        projectId: r.projectId,
        permissions: [] as string[],
      }))
    : await db
        .select({ projectId: projectMembers.projectId, permissions: roles.permissions })
        .from(projectMembers)
        .innerJoin(roles, eq(roles.id, projectMembers.roleId))
        .where(eq(projectMembers.userId, user.id));
  const map: Record<string, ProjectPermission[]> = {};
  for (const row of rows) {
    const effective = effectiveProjectPermissions(instance, row.permissions);
    if (effective) map[row.projectId] = [...effective];
  }
  return map;
}

/**
 * Il filtro di un elenco su un insieme di progetti, come condizione SQL da
 * mettere nella WHERE (mai a valle in JS su una pagina già tagliata):
 * `undefined` per `"all"` (nessun filtro), `false` per un insieme vuoto (non si
 * vede niente). `ids` è quello di {@link visibleProjectIds} o di
 * {@link projectIdsWithPermission}.
 */
export function inProjects(
  column: AnyColumn | SQL,
  ids: "all" | readonly string[],
): SQL | undefined {
  if (ids === "all") return undefined;
  if (ids.length === 0) return sql`false`;
  return inArray(sql`${column}`, [...ids]);
}

/**
 * Hook `preHandler` globale: applica `config.access` della rotta.
 * L'autenticazione è quella di `requireAuth` (PAT, poi cookie).
 *
 * Una rotta SENZA dichiarazione è chiusa (ruling R48): 500
 * `route_access_undeclared`, handler mai eseguito, e una riga d'errore nel log
 * che la nomina. `route-access.test.ts` le vieta già al build; questa è la
 * difesa se una sfugge (un plugin che registra rotte da sé). Fanno eccezione:
 * il metodo OPTIONS (il preflight CORS di `@fastify/cors`, che registra le sue
 * rotte senza config) e il 404 di Fastify (nessuna rotta trovata).
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
  if (!access) {
    if (request.method === "OPTIONS" || request.is404) return;
    request.log.error(
      { method: request.method, url: request.routeOptions.url },
      "rotta senza config.access: richiesta rifiutata",
    );
    await apiError(reply, 500, "route_access_undeclared", "Route access not declared");
    return;
  }
  if (access.kind === "public") return;

  await requireAuth(request, reply, { allowPartial: access.kind === "second_factor" });
  if (reply.sent) return;
  const user = request.user!;

  const reauth = request.routeOptions.config.reauth;
  if (reauth) {
    await applyReauth(request, reply, user, reauth);
    if (reply.sent) return;
  }

  switch (access.kind) {
    case "user":
      return;
    case "second_factor":
      // Un PAT non ha stadio: è già un accesso completo, come una sessione
      // `full`.
      if (user.sessionStage === undefined || user.sessionStage === "full") {
        await apiError(reply, 409, "second_factor_done", "Second factor already completed");
      } else if (access.stage && access.stage !== user.sessionStage) {
        await apiError(reply, 409, "second_factor_stage_mismatch", "Wrong login stage");
      }
      return;
    case "instance":
      if (!user.instancePermissions.has(access.permission)) {
        await apiError(reply, 403, "forbidden", "Missing permission");
      }
      return;
    case "project":
      await applyProjectAccess(request, reply, user, access);
      return;
    default: {
      // Una dichiarazione che il tipo non prevede (un `as` di troppo, una
      // config costruita a mano): chiusa, e col motivo nel log.
      const unknown: never = access;
      request.log.error({ access: unknown }, "config.access con kind sconosciuto");
      await apiError(reply, 500, "internal_error", "Unknown route access kind");
    }
  }
}

/**
 * Il controllo di `config.reauth`, prima del permesso della rotta.
 *
 * - Un PAT non riconferma mai (403 `session_required`): un token rubato non
 *   deve poter creare altri token o cambiare ruoli.
 * - Senza un'app configurata (sessione di prima del rilascio) non c'è un
 *   fattore con cui riconfermare: 403 `second_factor_setup_required`, e la
 *   web apre la configurazione (le rotte `"setup_allowed"`), che conta come
 *   riconferma.
 * - Secondo fattore mai usato in questa sessione, o più vecchio della
 *   finestra: 403 `reauth_required`.
 */
async function applyReauth(
  request: FastifyRequest,
  reply: FastifyReply,
  user: SessionUser,
  reauth: RouteReauth,
): Promise<void> {
  if (user.patId !== undefined || user.sessionId === undefined) {
    await apiError(reply, 403, "session_required", "This action requires a browser session");
    return;
  }
  if (!(await hasConfirmedTotp(request.server.db, user.id))) {
    if (reauth === "setup_allowed") return;
    await apiError(reply, 403, "second_factor_setup_required", "Second factor setup required");
    return;
  }
  const at = user.secondFactorAt;
  if (!at || Date.now() - at.getTime() > REAUTH_WINDOW_MS) {
    await apiError(reply, 403, "reauth_required", "Recent second factor confirmation required");
  }
}

async function applyProjectAccess(
  request: FastifyRequest,
  reply: FastifyReply,
  user: SessionUser,
  access: Extract<RouteAccess, { kind: "project" }>,
): Promise<void> {
  const db = request.server.db;
  const projectId = await access.project(request, db);
  const permissions = projectId ? await projectPermissionsFor(db, user, projectId) : null;
  if (!projectId || !permissions) {
    await apiError(reply, 404, "not_found", "Not found");
    return;
  }
  if (access.resource && !(await access.resource(request, db, user, permissions))) {
    await apiError(reply, 404, "not_found", "Not found");
    return;
  }
  if (access.permission !== "member" && !permissions.has(access.permission)) {
    await apiError(reply, 403, "forbidden", "Missing permission");
    return;
  }
  request.access = { projectId, permissions };
}
