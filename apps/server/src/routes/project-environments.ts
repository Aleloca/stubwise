import { environmentServers, projectEnvironments, releases, repositories, serverMetrics, servers } from "@stubwise/db";
import {
  createEnvironmentSchema,
  patchEnvironmentSchema,
  projectEnvironmentSchema,
  sameCommit,
  type DiscoveredService,
  type ProjectEnvironment,
} from "@stubwise/shared";
import { and, asc, desc, eq, inArray, ne } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import type { RouteAccess } from "../auth/access.js";
import { fromParam } from "../auth/project-resolvers.js";
import { apiError } from "../errors.js";
import { loadLatestServicesByServer } from "../services/server-samples.js";
import { authErrorResponses, errorSchema, isUniqueViolation, uniqueViolationConstraint } from "./shared.js";

const projectParamsSchema = z.object({ projectId: z.uuid() });
const environmentParamsSchema = z.object({ projectId: z.uuid(), environmentId: z.uuid() });

type EnvironmentRow = typeof projectEnvironments.$inferSelect;

/**
 * Un ambiente collegato a un server sa dire cosa gira lì SOLO per
 * convenzione: il servizio (container Docker/processo PM2) con lo STESSO
 * nome dell'ambiente. Non è un accoppiamento che Stubwise impone — è il
 * pattern naturale di chi chiama il proprio servizio "staging"/"production"
 * come l'ambiente in cui gira; senza quel match, i due campi restano assenti
 * (mai un errore, mai un dato indovinato).
 */
function toPublic(
  row: EnvironmentRow,
  servicesByServer: Map<string, DiscoveredService[]> = new Map(),
  servers: { repositoryId: string; serverId: string }[] = [],
): ProjectEnvironment {
  const running = row.serverId
    ? servicesByServer.get(row.serverId)?.find((s) => s.name === row.name)
    : undefined;
  return {
    id: row.id,
    projectId: row.projectId,
    name: row.name,
    kind: row.kind,
    url: row.url,
    serverId: row.serverId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    ...(running?.image !== undefined ? { runningImage: running.image } : {}),
    ...(running?.commitSha !== undefined ? { runningCommitSha: running.commitSha } : {}),
    servers,
  };
}

/**
 * Ambienti di un progetto (test | staging | production), sotto
 * /api/projects/:projectId/environments. Lettura a chi vede il progetto; tutte
 * le scritture `environments.manage` nel progetto.
 *
 * Stubwise non esegue né rilascia ambienti (design fase 8 §1/§6): questa è
 * pura anagrafica — dove sta un ambiente, cosa ci gira (letto dall'agente di
 * monitoraggio, Task 4). L'unico ambiente che la pipeline di fix può mai
 * materializzare in un worktree resta `test` (invariante di
 * `apps/worker/src/pipeline/env-files.ts`), indipendentemente da cosa questa
 * rotta permette di configurare.
 */
const READ_ACCESS: RouteAccess = { kind: "project", permission: "member", project: fromParam("projectId") };
const MANAGE_ACCESS: RouteAccess = {
  kind: "project",
  permission: "environments.manage",
  project: fromParam("projectId"),
};

export async function projectEnvironmentRoutes(instance: FastifyInstance): Promise<void> {
  const app = instance.withTypeProvider<ZodTypeProvider>();

  async function serverExists(serverId: string): Promise<boolean> {
    const [row] = await app.db.select({ id: servers.id }).from(servers).where(eq(servers.id, serverId));
    return row !== undefined;
  }

  /** I server per repository (R-L2) di un insieme di ambienti. */
  async function serversOf(environmentIds: string[]): Promise<Map<string, { repositoryId: string; serverId: string }[]>> {
    const out = new Map<string, { repositoryId: string; serverId: string }[]>();
    if (environmentIds.length === 0) return out;
    const rows = await app.db.select().from(environmentServers).where(inArray(environmentServers.environmentId, environmentIds));
    for (const r of rows) out.set(r.environmentId, [...(out.get(r.environmentId) ?? []), { repositoryId: r.repositoryId, serverId: r.serverId }]);
    return out;
  }

  /**
   * Scrive i server per repository di un ambiente (R-L2). `serverId` (la forma
   * di prima) vale per TUTTE le repository del progetto; `servers` vince per
   * le repository che nomina (`null` toglie). Le repository devono essere del
   * progetto e i server esistere: altrimenti 400, e niente scritto.
   */
  async function writeServers(
    tx: Parameters<Parameters<typeof app.db.transaction>[0]>[0],
    env: { id: string; projectId: string },
    input: { serverId?: string | null; servers?: { repositoryId: string; serverId: string | null }[] },
  ): Promise<"ok" | "bad_repository" | "server_not_found"> {
    const repos = await tx.select({ id: repositories.id }).from(repositories).where(eq(repositories.projectId, env.projectId));
    const repoIds = new Set(repos.map((r) => r.id));
    for (const sv of input.servers ?? []) if (!repoIds.has(sv.repositoryId)) return "bad_repository";
    const wanted = [...new Set([...(input.servers ?? []).flatMap((x) => (x.serverId ? [x.serverId] : [])), ...(input.serverId ? [input.serverId] : [])])];
    if (wanted.length > 0) {
      const found = await tx.select({ id: servers.id }).from(servers).where(inArray(servers.id, wanted));
      if (found.length !== wanted.length) return "server_not_found";
    }
    if (input.serverId !== undefined) {
      await tx.delete(environmentServers).where(eq(environmentServers.environmentId, env.id));
      if (input.serverId) {
        const sid = input.serverId;
        if (repoIds.size > 0) await tx.insert(environmentServers).values([...repoIds].map((repositoryId) => ({ environmentId: env.id, repositoryId, serverId: sid })));
      }
    }
    for (const sv of input.servers ?? []) {
      await tx.delete(environmentServers).where(and(eq(environmentServers.environmentId, env.id), eq(environmentServers.repositoryId, sv.repositoryId)));
      if (sv.serverId) await tx.insert(environmentServers).values({ environmentId: env.id, repositoryId: sv.repositoryId, serverId: sv.serverId });
    }
    return "ok";
  }

  /**
   * I campi in più dell'ELENCO (area 8, F1): per ogni riga repository→server
   * il nome del server, il commit riportato e il rilascio; per il progetto i
   * server che nessun altro progetto usa (R-L7).
   */
  async function listExtras(
    projectId: string,
    rows: EnvironmentRow[],
    byEnv: Map<string, { repositoryId: string; serverId: string }[]>,
  ): Promise<{ servers: Map<string, ProjectEnvironment["servers"]>; onlyHere: Set<string> }> {
    const pairs = rows.flatMap((r) => (byEnv.get(r.id) ?? []).map((s) => ({ env: r, ...s })));
    const serverIds = [...new Set(pairs.map((p) => p.serverId))];
    if (serverIds.length === 0) return { servers: new Map(), onlyHere: new Set() };
    const names = new Map((await app.db.select({ id: servers.id, name: servers.name }).from(servers).where(inArray(servers.id, serverIds))).map((s) => [s.id, s.name]));
    const samples = new Map(
      (
        await app.db
          .selectDistinctOn([serverMetrics.serverId], { serverId: serverMetrics.serverId, ts: serverMetrics.ts, services: serverMetrics.services })
          .from(serverMetrics)
          .where(inArray(serverMetrics.serverId, serverIds))
          .orderBy(serverMetrics.serverId, desc(serverMetrics.ts))
      ).map((s) => [s.serverId, s]),
    );
    const repoIds = [...new Set(pairs.map((p) => p.repositoryId))];
    const recent = await app.db
      .select({ repositoryId: releases.repositoryId, code: releases.code, mergeSha: releases.mergeSha })
      .from(releases)
      .where(inArray(releases.repositoryId, repoIds))
      .orderBy(desc(releases.mergedAt))
      .limit(500);
    const out = new Map<string, ProjectEnvironment["servers"]>();
    for (const p of pairs) {
      const sample = samples.get(p.serverId);
      const shas = (sample?.services ?? []).flatMap((s) => (s.commitSha ? [{ name: s.name, sha: s.commitSha }] : []));
      let reportedSha: string | null = null;
      let releaseCode: string | null = null;
      for (const rel of recent) {
        if (rel.repositoryId !== p.repositoryId) continue;
        const hit = shas.find((s) => sameCommit(s.sha, rel.mergeSha));
        if (hit) {
          reportedSha = hit.sha;
          releaseCode = rel.code;
          break;
        }
      }
      reportedSha ??= shas.find((s) => s.name === p.env.name)?.sha ?? null;
      const list = out.get(p.env.id) ?? [];
      list.push({
        repositoryId: p.repositoryId,
        serverId: p.serverId,
        ...(names.has(p.serverId) ? { serverName: names.get(p.serverId)! } : {}),
        reportedSha,
        reportedAt: sample ? sample.ts.toISOString() : null,
        releaseCode,
      });
      out.set(p.env.id, list);
    }
    // R-L7: i server che nessun ambiente di un ALTRO progetto usa.
    const usedElsewhere = new Set(
      (
        await app.db
          .selectDistinct({ serverId: environmentServers.serverId })
          .from(environmentServers)
          .innerJoin(projectEnvironments, eq(projectEnvironments.id, environmentServers.environmentId))
          .where(and(inArray(environmentServers.serverId, serverIds), ne(projectEnvironments.projectId, projectId)))
      ).map((r) => r.serverId),
    );
    return { servers: out, onlyHere: new Set(serverIds.filter((id) => !usedElsewhere.has(id))) };
  }

  async function findEnvironment(projectId: string, environmentId: string): Promise<EnvironmentRow | undefined> {
    const [row] = await app.db
      .select()
      .from(projectEnvironments)
      .where(and(eq(projectEnvironments.id, environmentId), eq(projectEnvironments.projectId, projectId)));
    return row;
  }

  app.get(
    "/:projectId/environments",
    {
      // Lettura per chi vede il progetto: sono un'anagrafica, non un segreto —
      // a differenza dei valori dei file d'ambiente (`repos.manage`). Solo le
      // scritture vogliono `environments.manage`.
      config: { access: READ_ACCESS },
      schema: {
        params: projectParamsSchema,
        response: { 200: z.array(projectEnvironmentSchema), 404: errorSchema, ...authErrorResponses },
      },
    },
    async (request) => {
      const { projectId } = request.params;
      const rows = await app.db
        .select()
        .from(projectEnvironments)
        .where(eq(projectEnvironments.projectId, projectId))
        .orderBy(asc(projectEnvironments.name));

      const serverIds = [...new Set(rows.flatMap((r) => (r.serverId ? [r.serverId] : [])))];
      const servicesByServer = await loadLatestServicesByServer(app.db, serverIds);
      const byEnv = await serversOf(rows.map((r) => r.id));
      const extras = await listExtras(projectId, rows, byEnv);
      const canManage = request.access?.permissions.has("environments.manage") === true;
      return rows.map((row) => ({
        ...toPublic(row, servicesByServer, extras.servers.get(row.id) ?? byEnv.get(row.id) ?? []),
        canManage,
        onlyHere: (byEnv.get(row.id) ?? []).map((s) => s.serverId).filter((id, i, all) => extras.onlyHere.has(id) && all.indexOf(id) === i),
      }));
    },
  );

  app.post(
    "/:projectId/environments",
    {
      config: { access: MANAGE_ACCESS },
      schema: {
        params: projectParamsSchema,
        body: createEnvironmentSchema,
        response: {
          201: projectEnvironmentSchema,
          400: errorSchema,
          404: errorSchema,
          409: errorSchema,
          ...authErrorResponses,
        },
      },
    },
    async (request, reply) => {
      const { projectId } = request.params;
      const { name, kind, url, serverId, servers: perRepo } = request.body;
      if (serverId && !(await serverExists(serverId))) {
        return apiError(reply, 400, "server_not_found", "Server not found");
      }
      try {
        const result = await app.db.transaction(async (tx) => {
          const [created] = await tx
            .insert(projectEnvironments)
            .values({ projectId, name, kind, url: url ?? null, serverId: serverId ?? null })
            .returning();
          if (!created) throw new Error("insert dell'ambiente non ha restituito la riga");
          const written = await writeServers(tx, created, { ...(serverId !== undefined ? { serverId } : {}), ...(perRepo ? { servers: perRepo } : {}) });
          if (written !== "ok") {
            tx.rollback();
          }
          return { created, written };
        }).catch((e: unknown) => {
          if (e instanceof Error && e.message === "Rollback") return null;
          throw e;
        });
        if (!result) return apiError(reply, 400, "bad_servers", "A repository is not in this project, or a server doesn't exist");
        const byEnv = await serversOf([result.created.id]);
        return await reply.code(201).send(toPublic(result.created, new Map(), byEnv.get(result.created.id) ?? []));
      } catch (error) {
        if (uniqueViolationConstraint(error) === "project_environments_one_production_idx") {
          return apiError(reply, 409, "production_environment_exists", "This project already has a production environment — only one is allowed");
        }
        // Due vincoli unique distinti su questa tabella (fase 8, review fix
        // Task 3): il nome per progetto, e — solo per kind='test' — al più
        // UN ambiente di quel kind per progetto. Un client che manda un
        // nome nuovo ma kind='test' su un progetto che ce l'ha già
        // riceverebbe "nome già in uso" dal ramo generico sotto, che è
        // semplicemente falso: distinguere per nome del vincolo dà il
        // messaggio giusto invece di lasciare che una violazione di indice
        // emerga con un errore che mente sulla causa.
        if (uniqueViolationConstraint(error) === "project_environments_project_id_test_unique") {
          return apiError(
            reply,
            409,
            "test_environment_exists",
            "This project already has a test environment — only one is allowed",
          );
        }
        if (isUniqueViolation(error)) {
          return apiError(
            reply,
            409,
            "environment_name_conflict",
            "An environment with this name already exists on this project",
          );
        }
        throw error;
      }
    },
  );

  app.patch(
    "/:projectId/environments/:environmentId",
    {
      config: { access: MANAGE_ACCESS },
      schema: {
        params: environmentParamsSchema,
        body: patchEnvironmentSchema,
        response: {
          200: projectEnvironmentSchema,
          400: errorSchema,
          404: errorSchema,
          409: errorSchema,
          ...authErrorResponses,
        },
      },
    },
    async (request, reply) => {
      const { projectId, environmentId } = request.params;
      const existing = await findEnvironment(projectId, environmentId);
      if (!existing) return apiError(reply, 404, "environment_not_found", "Environment not found");

      const { name, url, serverId, servers: perRepo } = request.body;
      if (serverId && !(await serverExists(serverId))) {
        return apiError(reply, 400, "server_not_found", "Server not found");
      }
      // PATCH: campi assenti restano invariati (undefined non sovrascrive);
      // `url`/`serverId` possono però essere esplicitamente azzerati con `null`.
      const patch: Partial<typeof projectEnvironments.$inferInsert> = {};
      if (name !== undefined) patch.name = name;
      if (url !== undefined) patch.url = url;
      if (serverId !== undefined) patch.serverId = serverId;

      try {
        const result = await app.db
          .transaction(async (tx) => {
            const [updated] = Object.keys(patch).length > 0
              ? await tx.update(projectEnvironments).set(patch).where(eq(projectEnvironments.id, environmentId)).returning()
              : [existing];
            if (!updated) throw new Error("update dell'ambiente non ha restituito la riga");
            if (serverId !== undefined || perRepo) {
              const written = await writeServers(tx, updated, { ...(serverId !== undefined ? { serverId } : {}), ...(perRepo ? { servers: perRepo } : {}) });
              if (written !== "ok") tx.rollback();
            }
            return updated;
          })
          .catch((e: unknown) => {
            if (e instanceof Error && e.message === "Rollback") return null;
            throw e;
          });
        if (!result) return apiError(reply, 400, "bad_servers", "A repository is not in this project, or a server doesn't exist");
        const byEnv = await serversOf([result.id]);
        return toPublic(result, new Map(), byEnv.get(result.id) ?? []);
      } catch (error) {
        if (isUniqueViolation(error)) {
          return apiError(
            reply,
            409,
            "environment_name_conflict",
            "An environment with this name already exists on this project",
          );
        }
        throw error;
      }
    },
  );

  app.delete(
    "/:projectId/environments/:environmentId",
    {
      config: { access: MANAGE_ACCESS },
      schema: {
        params: environmentParamsSchema,
        response: { 204: z.null(), 404: errorSchema, 409: errorSchema, ...authErrorResponses },
      },
    },
    async (request, reply) => {
      const { projectId, environmentId } = request.params;
      const existing = await findEnvironment(projectId, environmentId);
      if (!existing) return apiError(reply, 404, "environment_not_found", "Environment not found");

      // L'ambiente `test` non si cancella dalla UI: è quello che la migrazione
      // 0074 garantisce a ogni progetto e l'unico che la pipeline di fix può
      // leggere — cancellarlo lascerebbe i file d'ambiente esistenti orfani
      // (cascade) e il progetto senza un target valido per il fix.
      if (existing.kind === "test") {
        return apiError(
          reply,
          409,
          "test_environment_immutable",
          "The test environment cannot be deleted",
        );
      }

      // Le var/file d'ambiente collegati sono cancellati in cascata dal FK.
      await app.db.delete(projectEnvironments).where(eq(projectEnvironments.id, environmentId));
      return reply.code(204).send(null);
    },
  );
}
