import { registerPersonMask } from "../services/people-known.js";
import {
  computeServerStatus,
  createServerSchema,
  serverHealth,
  serverWithKeySchema,
  type HealthEpisode,
  serverDetailSchema,
  serverSearchResultSchema,
  serverViewSchema,
  updateServerSchema,
} from "@stubwise/shared";
import {
  projects,
  environmentServers,
  projectEnvironments,
  repositories,
  serverEpisodes,
  serverAnalyses,
  serverMetrics,
  servers,
  serverSshAccess,
  serviceChecks,
} from "@stubwise/db";
import { and, asc, desc, eq, ilike, inArray, isNull, or, sql } from "drizzle-orm";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { isAllProjects, legacyScope, projectPermissionsFor, visibleProjectIds } from "../auth/access.js";
import { likeNeedle, SEARCH_LIMIT, SEARCH_MIN_CHARS } from "../services/releases.js";
import { canViewServer, serverIdsOfProjects, visibleServerIds } from "../auth/monitor-access.js";
import { toCheckView } from "./servers-checks.js";
import { commandPublicKey } from "../services/server-signing.js";
import { operatorAccess } from "./server-analyses.js";
import { apiError } from "../errors.js";
import {
  authErrorResponses,
  errorSchema,
  generateServerKey,
  hashServerKey,
} from "./shared.js";

/** Quanti valori di CPU recenti includere nella lista/dettaglio (sparkline UI). */
const RECENT_CPU_POINTS = 20;

const idParamsSchema = z.object({ id: z.uuid() });

/** Query string della lista: filtro opzionale per progetto associato. */
const listQuerySchema = z.object({ projectId: z.uuid().optional() });

type ServerRow = typeof servers.$inferSelect;

/**
 * `serverViewSchema` e `serverDetailSchema` vivono in `@stubwise/shared` dal
 * 23 set 2026 (hub di progetto, tappa 3): l'app mobile parsa questa risposta e
 * ha bisogno dello schema. Lo spostamento non ha cambiato nessuna forma.
 */
type ServerView = z.infer<typeof serverViewSchema>;


/** Dati aggregati per un server, da unire alla riga base nella proiezione. */
interface ServerAggregates {
  projects: ServerView["projects"];
  checksUp: number;
  checksDown: number;
  recentCpu: number[];
  /** Area 8, F4a: gli ambienti che lo usano, dei SOLI progetti visibili. */
  environments: ServerView["environments"];
  /** Nessun ambiente di nessun progetto (anche invisibile) lo usa. */
  orphan: boolean;
  /** Gli episodi, dal più recente (al più EPISODES_SHOWN). */
  episodes: { id: string; severity: "trouble" | "down"; reasons: HealthEpisode["reasons"][number][]; startedAt: string; recoveredAt: string | null }[];
}

/** Quanti episodi porta il dettaglio (e su quanti si calcola la salute). */
const EPISODES_SHOWN = 20;

/** Aggregati vuoti (server senza progetti/check/campioni). */
function emptyAggregates(): ServerAggregates {
  return { projects: [], checksUp: 0, checksDown: 0, recentCpu: [], environments: [], orphan: true, episodes: [] };
}

/**
 * Compone la proiezione pubblica del server: campi elencati esplicitamente (mai
 * spread della riga, così `keyHash` non può sfuggire) + aggregati + stato.
 */
function toServerView(row: ServerRow, agg: ServerAggregates, now: Date): ServerView {
  return {
    id: row.id,
    name: row.name,
    hostname: row.hostname,
    status: computeServerStatus(row.lastSeenAt, row.sampleIntervalSeconds, now),
    sampleIntervalSeconds: row.sampleIntervalSeconds,
    agentVersion: row.agentVersion,
    alertThresholds: row.alertThresholds,
    lastSeenAt: row.lastSeenAt ? row.lastSeenAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
    projects: agg.projects,
    checksUp: agg.checksUp,
    checksDown: agg.checksDown,
    recentCpu: agg.recentCpu,
    // Area 8, F4a (S2).
    code: `SRV-${row.number}`,
    health: serverHealth(
      { status: computeServerStatus(row.lastSeenAt, row.sampleIntervalSeconds, now), lastSeenAt: row.lastSeenAt ? row.lastSeenAt.toISOString() : null },
      agg.episodes,
      now.toISOString(),
    ),
    environments: agg.environments,
    // L'analisi e la correzione sono della F4b.
    work: "none",
    orphan: agg.orphan,
    // I progetti non hanno ancora un archivio sul server.
    inArchivedOnly: false,
    // Area 8, F4b: lo dichiara l'ingest (S4, `agent_capabilities`): una dichiarazione, non un permesso.
    agentOperations: row.agentCapabilities?.operations === true,
  };
}

/**
 * Calcola gli aggregati (progetti, conteggi check, CPU recente) per un insieme
 * di server in poche query batch, evitando N+1: una join progetti (inArray),
 * un group-by sui check, e — poiché i server monitorati sono pochi — una query
 * di CPU recente per server (semplice e con `LIMIT`, il volume è trascurabile).
 */
async function loadAggregates(
  app: FastifyInstance,
  serverIds: string[],
  /** I progetti che chi guarda vede: ambienti e progetti di un server solo di questi. */
  visibleProjects: "all" | readonly string[],
): Promise<Map<string, ServerAggregates>> {
  const byServer = new Map<string, ServerAggregates>();
  for (const id of serverIds) byServer.set(id, emptyAggregates());
  if (serverIds.length === 0) return byServer;

  // Area 8, F4a: gli ambienti (per repository) che usano ogni server, con
  // progetto e repository, in una query. Orfano = nessuna riga; ambienti e
  // progetti della vista = solo quelli dei progetti visibili.
  const envRows = await app.db
    .select({
      serverId: environmentServers.serverId,
      projectId: projects.id,
      projectCode: projects.code,
      projectName: projects.name,
      environmentId: projectEnvironments.id,
      name: projectEnvironments.name,
      kind: projectEnvironments.kind,
      repositoryId: repositories.id,
      repositoryName: repositories.name,
    })
    .from(environmentServers)
    .innerJoin(projectEnvironments, eq(projectEnvironments.id, environmentServers.environmentId))
    .innerJoin(projects, eq(projects.id, projectEnvironments.projectId))
    .innerJoin(repositories, eq(repositories.id, environmentServers.repositoryId))
    .where(inArray(environmentServers.serverId, serverIds))
    .orderBy(projects.name, projectEnvironments.name, repositories.name);
  const sees = (projectId: string) => visibleProjects === "all" || visibleProjects.includes(projectId);
  for (const r of envRows) {
    const agg = byServer.get(r.serverId)!;
    agg.orphan = false;
    if (!sees(r.projectId)) continue;
    agg.environments.push({
      projectId: r.projectId,
      projectCode: r.projectCode ?? "",
      environmentId: r.environmentId,
      name: r.name,
      kind: r.kind,
      repositoryId: r.repositoryId,
      repositoryName: r.repositoryName,
    });
    if (!agg.projects.some((p) => p.id === r.projectId)) agg.projects.push({ id: r.projectId, name: r.projectName });
  }

  // Gli episodi (la salute e il dettaglio), dal più recente.
  const episodeRows = await app.db
    .select()
    .from(serverEpisodes)
    .where(inArray(serverEpisodes.serverId, serverIds))
    .orderBy(desc(serverEpisodes.startedAt));
  for (const e of episodeRows) {
    const agg = byServer.get(e.serverId)!;
    if (agg.episodes.length >= EPISODES_SHOWN) continue;
    agg.episodes.push({
      id: e.id,
      severity: e.severity,
      reasons: e.reasons,
      startedAt: e.startedAt.toISOString(),
      recoveredAt: e.recoveredAt ? e.recoveredAt.toISOString() : null,
    });
  }

  // Conteggi check up/down (solo abilitati), aggregati per server in una query.
  const checkRows = await app.db
    .select({
      serverId: serviceChecks.serverId,
      up: sql<number>`count(*) filter (where ${serviceChecks.lastStatus} = 'up')::int`,
      down: sql<number>`count(*) filter (where ${serviceChecks.lastStatus} = 'down')::int`,
    })
    .from(serviceChecks)
    .where(and(inArray(serviceChecks.serverId, serverIds), eq(serviceChecks.enabled, true)))
    .groupBy(serviceChecks.serverId);
  for (const r of checkRows) {
    const agg = byServer.get(r.serverId)!;
    agg.checksUp = r.up;
    agg.checksDown = r.down;
  }

  // CPU recente: una query per server (i server monitorati sono pochi). Prendo
  // gli ultimi N in ordine decrescente e li riordino dal più vecchio.
  for (const id of serverIds) {
    const cpuRows = await app.db
      .select({ cpuPct: serverMetrics.cpuPct })
      .from(serverMetrics)
      .where(eq(serverMetrics.serverId, id))
      .orderBy(desc(serverMetrics.ts))
      .limit(RECENT_CPU_POINTS);
    byServer.get(id)!.recentCpu = cpuRows.map((r) => r.cpuPct).reverse();
  }

  return byServer;
}

/**
 * Route interne del monitoraggio server, sotto /api/servers. Lettura con
 * `monitor.view` o via un progetto visibile collegato; creazione, modifica,
 * rigenerazione chiave ed eliminazione con `monitor.manage`. La chiave dell'agente (`sk_…`) si mostra in chiaro SOLO alla
 * creazione e alla rigenerazione: in DB vive solo l'hash (sha256).
 */
/** Registro, A11 r.1414: le chiavi delle risposte che portano una persona. */
const SERVER_PERSON_KEYS: ReadonlySet<string> = new Set([]);

export async function serverRoutes(instance: FastifyInstance): Promise<void> {
  const app = instance.withTypeProvider<ZodTypeProvider>();
  // Registro, A11 r.1414: chi guarda non riceve l'id di chi non conosce.
  registerPersonMask(app, SERVER_PERSON_KEYS, new Set(["startedBy", "requestedBy", "by"]));

  /** L'URL dell'istanza per il comando d'installazione (`agentInstallCommand`); null senza PUBLIC_URL. */
  const ingestUrlOf = (): string | null => {
    try {
      return app.publicUrl;
    } catch {
      return null;
    }
  };

  app.post(
    "/",
    {
      config: { mcp: { exclude: "secret_once" }, access: { kind: "instance", permission: "monitor.manage" } },
      schema: {
        body: createServerSchema,
        response: { 201: serverWithKeySchema, 400: errorSchema, 404: errorSchema, ...authErrorResponses },
      },
    },
    async (request, reply) => {
      const now = new Date();
      const key = generateServerKey();
      const { name, environment } = request.body;
      // Area 8, F4a, S4: con un ambiente, server e collegamento nella STESSA
      // transazione (due chiamate lascerebbero un server orfano a metà). Serve
      // `environments.manage` nel progetto dell'ambiente, oltre a monitor.manage.
      let env: { id: string; projectId: string } | undefined;
      let targetRepos: string[] = [];
      let wholeProject = false;
      if (environment) {
        [env] = await app.db
          .select({ id: projectEnvironments.id, projectId: projectEnvironments.projectId })
          .from(projectEnvironments)
          .where(eq(projectEnvironments.id, environment.environmentId));
        // Un ambiente di un progetto invisibile risponde come uno inesistente.
        const permissions = env ? await projectPermissionsFor(app.db, request.user!, env.projectId) : null;
        if (!env || !permissions) return apiError(reply, 404, "environment_not_found", "Environment not found");
        if (!permissions.has("environments.manage")) {
          return apiError(reply, 403, "forbidden", "Linking a server to an environment needs environments.manage");
        }
        if (environment.repositoryIds) {
          const repos = await app.db
            .select({ id: repositories.id })
            .from(repositories)
            .where(and(eq(repositories.projectId, env.projectId), inArray(repositories.id, environment.repositoryIds)));
          if (repos.length !== new Set(environment.repositoryIds).size) {
            return apiError(reply, 400, "bad_repository", "A repository is not in this project");
          }
          targetRepos = [...new Set(environment.repositoryIds)];
        } else {
          // Tutto il progetto: ogni repository, e l'ambiente intero (`serverId`).
          targetRepos = (await app.db.select({ id: repositories.id }).from(repositories).where(eq(repositories.projectId, env.projectId))).map((r) => r.id);
          wholeProject = true;
        }
      }
      const created = await app.db.transaction(async (tx) => {
        const [row] = await tx.insert(servers).values({ name, keyHash: hashServerKey(key) }).returning();
        if (!row) throw new Error("insert del server non ha restituito la riga");
        if (env && wholeProject) {
          await tx.update(projectEnvironments).set({ serverId: row.id }).where(eq(projectEnvironments.id, env.id));
        }
        if (env) {
          for (const repositoryId of targetRepos) {
            const insert = tx.insert(environmentServers).values({ environmentId: env.id, repositoryId, serverId: row.id });
            // Per tutto il progetto le eccezioni per repository VINCONO (review
            // F4a, come il prototipo): solo le repository senza riga. Per
            // repository nominate la scelta è esplicita e sostituisce.
            if (wholeProject) await insert.onConflictDoNothing();
            else await insert.onConflictDoUpdate({ target: [environmentServers.environmentId, environmentServers.repositoryId], set: { serverId: row.id } });
          }
        }
        return row;
      });
      const agg = (await loadAggregates(app, [created.id], await legacyScope(app.db, await visibleProjectIds(app.db, request.user!)))).get(created.id)!;
      return await reply.code(201).send({ ...toServerView(created, agg, now), key, ingestUrl: ingestUrlOf() });
    },
  );

  app.get(
    "/",
    {
      config: { mcp: { action: "servers.list", summary: "I server monitorati che vedi, con stato e ultimo campione (filtro per progetto).", effect: "read" }, access: { kind: "user" } },
      schema: {
        querystring: listQuerySchema,
        response: { 200: z.array(serverViewSchema), 404: errorSchema, ...authErrorResponses },
      },
    },
    async (request, reply) => {
      const now = new Date();
      const { projectId } = request.query;
      // Chi non ha `monitor.view` vede solo i server collegati a un progetto
      // che vede (filtro nella query, non dopo).
      const visible = await visibleServerIds(app.db, request.user!);

      // Filtro per progetto: gli id dei server associati, poi la lista completa.
      let rows: ServerRow[];
      if (projectId) {
        // Un progetto invisibile risponde come uno inesistente (review F4a),
        // anche a chi ha monitor.view: i suoi ambienti non escono.
        if (!(await projectPermissionsFor(app.db, request.user!, projectId))) {
          return apiError(reply, 404, "not_found", "Not found");
        }
        // Area 8, F4a: i server degli AMBIENTI del progetto.
        const ids = (await serverIdsOfProjects(app.db, [projectId])).filter((id) => visible === "all" || visible.includes(id));
        rows =
          ids.length === 0
            ? []
            : await app.db
                .select()
                .from(servers)
                .where(inArray(servers.id, ids))
                .orderBy(servers.createdAt);
      } else if (visible === "all") {
        rows = await app.db.select().from(servers).orderBy(servers.createdAt);
      } else {
        rows =
          visible.length === 0
            ? []
            : await app.db
                .select()
                .from(servers)
                .where(inArray(servers.id, visible))
                .orderBy(servers.createdAt);
      }

      const agg = await loadAggregates(app, rows.map((r) => r.id), await legacyScope(app.db, await visibleProjectIds(app.db, request.user!)));
      return rows.map((r) => toServerView(r, agg.get(r.id)!, now));
    },
  );

  /** Il dettaglio di un server visibile (per id o per codice): la vista più lo snapshot, i controlli, gli episodi. */
  async function sshSummary(serverId: string) {
    const [a] = await app.db.select().from(serverSshAccess).where(eq(serverSshAccess.serverId, serverId));
    if (!a) return { status: "none" as const, usable: false };
    return { status: a.status, usable: a.status === "verified" && a.verifyResult?.ok === true && a.hostKey !== null && a.privateKeyEncrypted !== "" };
  }

  async function detailOf(row: ServerRow, user: NonNullable<FastifyRequest["user"]>) {
    const now = new Date();
    const visibleProjects = await legacyScope(app.db, await visibleProjectIds(app.db, user));
    const agg = (await loadAggregates(app, [row.id], visibleProjects)).get(row.id)!;
    // Snapshot corrente dall'ultimo campione: servizi scoperti, dischi,
    // memoria e ts. La memoria (23 set 2026) sta nella STESSA riga: le due
    // colonne sono NOT NULL, quindi c'è sempre quando c'è un campione.
    const [latest] = await app.db
      .select({
        ts: serverMetrics.ts,
        services: serverMetrics.services,
        disks: serverMetrics.disks,
        memUsedBytes: serverMetrics.memUsedBytes,
        memTotalBytes: serverMetrics.memTotalBytes,
      })
      .from(serverMetrics)
      .where(eq(serverMetrics.serverId, row.id))
      .orderBy(desc(serverMetrics.ts))
      .limit(1);
    const checks = await app.db.select().from(serviceChecks).where(eq(serviceChecks.serverId, row.id)).orderBy(serviceChecks.createdAt);
    const productionProjects: { id: string; code: string; name: string }[] = [];
    for (const e of agg.environments) {
      if (e.kind === "production" && !productionProjects.some((p) => p.id === e.projectId)) {
        productionProjects.push({ id: e.projectId, code: e.projectCode, name: agg.projects.find((p) => p.id === e.projectId)?.name ?? "" });
      }
    }
    return {
      ...toServerView(row, agg, now),
      services: latest?.services ?? [],
      disks: latest?.disks ?? [],
      metricsAt: latest ? latest.ts.toISOString() : null,
      memUsedBytes: latest?.memUsedBytes ?? null,
      memTotalBytes: latest?.memTotalBytes ?? null,
      // Area 8, F4a (S2).
      checks: checks.map(toCheckView),
      episodes: agg.episodes,
      productionProjects,
      canManage: user.instancePermissions.has("monitor.manage"),
      // Area 8, F4b: lo stato dell'accesso SSH, senza niente di segreto (la regola di `usable` è quella di ssh_read).
      ssh: await sshSummary(row.id),
      // Area 8, F4b: lo calcola il server, con la regola della POST …/analyses.
      canStartAnalysis:
        (await operatorAccess(app, user, row.id)).operate &&
        (await app.db.select({ id: serverAnalyses.id }).from(serverAnalyses).where(and(eq(serverAnalyses.serverId, row.id), isNull(serverAnalyses.episodeId), eq(serverAnalyses.status, "running"))).limit(1)).length === 0,
    };
  }

  // Area 8, F4b, S2: la chiave PUBBLICA d'istanza che verifica i comandi,
  // per il comando d'installazione con le operazioni. Mai la privata.
  // Letterale: PRIMA di `/:id`.
  app.get(
    "/command-key",
    {
      config: { mcp: { action: "servers.commandKey", summary: "La chiave PUBBLICA con cui gli agenti verificano i comandi di Stubwise.", effect: "read" }, access: { kind: "instance", permission: "monitor.manage" } },
      schema: { response: { 200: z.object({ publicKey: z.string() }), ...authErrorResponses } },
    },
    async () => ({ publicKey: await commandPublicKey(app.db, app.encryptionKey) }),
  );

  // ⌘K (rimandi, lotto 5): per codice, nome o hostname, fra i server che
  // chi cerca vede (`visibleServerIds`, nella WHERE). Letterale: PRIMA di `/:id`.
  app.get(
    "/search",
    {
      config: { mcp: { action: "servers.search", summary: "Cerca un server per nome, host o codice SRV-n.", effect: "read" }, access: { kind: "user" } },
      schema: { querystring: z.object({ q: z.string().max(200).default("") }), response: { 200: z.object({ items: z.array(serverSearchResultSchema) }), ...authErrorResponses } },
    },
    async (request) => {
      const q = request.query.q;
      if (q.trim().length < SEARCH_MIN_CHARS) return { items: [] };
      const user = request.user!;
      const visible = await visibleServerIds(app.db, user);
      if (visible !== "all" && visible.length === 0) return { items: [] };
      const needle = likeNeedle(q);
      const rows = await app.db
        .select({ id: servers.id, number: servers.number, name: servers.name })
        .from(servers)
        .where(
          and(
            visible === "all" ? undefined : inArray(servers.id, visible),
            or(sql`('SRV-' || ${servers.number}) ilike ${needle}`, ilike(servers.name, needle), ilike(servers.hostname, needle)),
          ),
        )
        .orderBy(asc(servers.name))
        .limit(SEARCH_LIMIT);
      if (rows.length === 0) return { items: [] };
      // Il progetto da cui aprirlo: il primo visibile (per codice) fra i suoi ambienti, o il primo visibile.
      const scope = await visibleProjectIds(app.db, user);
      const envs = await app.db
        .selectDistinct({ serverId: environmentServers.serverId, code: projects.code })
        .from(environmentServers)
        .innerJoin(projectEnvironments, eq(projectEnvironments.id, environmentServers.environmentId))
        .innerJoin(projects, and(eq(projects.id, projectEnvironments.projectId), isNull(projects.archivedAt)))
        .where(and(inArray(environmentServers.serverId, rows.map((r) => r.id)), isAllProjects(scope) ? undefined : inArray(projects.id, scope.length ? [...scope] : ["00000000-0000-0000-0000-000000000000"])));
      const home = new Map<string, string>();
      for (const e of [...envs].sort((a, b) => a.code.localeCompare(b.code))) if (!home.has(e.serverId)) home.set(e.serverId, e.code);
      // Review del lotto 5 (M-7, 46): senza un ambiente visibile `projectCode`
      // è null, e il client apre la pagina d'istanza del server — mai il
      // «primo progetto visibile», che non c'entra (e per chi vede tutti i
      // server senza progetti non c'è proprio).
      return { items: rows.map((r) => ({ code: `SRV-${r.number}`, name: r.name, projectCode: home.get(r.id) ?? null })) };
    },
  );

  // Area 8, F4a: per codice (`SRV-<n>`). Letterale: PRIMA di `/:id`.
  app.get(
    "/by-code/:code",
    {
      config: { mcp: { action: "servers.getByCode", summary: "Un server dal suo codice (SRV-12), col dettaglio.", effect: "read" }, access: { kind: "user" } },
      schema: {
        params: z.object({ code: z.string().min(1).max(40) }),
        response: { 200: serverDetailSchema, 404: errorSchema, ...authErrorResponses },
      },
    },
    async (request, reply) => {
      const m = /^SRV-(\d{1,9})$/i.exec(request.params.code.trim());
      const [row] = m ? await app.db.select().from(servers).where(eq(servers.number, Number(m[1]))) : [];
      // Un server non visibile risponde 404 come uno inesistente.
      if (!row || !(await canViewServer(app.db, request.user!, row.id))) {
        return apiError(reply, 404, "server_not_found", "Server not found");
      }
      return detailOf(row, request.user!);
    },
  );

  app.get(
    "/:id",
    {
      config: { mcp: { action: "servers.get", summary: "Il dettaglio di un server: ambienti, servizi, ultimo campione, avvisi.", effect: "read" }, access: { kind: "user" } },
      schema: {
        params: idParamsSchema,
        response: { 200: serverDetailSchema, 404: errorSchema, ...authErrorResponses },
      },
    },
    async (request, reply) => {
      // Un server non visibile risponde 404 come uno inesistente.
      if (!(await canViewServer(app.db, request.user!, request.params.id))) {
        return apiError(reply, 404, "server_not_found", "Server not found");
      }
      const [row] = await app.db.select().from(servers).where(eq(servers.id, request.params.id));
      if (!row) return apiError(reply, 404, "server_not_found", "Server not found");
      return detailOf(row, request.user!);
    },
  );

  app.patch(
    "/:id",
    {
      config: { mcp: { action: "servers.update", summary: "Modifica un server: nome, intervallo dei campioni, progetti, soglie degli avvisi.", effect: "write", note: "Cambiare i progetti cambia CHI vede il server e riceve i suoi avvisi." }, access: { kind: "instance", permission: "monitor.manage" } },
      schema: {
        params: idParamsSchema,
        body: updateServerSchema,
        response: {
          200: serverViewSchema,
          404: errorSchema,
          422: errorSchema,
          ...authErrorResponses,
        },
      },
    },
    async (request, reply) => {
      const now = new Date();
      // `projectIds` (area 8, F4a-4 = b): si accetta ancora (un web in cache non
      // deve rompersi) ma si IGNORA — i progetti di un server sono quelli dei
      // suoi ambienti. `server_projects` resta inerte per il rollback.
      const { name, sampleIntervalSeconds, alertThresholds } = request.body;

      const updates: Partial<ServerRow> = {};
      if (name !== undefined) updates.name = name;
      if (sampleIntervalSeconds !== undefined) updates.sampleIntervalSeconds = sampleIntervalSeconds;
      // alertThresholds è full-replacement (contratto A1): lo schema shared ha
      // già applicato i default sui campi omessi.
      if (alertThresholds !== undefined) updates.alertThresholds = alertThresholds;

      const [applied] =
        Object.keys(updates).length > 0
          ? await app.db.update(servers).set(updates).where(eq(servers.id, request.params.id)).returning()
          : await app.db.select().from(servers).where(eq(servers.id, request.params.id));
      if (!applied) return apiError(reply, 404, "server_not_found", "Server not found");
      const agg = await loadAggregates(app, [applied.id], await legacyScope(app.db, await visibleProjectIds(app.db, request.user!)));
      return toServerView(applied, agg.get(applied.id)!, now);
    },
  );

  app.post(
    "/:id/regenerate-key",
    {
      config: { mcp: { exclude: "secret_once" }, access: { kind: "instance", permission: "monitor.manage" } },
      schema: {
        params: idParamsSchema,
        response: { 200: serverWithKeySchema, 404: errorSchema, ...authErrorResponses },
      },
    },
    async (request, reply) => {
      const now = new Date();
      const key = generateServerKey();
      const [updated] = await app.db
        .update(servers)
        .set({ keyHash: hashServerKey(key) })
        .where(eq(servers.id, request.params.id))
        .returning();
      if (!updated) return apiError(reply, 404, "server_not_found", "Server not found");
      const agg = await loadAggregates(app, [updated.id], await legacyScope(app.db, await visibleProjectIds(app.db, request.user!)));
      return { ...toServerView(updated, agg.get(updated.id)!, now), key, ingestUrl: ingestUrlOf() };
    },
  );

  app.delete(
    "/:id",
    {
      config: { mcp: { action: "servers.delete", summary: "Elimina un server con metriche, controlli e storia: l'agente non può più scrivere.", effect: "destructive", note: "Non si ritira: metriche e storia si perdono per tutti." }, access: { kind: "instance", permission: "monitor.manage" } },
      schema: {
        params: idParamsSchema,
        response: { 204: z.null(), 404: errorSchema, ...authErrorResponses },
      },
    },
    async (request, reply) => {
      // Cascade DB su server_metrics, service_checks (e con essi check_samples)
      // e server_projects: nessuna guardia, coerente con lo schema.
      const [deleted] = await app.db
        .delete(servers)
        .where(eq(servers.id, request.params.id))
        .returning({ id: servers.id });
      if (!deleted) return apiError(reply, 404, "server_not_found", "Server not found");
      return reply.code(204).send(null);
    },
  );
}
