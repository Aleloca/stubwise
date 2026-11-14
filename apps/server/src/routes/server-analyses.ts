import { environmentServers, projectEnvironments, serverAnalyses, servers, users } from "@stubwise/db";
import { serverAnalysisViewSchema, type ServerAnalysisView } from "@stubwise/shared";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { projectPermissionsFor } from "../auth/access.js";
import { canViewServer } from "../auth/monitor-access.js";
import { apiError } from "../errors.js";
import { authErrorResponses, errorSchema, isUniqueViolation } from "./shared.js";

/**
 * L'analisi A MANO di un server (area 8, F4b, S5;
 * docs/invariants/server-operations.md). La chiede chi ha `servers.operate`
 * in un progetto il cui ambiente usa il server (nessun preset lo concede; un
 * full admin lo ha ovunque). Qui si mette in coda e basta: il run, i tetti e
 * il budget li controlla il worker. Una per server alla volta (indice unico).
 */

const idParamsSchema = z.object({ id: z.uuid() });

const nameOf = (u: { displayName: string | null; email: string }) => u.displayName?.trim() || u.email.split("@")[0]!;

export async function serverAnalysisRoutes(instance: FastifyInstance): Promise<void> {
  const app = instance.withTypeProvider<ZodTypeProvider>();

  app.post(
    "/:id/analyses",
    {
      // Il permesso è di PROGETTO, ma il progetto lo dà il server: si calcola qui sotto.
      config: { access: { kind: "user" } },
      schema: { params: idParamsSchema, response: { 202: serverAnalysisViewSchema, 404: errorSchema, 409: errorSchema, ...authErrorResponses } },
    },
    async (request, reply) => {
      const user = request.user!;
      const serverId = request.params.id;
      const [server] = await app.db.select({ id: servers.id }).from(servers).where(eq(servers.id, serverId));
      // Inesistente = invisibile (nessun oracolo).
      if (!server || !(await canViewServer(app.db, user, serverId))) return apiError(reply, 404, "not_found", "Server not found");
      const projectIds = [
        ...new Set(
          (
            await app.db
              .select({ projectId: projectEnvironments.projectId })
              .from(environmentServers)
              .innerJoin(projectEnvironments, eq(projectEnvironments.id, environmentServers.environmentId))
              .where(eq(environmentServers.serverId, serverId))
          ).map((r) => r.projectId),
        ),
      ];
      let visibleInAProject = false;
      let operate = false;
      for (const projectId of projectIds) {
        const perms = await projectPermissionsFor(app.db, user, projectId);
        if (perms) visibleInAProject = true;
        if (perms?.has("servers.operate")) operate = true;
      }
      if (!visibleInAProject) return apiError(reply, 404, "not_found", "Server not found");
      if (!operate) return apiError(reply, 403, "forbidden", "Starting an analysis needs servers.operate in a project of this server");
      let row: typeof serverAnalyses.$inferSelect;
      try {
        [row] = (await app.db.insert(serverAnalyses).values({ serverId, startedByUserId: user.id }).returning()) as [typeof serverAnalyses.$inferSelect];
      } catch (error) {
        if (isUniqueViolation(error)) return apiError(reply, 409, "analysis_running", "An analysis of this server is already running");
        throw error;
      }
      const [me] = await app.db.select({ displayName: users.displayName, email: users.email }).from(users).where(eq(users.id, user.id));
      const view: ServerAnalysisView = {
        id: row.id,
        serverId,
        episodeId: null,
        status: "running",
        startedBy: me ? { id: user.id, name: nameOf(me) } : null,
        diagnosis: null,
        attribution: null,
        taskCode: null,
        blockedBy: null,
        startedAt: row.startedAt.toISOString(),
        finishedAt: null,
      };
      return reply.code(202).send(view);
    },
  );
}
