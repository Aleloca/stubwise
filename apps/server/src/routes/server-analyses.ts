import { environmentServers, projectEnvironments, serverAnalyses, serverCommands, servers, users } from "@stubwise/db";
import { serverAnalysisViewSchema, serverCommandViewSchema, type ServerAnalysisView, type ServerCommandView } from "@stubwise/shared";
import { and, desc, eq, lt } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { projectPermissionsFor } from "../auth/access.js";
import type { SessionUser } from "../auth/session.js";
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

/**
 * Chi può operare su un server: `visible` (lo vede), `visibleInAProject` (è
 * membro di un progetto che lo usa), `operate` (ha `servers.operate` in uno di
 * quei progetti). Un server inesistente è invisibile.
 */
export async function operatorAccess(
  app: FastifyInstance,
  user: SessionUser,
  serverId: string,
): Promise<{ visible: boolean; visibleInAProject: boolean; operate: boolean }> {
  const [server] = await app.db.select({ id: servers.id }).from(servers).where(eq(servers.id, serverId));
  if (!server || !(await canViewServer(app.db, user, serverId))) return { visible: false, visibleInAProject: false, operate: false };
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
  return { visible: true, visibleInAProject, operate };
}

const listQuerySchema = z.object({ before: z.iso.datetime().optional(), limit: z.coerce.number().int().min(1).max(200).default(50) });

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
      const access = await operatorAccess(app, user, serverId);
      if (access.visibleInAProject === false || access.visible === false) return apiError(reply, 404, "not_found", "Server not found");
      if (!access.operate) return apiError(reply, 403, "forbidden", "Starting an analysis needs servers.operate in a project of this server");
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

  // S8: il registro dei comandi e delle letture di un server, dal più recente.
  // Lo legge chi ha `servers.operate` in un progetto del server, più chi ha
  // `monitor.manage` (docs/invariants/server-operations.md, «Il registro»).
  app.get(
    "/:id/operations",
    {
      config: { access: { kind: "user" } },
      schema: {
        params: idParamsSchema,
        querystring: listQuerySchema,
        response: { 200: z.object({ commands: z.array(serverCommandViewSchema) }), 404: errorSchema, ...authErrorResponses },
      },
    },
    async (request, reply) => {
      const user = request.user!;
      const serverId = request.params.id;
      const access = await operatorAccess(app, user, serverId);
      if (!access.visible) return apiError(reply, 404, "not_found", "Server not found");
      if (!access.operate && !user.instancePermissions.has("monitor.manage")) {
        return apiError(reply, 403, "forbidden", "The operations log needs servers.operate in a project of this server, or monitor.manage");
      }
      const { before, limit } = request.query;
      const rows = await app.db
        .select({ c: serverCommands, displayName: users.displayName, email: users.email })
        .from(serverCommands)
        .leftJoin(users, eq(users.id, serverCommands.requestedByUserId))
        .where(and(eq(serverCommands.serverId, serverId), ...(before ? [lt(serverCommands.issuedAt, new Date(before))] : [])))
        .orderBy(desc(serverCommands.issuedAt))
        .limit(limit);
      const commands: ServerCommandView[] = rows.map(({ c, displayName, email }) => ({
        id: c.id,
        action: c.action,
        params: c.params,
        kind: c.kind,
        via: c.via,
        status: c.status,
        requestedBy: c.requestedByUserId && email ? { id: c.requestedByUserId, name: nameOf({ displayName, email }) } : null,
        approvalId: c.approvalId,
        issuedAt: c.issuedAt.toISOString(),
        finishedAt: c.finishedAt?.toISOString() ?? null,
        exitCode: c.exitCode,
        output: c.output,
      }));
      return { commands };
    },
  );
}
