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
import { CHAT_TOOL_READ_ROUTES, CHAT_TOOL_WRITE_ROUTES, isPrivateChatToolRead, isPrivateConversation } from "./chat-tool-routes.js";
import { and, eq, inArray, isNotNull, isNull, sql, type AnyColumn, type SQL } from "drizzle-orm";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { Db } from "@stubwise/db";
import { projectAccessPermissionsSql, projectAccessSql, projects } from "@stubwise/db";
import {
  effectiveProjectPermissions,
  INSTANCE_PERMISSIONS,
  type InstancePermission,
  type ProjectModule,
  type ProjectPermission,
} from "@stubwise/shared";
import { projectPermissionsOfUser as notificationsProjectPermissionsOfUser } from "@stubwise/notifications";
import { apiError } from "../errors.js";
import type { RouteMcp } from "../mcp/route-mcp.js";
import { markViaClient } from "../mcp/via-client.js";
import { recordSecurityEvent } from "./second-factor/security-events.js";
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
 * - `"vault"` (I6): come `true`, ma vale ANCHE uno sblocco della cassaforte
 *   recente (`vaultUnlockedAt`). Solo le rotte della cassaforte che lo sblocco
 *   usa (la chiave, i sigilli): lo sblocco non apre le altre riconferme.
 *
 * L'elenco delle rotte che la chiedono è chiuso in `route-access.test.ts`.
 */
export type RouteReauth = true | "setup_allowed" | "vault";

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
    /**
     * La rotta è una PORTA: si entra con le credenziali e si esce con una
     * sessione o un token. Ogni porta passa dal secondo fattore
     * (`docs/invariants/second-factor.md`); l'elenco è chiuso in
     * `route-access.test.ts`.
     */
    credentialDoor?: true;
    /**
     * Solo dal browser: nemmeno il PAT desktop riconfermato (10 nov 2026). La
     * dichiara la cassaforte, che dal desktop non si sblocca (lo sblocco è una
     * passkey con PRF, `docs/invariants/vault.md`). La legge
     * {@link browserOrConfirmedDesktop}.
     */
    browserOnly?: true;
    /**
     * Lotto 10 (D-7): la rotta della cassaforte è aperta anche al PAT
     * desktop col suo sigillo VIVO (`vault/device-access.ts`). Elenco chiuso
     * in `route-access.test.ts`; non va insieme a `reauth`.
     */
    desktopVault?: true;
    /**
     * Lotto 10: la rotta è SOLO del PAT desktop (l'associazione di un Mac, il
     * proprio sigillo). Non è `browserOnly`, così una sua `reauth` dichiarata
     * passa dalla finestra del desktop (review 2, M4). Elenco chiuso in
     * `route-access.test.ts`; chi chiama lo controlla `desktopOnly` in
     * `routes/vault.ts`.
     */
    desktopOnly?: true;
    /**
     * 25 nov 2026: una LETTURA della cassaforte aperta al PAT desktop anche
     * SENZA sigillo (lo stato: serve proprio prima dell'associazione). Sola
     * lettura, nessuna busta, nessuna riconferma; rispetta `VAULT_DESKTOP`.
     * Elenco chiuso in `route-access.test.ts`; chi chiama lo controlla la
     * rotta in `routes/vault.ts`.
     */
    desktopRead?: true;
    /**
     * Area 9, F3: la rotta chiede la riconferma solo per UNA PARTE del corpo
     * (un segreto nuovo): la verifica l'handler con {@link requireReauth}. È
     * una dichiarazione, così il test del registro ne tiene l'elenco chiuso.
     */
    partialReauth?: true;
    /**
     * Area 9, F6 (D-8): la rotta di progetto passa anche su un progetto
     * ARCHIVIATO, per chi ne era membro e per i full admin. `"read"` le
     * letture dedicate agli archiviati, `"write"` solo riapri ed elimina.
     * Senza, un archiviato è come uno che non c'è (lettura 404, scrittura
     * 409 `archived` a chi lo vedrebbe). L'elenco è chiuso in
     * `route-access.test.ts`.
     */
    archived?: "read" | "write";
    /**
     * La rotta nel catalogo dell'MCP, o perché ne resta fuori (design
     * `docs/plans/2026-11-26-mcp-parita-design.md`, `mcp/route-mcp.ts`).
     * Verificato da `mcp-parity.test.ts` come `config.access` da
     * `route-access.test.ts`.
     */
    mcp?: RouteMcp;
  }
  interface FastifyRequest {
    /** Impostato dall'hook globale sulle rotte `project`. */
    access?: RequestProjectAccess;
  }
}

/**
 * Permessi effettivi di `user` sul progetto, in UNA query (progetto +
 * appartenenza + ruolo). `null` = invisibile: progetto inesistente,
 * ARCHIVIATO (area 9, F6, D-8: come uno che non c'è), oppure utente non
 * membro e non full admin. Un full admin li ha tutti, membro o no.
 *
 * `includeArchived` è SOLO per le eccezioni dichiarate (`config.archived`
 * delle rotte, la regola del 409 `archived`): chi lo legge di proposito.
 */
export async function projectPermissionsFor(
  db: Pick<Db, "select">,
  user: Pick<SessionUser, "id" | "instancePermissions">,
  projectId: string,
  opts: { includeArchived?: boolean } = {},
): Promise<ReadonlySet<ProjectPermission> | null> {
  const [row] = await db
    // Workspace (0239): l'unione delle fonti di `project_access`, la regola in UN posto.
    .select({ memberRolePermissions: projectAccessPermissionsSql(projects.id, sql`${user.id}::uuid`) })
    .from(projects)
    .where(and(eq(projects.id, projectId), opts.includeArchived ? undefined : isNull(projects.archivedAt)));
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
 * Area 9, F6 (D-8, L-1 = a): l'insieme dei progetti di un elenco. Un full
 * admin non riceve più `"all"` (che non filtrava niente) ma `{ all: true,
 * archived }`: tutti TRANNE gli archiviati. Il tipo diverso è voluto: ogni
 * chiamante che controllava `"all"` ha dovuto decidere cosa fare degli
 * archiviati. Si traduce in SQL con {@link inProjects} e in JS con
 * {@link scopeIncludes}.
 */
export interface AllOpenProjects {
  readonly all: true;
  readonly archived: readonly string[];
}
export type ProjectScope = AllOpenProjects | readonly string[];

/** `scope` è «tutti i progetti aperti» (un full admin). */
export function isAllProjects(scope: ProjectScope): scope is AllOpenProjects {
  return !Array.isArray(scope);
}

/** `projectId` è nell'insieme (mai un archiviato). */
export function scopeIncludes(scope: ProjectScope, projectId: string): boolean {
  return isAllProjects(scope) ? !scope.archived.includes(projectId) : scope.includes(projectId);
}

/**
 * L'insieme come elenco di id: per un full admin tutti i progetti APERTI
 * (letti adesso), altrimenti i suoi. Per chi deve scorrerli uno per uno.
 */
export async function scopeProjectIds(db: Pick<Db, "select">, scope: ProjectScope, opts: { orderByName?: boolean } = {}): Promise<string[]> {
  if (!isAllProjects(scope)) return [...scope];
  const q = db.select({ id: projects.id }).from(projects).where(isNull(projects.archivedAt));
  return (await (opts.orderByName ? q.orderBy(projects.name) : q)).map((r) => r.id);
}

/**
 * Per le funzioni che accettano ancora `"all" | string[]` (in un pacchetto
 * condiviso col worker, o un'API interna larga): `"all"` SOLO se non c'è
 * nessun archiviato da togliere, altrimenti l'elenco dei progetti aperti.
 */
export async function legacyScope(db: Pick<Db, "select">, scope: ProjectScope): Promise<"all" | string[]> {
  if (isAllProjects(scope) && scope.archived.length === 0) return "all";
  return scopeProjectIds(db, scope);
}

/**
 * Il modulo di progetto che un permesso richiede (registro dei rimandi, area 11):
 * i Docs dei repository e lo spazio Product stanno sotto `docs`. Col modulo
 * spento (`projects.modules` senza) la sezione sparisce dall'interfaccia E le
 * rotte rispondono 404 come un progetto invisibile; gli elenchi d'istanza non
 * lo nominano ({@link projectIdsWithPermission}). `null` = nessun modulo.
 */
export function moduleOfPermission(permission: ProjectPermission | "member"): ProjectModule | null {
  return permission.startsWith("docs.") ? "docs" : null;
}

/** Il progetto ha il modulo acceso? Un progetto che non c'è no. */
export async function projectHasModule(db: Pick<Db, "select">, projectId: string, module: ProjectModule): Promise<boolean> {
  const [row] = await db.select({ on: sql<boolean>`${module} = any(${projects.modules})` }).from(projects).where(eq(projects.id, projectId));
  return row?.on === true;
}

/**
 * Chi ha questi permessi LEGGE i Docs del progetto: `docs.view` E il modulo
 * `docs` acceso. LA regola per chi decide fuori da `config.access` (Slack, le
 * card dell'inbox, il dal vivo, gli elenchi derivati): revisione del lotto 1.
 */
export async function readsDocs(
  db: Pick<Db, "select">,
  projectId: string,
  permissions: ReadonlySet<string> | readonly string[] | null | undefined,
  /** I progetti col modulo acceso, già letti per un lotto ({@link docsModuleOn}). */
  docsOn?: ReadonlySet<string>,
): Promise<boolean> {
  const has = Array.isArray(permissions) ? permissions.includes("docs.view") : ((permissions as ReadonlySet<string> | null | undefined)?.has("docs.view") ?? false);
  if (!has) return false;
  return docsOn ? docsOn.has(projectId) : projectHasModule(db, projectId, "docs");
}

/** Di `projectIds`, quelli col modulo Docs acceso: UNA query per un lotto di {@link readsDocs}. */
export async function docsModuleOn(db: Pick<Db, "select">, projectIds: readonly string[]): Promise<ReadonlySet<string>> {
  if (projectIds.length === 0) return new Set();
  const rows = await db
    .select({ id: projects.id })
    .from(projects)
    .where(and(inArray(projects.id, [...new Set(projectIds)]), sql`'docs' = any(${projects.modules})`));
  return new Set(rows.map((r) => r.id));
}

/** Gli archiviati, per l'insieme di un full admin. */
async function allOpenProjects(db: Pick<Db, "select">): Promise<AllOpenProjects> {
  const rows = await db.select({ id: projects.id }).from(projects).where(isNotNull(projects.archivedAt));
  return { all: true, archived: rows.map((r) => r.id) };
}

/**
 * I progetti in cui `user` ha `permission`: tutti gli aperti per un full admin,
 * altrimenti quelli in cui il ruolo della sua appartenenza lo contiene. Da
 * usare come filtro degli elenchi che dipendono da un permesso (es. i ticket
 * altrui con `tickets.view_all`).
 */
export async function projectIdsWithPermission(
  db: Db,
  user: Pick<SessionUser, "id" | "instancePermissions">,
  permission: ProjectPermission,
): Promise<ProjectScope> {
  // Un permesso di un modulo spento non vale in quel progetto (registro, area 11): anche il full admin riceve l'elenco esplicito.
  const module = moduleOfPermission(permission);
  const moduleOn = module ? sql`${module} = any(${projects.modules})` : undefined;
  if (user.instancePermissions.has("instance.full_admin")) {
    if (!moduleOn) return allOpenProjects(db);
    return (await db.select({ id: projects.id }).from(projects).where(and(isNull(projects.archivedAt), moduleOn))).map((r) => r.id);
  }
  const rows = await db
    .select({ projectId: projects.id })
    .from(projects)
    .where(
      and(
        isNull(projects.archivedAt),
        // `null @> …` è null: un non membro non passa (workspace, 0239).
        sql`${projectAccessPermissionsSql(projects.id, sql`${user.id}::uuid`)} @> array[${permission}]::text[]`,
        moduleOn,
      ),
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
 * I progetti che `user` vede: tutti gli aperti per un full admin (che vede
 * anche i progetti creati dopo, senza esserne membro), altrimenti quelli
 * aperti di cui è membro. Mai un archiviato (F6). Da usare come filtro degli
 * elenchi.
 */
export async function visibleProjectIds(
  db: Db,
  user: Pick<SessionUser, "id" | "instancePermissions">,
): Promise<ProjectScope> {
  if (user.instancePermissions.has("instance.full_admin")) return allOpenProjects(db);
  const rows = await db
    .select({ projectId: projects.id })
    .from(projects)
    // Membro esplicito o di una workspace del progetto (0239).
    .where(and(isNull(projects.archivedAt), projectAccessSql(projects.id, sql`${user.id}::uuid`)));
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
  opts: { includeArchived?: boolean } = {},
): Promise<Record<string, ProjectPermission[]>> {
  const instance = new Set(user.instancePermissions);
  // Mai un archiviato (F6): `/api/auth/me` non lo nomina. `includeArchived`
  // solo per chi lo legge di proposito (il registro delle modifiche).
  const open = opts.includeArchived ? undefined : isNull(projects.archivedAt);
  const rows = instance.has("instance.full_admin")
    ? (await db.select({ projectId: projects.id }).from(projects).where(open)).map((r) => ({
        projectId: r.projectId,
        permissions: [] as string[],
      }))
    : await db
        .select({
          projectId: projects.id,
          permissions: sql<string[]>`${projectAccessPermissionsSql(projects.id, sql`${user.id}::uuid`)}`,
        })
        .from(projects)
        .where(and(open, projectAccessSql(projects.id, sql`${user.id}::uuid`)));
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
 * per tutti gli aperti (un full admin) solo gli archiviati fuori (`undefined`
 * se non ce ne sono), `false` per un insieme vuoto (non si vede niente).
 * `ids` è quello di {@link visibleProjectIds} o di
 * {@link projectIdsWithPermission}.
 */
export function inProjects(
  column: AnyColumn | SQL,
  ids: ProjectScope,
): SQL | undefined {
  // Tutti gli aperti (un full admin): fuori gli archiviati, e restano le
  // righe senza progetto (voci d'istanza, automazioni generali), come prima.
  if (isAllProjects(ids)) {
    if (ids.archived.length === 0) return undefined;
    return sql`(${column} IS NULL OR ${column} NOT IN (${sql.join(ids.archived.map((id) => sql`${id}`), sql`, `)}))`;
  }
  if (ids.length === 0) return sql`false`;
  return inArray(sql`${column}`, [...ids]);
}

/**
 * Come {@link inProjects}, ma una riga SENZA progetto non passa mai, nemmeno
 * per un full admin. Per le colonne dove il null vuol dire «di nessun
 * progetto» e non «d'istanza»: il progetto di un repository (null = STACCATO,
 * area 9, F6), che nessuna lettura di progetto deve trovare.
 */
export function inProjectsStrict(column: AnyColumn | SQL, ids: ProjectScope): SQL {
  return and(sql`${column} IS NOT NULL`, inProjects(column, ids))!;
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
  // D4 della parità MCP: una richiesta dell'MCP col PAT `manual` è «via Claude Code».
  markViaClient(user, request.headers);
  // Il token del turno della chat con Claude: SOLO GET e solo l'allowlist chiusa
  // delle rotte di lettura, più UNA rotta di scrittura (creare una proposta),
  // prima di ogni altro controllo (riconferma compresa).
  if (user.chatToolSessionId !== undefined) {
    const url = request.routeOptions.url ?? "";
    const read = request.method === "GET" && CHAT_TOOL_READ_ROUTES.has(url);
    const write = CHAT_TOOL_WRITE_ROUTES.has(`${request.method} ${url}`);
    if (!read && !write) {
      await apiError(reply, 403, "chat_tool_forbidden", "Not available to Claude's read tools");
      return;
    }
    // Area 10, F1 (review I2, I3): posta, calendario, canali privati e DM,
    // automazioni generali solo in una conversazione libera PRIVATA.
    const params = (request.params ?? {}) as Record<string, unknown>;
    if (read && (await isPrivateChatToolRead(request.server.db, url, params)) && !(await isPrivateConversation(request.server.db, user.chatToolSessionId))) {
      await apiError(reply, 403, "chat_tool_private_only", "Personal content can be read only in a private conversation");
      return;
    }
  }

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
 * - Un PAT non riconferma mai da solo (403 `session_required`): un token
 *   rubato non deve poter cambiare ruoli. L'eccezione è UNA: un PAT `desktop`
 *   con un secondo fattore fatto con lui dentro l'app negli ultimi 10 minuti
 *   (`POST /api/auth/desktop-reauth`, decisione del maintainer del 10 nov
 *   2026); `mobile` e `manual` mai. Le rotte che non coniano token da un
 *   token lo rifiutano comunque nel loro handler.
 * - Senza un'app configurata (sessione di prima del rilascio) non c'è un
 *   fattore con cui riconfermare: 403 `second_factor_setup_required`, e la
 *   web apre la configurazione (le rotte `"setup_allowed"`), che conta come
 *   riconferma.
 * - Secondo fattore mai usato in questa sessione, o più vecchio della
 *   finestra: 403 `reauth_required`.
 */
/**
 * Area 9, F1: fino a quando vale la riconferma di chi chiede, con la STESSA
 * regola di {@link applyReauth} (sessione del browser: il suo secondo fattore;
 * PAT `desktop`: il suo; ogni altro PAT: mai). `null` se non c'è o è scaduta.
 */
export function reauthUntilOf(user: SessionUser): string | null {
  const at = isDesktopPat(user) ? user.patSecondFactorAt : user.patId === undefined && user.sessionId !== undefined ? user.secondFactorAt : null;
  if (!at) return null;
  const until = at.getTime() + REAUTH_WINDOW_MS;
  return until > Date.now() ? new Date(until).toISOString() : null;
}

async function applyReauth(
  request: FastifyRequest,
  reply: FastifyReply,
  user: SessionUser,
  reauth: RouteReauth,
): Promise<void> {
  // Un PAT non soddisfa la riconferma, salvo UNO: il PAT `desktop`, con un
  // secondo fattore fatto con lui dentro l'app (`POST /api/auth/desktop-reauth`)
  // negli ultimi 10 minuti (decisione del maintainer, 10 nov 2026). `mobile` e
  // `manual` restano `session_required`, sempre.
  const browserOnly = request.routeOptions.config?.browserOnly === true;
  const desktopPat = isDesktopPat(user) && !browserOnly;
  if (!desktopPat && (user.patId !== undefined || user.sessionId === undefined)) {
    await apiError(reply, 403, "session_required", "This action requires a browser session");
    return;
  }
  if (!(await hasConfirmedTotp(request.server.db, user.id))) {
    // Dal desktop l'app si configura nel browser: niente scorciatoia.
    if (reauth === "setup_allowed" && !desktopPat) return;
    await apiError(reply, 403, "second_factor_setup_required", "Second factor setup required");
    return;
  }
  const fresh = (d: Date | null | undefined) => d != null && Date.now() - d.getTime() <= REAUTH_WINDOW_MS;
  const at = desktopPat ? user.patSecondFactorAt : user.secondFactorAt;
  const vaultOk = reauth === "vault" && !desktopPat && fresh(user.vaultUnlockedAt);
  if (!vaultOk && !fresh(at)) {
    await apiError(reply, 403, "reauth_required", "Recent second factor confirmation required");
    return;
  }
  if (desktopPat) markDesktopReauthUse(request);
}

/**
 * Area 9, F3: la riconferma chiesta da un handler per una PARTE del corpo
 * (`config.partialReauth`): la STESSA regola del gate ({@link applyReauth}),
 * mai una copia. `false` se ha già risposto (403), e l'handler esce.
 */
export async function requireReauth(request: FastifyRequest, reply: FastifyReply): Promise<boolean> {
  await applyReauth(request, reply, request.user!, true);
  return !reply.sent;
}

/** Il PAT dell'app desktop (`kind = 'desktop'`, dal login nel browser). */
export function isDesktopPat(user: SessionUser): boolean {
  return user.patId !== undefined && user.patKind === "desktop";
}

/**
 * LA regola delle azioni che vogliono il browser (decisione del maintainer,
 * 10 nov 2026: «dal desktop si deve poter fare tutto quello che si fa dal
 * browser»). Passa una sessione del browser, o il PAT `desktop` dentro la sua
 * finestra di riconferma (`POST /api/auth/desktop-reauth`, 10 minuti). Il PAT
 * `mobile` e quello `manual` mai, e nemmeno il token del turno della chat.
 * Senza finestra il desktop riceve `reauth_required`, così l'app apre
 * «Confirm it's you»; gli altri `session_required`.
 *
 * La usano il gate `config.reauth` (`applyReauth`, con in più il controllo
 * dell'app configurata) e le rotte che rifiutano un PAT nel loro handler
 * (`requireBrowserOrConfirmedDesktop`). Una rotta che dichiara
 * `config.browserOnly` (la cassaforte: dal desktop la chiave non si sblocca,
 * `docs/invariants/vault.md`) resta solo-browser anche per il desktop.
 */
export function browserOrConfirmedDesktop(
  user: SessionUser,
  opts: { browserOnly?: boolean; now?: number } = {},
): { ok: true; via: "session" | "desktop" } | { ok: false; code: "session_required" | "reauth_required" } {
  const now = opts.now ?? Date.now();
  if (user.patId === undefined) {
    return user.sessionId !== undefined ? { ok: true, via: "session" } : { ok: false, code: "session_required" };
  }
  if (!isDesktopPat(user) || opts.browserOnly === true) return { ok: false, code: "session_required" };
  const at = user.patSecondFactorAt;
  return at && now - at.getTime() <= REAUTH_WINDOW_MS
    ? { ok: true, via: "desktop" }
    : { ok: false, code: "reauth_required" };
}

/**
 * {@link browserOrConfirmedDesktop} con la risposta: `false` = la 403 è già
 * partita. Una rotta che dichiara anche `config.reauth` ha già registrato
 * l'uso della finestra nel gate; le altre lo registrano qui.
 */
export async function requireBrowserOrConfirmedDesktop(
  request: FastifyRequest,
  reply: FastifyReply,
  message = "This action requires a browser session",
): Promise<boolean> {
  const user = request.user!;
  const verdict = browserOrConfirmedDesktop(user, { browserOnly: request.routeOptions.config?.browserOnly === true });
  if (!verdict.ok) {
    await apiError(
      reply,
      403,
      verdict.code,
      verdict.code === "reauth_required" ? "Recent second factor confirmation required" : message,
    );
    return false;
  }
  const declared = (request.routeOptions.config as { reauth?: RouteReauth } | undefined)?.reauth;
  if (verdict.via === "desktop" && declared === undefined) markDesktopReauthUse(request);
  return true;
}

const DESKTOP_REAUTH_USE = Symbol("desktopReauthUse");

/**
 * Segna che la richiesta usa la finestra di riconferma del PAT desktop. La
 * riga `reauth_desktop` con l'azione si scrive SOLO a risposta riuscita
 * (`recordDesktopReauthUseOnResponse`, review della fetta 3): una richiesta che
 * poi il permesso o il servizio rifiuta non è un'azione fatta.
 */
function markDesktopReauthUse(request: FastifyRequest): void {
  (request as unknown as Record<symbol, true>)[DESKTOP_REAUTH_USE] = true;
}

/** Hook `onResponse` dell'app: la riga `reauth_desktop` con l'azione, se la richiesta è passata. */
export async function recordDesktopReauthUseOnResponse(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  if ((request as unknown as Record<symbol, true | undefined>)[DESKTOP_REAUTH_USE] !== true) return;
  if (reply.statusCode >= 400 || !request.user) return;
  await recordSecurityEvent(request.server.db, {
    kind: "reauth_desktop",
    user: request.user,
    detail: `${request.method} ${request.routeOptions.url ?? request.url.split("?")[0]}`,
  }).catch((error: unknown) => request.log.warn({ err: error }, "reauth_desktop non registrato"));
}

export type ProjectAccessResult =
  | { ok: true; projectId: string; permissions: ReadonlySet<ProjectPermission>; archived: boolean }
  | { ok: false; error: "not_found" | "forbidden" | "archived" };

/**
 * La regola di un `RouteAccess` di progetto, senza risposta HTTP: progetto
 * invisibile o risorsa invisibile → `not_found`, permesso mancante →
 * `forbidden`. La usano il `preHandler` delle rotte e l'esecutore delle azioni
 * di Claude (chat, fetta 3), che la valuta sulla STESSA dichiarazione della
 * rotta con una richiesta sintetica (parametri e corpo): un'azione di Claude
 * ha esattamente i permessi della rotta che la persona userebbe.
 */
export async function evaluateProjectAccess(
  request: FastifyRequest,
  db: Db,
  user: SessionUser,
  access: Extract<RouteAccess, { kind: "project" }>,
): Promise<ProjectAccessResult> {
  const projectId = await access.project(request, db);
  if (!projectId) return { ok: false, error: "not_found" };
  let permissions = await projectPermissionsFor(db, user, projectId);
  let archived = false;
  if (!permissions) {
    // Area 9, F6 (D-8): invisibile perché ARCHIVIATO? Lo si chiede solo qui,
    // e chi non lo vedrebbe nemmeno aperto resta a 404.
    const asArchived = await projectPermissionsFor(db, user, projectId, { includeArchived: true });
    if (!asArchived) return { ok: false, error: "not_found" };
    if (!request.routeOptions?.config?.archived) {
      // Una lettura non dichiarata: come uno che non c'è. Una scrittura:
      // chi lo vedrebbe sa perché non si può (409), e niente cambia.
      return request.method === "GET" || request.method === "HEAD" ? { ok: false, error: "not_found" } : { ok: false, error: "archived" };
    }
    permissions = asArchived;
    archived = true;
  }
  // Il modulo del permesso spento: come un progetto invisibile (registro, area 11).
  const module = moduleOfPermission(access.permission);
  if (module && !(await projectHasModule(db, projectId, module))) return { ok: false, error: "not_found" };
  if (access.resource && !(await access.resource(request, db, user, permissions))) {
    return { ok: false, error: "not_found" };
  }
  if (access.permission !== "member" && !permissions.has(access.permission)) {
    return { ok: false, error: "forbidden" };
  }
  return { ok: true, projectId, permissions, archived };
}

async function applyProjectAccess(
  request: FastifyRequest,
  reply: FastifyReply,
  user: SessionUser,
  access: Extract<RouteAccess, { kind: "project" }>,
): Promise<void> {
  const result = await evaluateProjectAccess(request, request.server.db, user, access);
  if (!result.ok) {
    await (result.error === "not_found"
      ? apiError(reply, 404, "not_found", "Not found")
      : result.error === "archived"
        ? apiError(reply, 409, "archived", "The project is archived: reopen it first")
        : apiError(reply, 403, "forbidden", "Missing permission"));
    return;
  }
  request.access = { projectId: result.projectId, permissions: result.permissions };
}
