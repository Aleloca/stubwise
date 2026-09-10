import { projectEnvironments, projects, servers } from "@stubwise/db";
import {
  createEnvironmentSchema,
  patchEnvironmentSchema,
  projectEnvironmentSchema,
  type DiscoveredService,
  type ProjectEnvironment,
} from "@stubwise/shared";
import { and, asc, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { requireAdmin, requireAuth } from "../auth/session.js";
import { apiError } from "../errors.js";
import { loadLatestServicesByServer } from "../services/server-samples.js";
import { authErrorResponses, errorSchema, isUniqueViolation } from "./shared.js";

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
  };
}

/**
 * Ambienti di un progetto (test | staging | production), sotto
 * /api/projects/:projectId/environments. Tutte le scritture solo admin, come
 * le altre configurazioni di progetto (plugin, routing email).
 *
 * Stubwise non esegue né rilascia ambienti (design fase 8 §1/§6): questa è
 * pura anagrafica — dove sta un ambiente, cosa ci gira (letto dall'agente di
 * monitoraggio, Task 4). L'unico ambiente che la pipeline di fix può mai
 * materializzare in un worktree resta `test` (invariante di
 * `apps/worker/src/pipeline/env-files.ts`), indipendentemente da cosa questa
 * rotta permette di configurare.
 */
export async function projectEnvironmentRoutes(instance: FastifyInstance): Promise<void> {
  const app = instance.withTypeProvider<ZodTypeProvider>();

  async function projectExists(projectId: string): Promise<boolean> {
    const [row] = await app.db.select({ id: projects.id }).from(projects).where(eq(projects.id, projectId));
    return row !== undefined;
  }

  async function serverExists(serverId: string): Promise<boolean> {
    const [row] = await app.db.select({ id: servers.id }).from(servers).where(eq(servers.id, serverId));
    return row !== undefined;
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
      // Lettura per ogni utente autenticato (come i server del progetto): sono
      // un'anagrafica, non un segreto — a differenza dei valori dei file
      // d'ambiente, che restano admin-only. Solo le scritture sono requireAdmin.
      preHandler: requireAuth,
      schema: {
        params: projectParamsSchema,
        response: { 200: z.array(projectEnvironmentSchema), 404: errorSchema, ...authErrorResponses },
      },
    },
    async (request, reply) => {
      const { projectId } = request.params;
      if (!(await projectExists(projectId))) {
        return apiError(reply, 404, "project_not_found", "Project not found");
      }
      const rows = await app.db
        .select()
        .from(projectEnvironments)
        .where(eq(projectEnvironments.projectId, projectId))
        .orderBy(asc(projectEnvironments.name));

      const serverIds = [...new Set(rows.flatMap((r) => (r.serverId ? [r.serverId] : [])))];
      const servicesByServer = await loadLatestServicesByServer(app.db, serverIds);
      return rows.map((row) => toPublic(row, servicesByServer));
    },
  );

  app.post(
    "/:projectId/environments",
    {
      preHandler: requireAdmin,
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
      if (!(await projectExists(projectId))) {
        return apiError(reply, 404, "project_not_found", "Project not found");
      }
      const { name, kind, url, serverId } = request.body;
      if (serverId && !(await serverExists(serverId))) {
        return apiError(reply, 400, "server_not_found", "Server not found");
      }
      try {
        const [created] = await app.db
          .insert(projectEnvironments)
          .values({ projectId, name, kind, url: url ?? null, serverId: serverId ?? null })
          .returning();
        if (!created) throw new Error("insert dell'ambiente non ha restituito la riga");
        return await reply.code(201).send(toPublic(created));
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

  app.patch(
    "/:projectId/environments/:environmentId",
    {
      preHandler: requireAdmin,
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

      const { name, url, serverId } = request.body;
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
        const [updated] = await app.db
          .update(projectEnvironments)
          .set(patch)
          .where(eq(projectEnvironments.id, environmentId))
          .returning();
        if (!updated) throw new Error("update dell'ambiente non ha restituito la riga");
        return toPublic(updated);
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
      preHandler: requireAdmin,
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
