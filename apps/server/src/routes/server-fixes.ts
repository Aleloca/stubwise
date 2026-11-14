import { projects, serverCommands, serverFixes, serverOperationApprovals, servers, users, type Db } from "@stubwise/db";
import { attributionContext, cancelServerCommands } from "@stubwise/notifications";
import { serverFixViewSchema, validateServerPlan, type ServerFixView } from "@stubwise/shared";
import { and, eq, inArray } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { routePermissions, visibleProjectIds, type RouteAccess } from "../auth/access.js";
import { fromTicket, ticketVisible } from "../auth/project-resolvers.js";
import type { SessionUser } from "../auth/session.js";
import { apiError } from "../errors.js";
import { authErrorResponses, errorSchema } from "./shared.js";

/**
 * La CORREZIONE di una task di server (area 8, F4b, S6;
 * docs/invariants/server-operations.md). Il piano sta in `server_fixes`, mai
 * nel piano del ticket.
 * - La legge chi vede la task. Un piano nuovo lo chiede chi ha
 *   `servers.operate` NEL PROGETTO DELLA TASK.
 * - Approva o rifiuta SOLO chi ha `plans.approve` NEL PROGETTO DELLA TASK
 *   (rotta E servizio), anche se il piano l'ha chiesto lui; nessuna
 *   pre-approvazione. All'approvazione il piano si RIVALIDA sullo stato di
 *   adesso (container visti e legati al progetto): uno stantio → 409.
 * - Lo Stop (`servers.operate` o `plans.approve` nel progetto) ferma la
 *   correzione, revoca l'approvazione e porta a `cancelled` i comandi non
 *   consegnati.
 * - F4b-8 = c: una pulizia (`docker.prune`) agisce su TUTTO il server; la
 *   vista dice quali ALTRI progetti tocca, prima dell'approvazione.
 */

const params = z.object({ ticketId: z.uuid() });
const onTask = (permission: "member" | "plans.approve" | "servers.operate"): RouteAccess => ({
  kind: "project",
  permission,
  project: fromTicket("ticketId"),
  resource: ticketVisible("ticketId"),
});

type Fix = typeof serverFixes.$inferSelect;
const OPEN_FOR_REQUEST = new Set<Fix["status"]>(["none", "failed", "rejected", "done", "stopped", "awaiting_approval"]);
const STOPPABLE = new Set<Fix["status"]>(["proposing", "approved", "running"]);

const nameOf = (u: { displayName: string | null; email: string }) => u.displayName?.trim() || u.email.split("@")[0]!;

async function userRef(db: Db, id: string | null) {
  if (!id) return null;
  const [u] = await db.select({ displayName: users.displayName, email: users.email }).from(users).where(eq(users.id, id));
  return u ? { id, name: nameOf(u) } : null;
}

async function pruneWarning(db: Db, user: SessionUser, fix: Fix): Promise<ServerFixView["pruneWarning"]> {
  if (!fix.steps.some((s) => s.action === "docker.prune")) return null;
  const ctx = await attributionContext(db, fix.serverId);
  const others = ctx.serverProjects.filter((p) => p.projectId !== fix.projectId).map((p) => p.projectId);
  if (others.length === 0) return { projects: [], hiddenCount: 0 };
  const visible = await visibleProjectIds(db, user);
  const seen = visible === "all" ? others : others.filter((id) => visible.includes(id));
  const names = seen.length === 0 ? [] : (await db.select({ name: projects.name }).from(projects).where(inArray(projects.id, seen))).map((p) => p.name).sort();
  return { projects: names, hiddenCount: others.length - seen.length };
}

async function viewOf(db: Db, user: SessionUser, perms: ReadonlySet<string>, fix: Fix): Promise<ServerFixView> {
  const [server] = await db.select({ number: servers.number, caps: servers.agentCapabilities }).from(servers).where(eq(servers.id, fix.serverId));
  const commandIds = Object.values(fix.stepCommands);
  const commands = commandIds.length === 0 ? [] : await db.select({ id: serverCommands.id, status: serverCommands.status }).from(serverCommands).where(inArray(serverCommands.id, commandIds));
  const statusOf = new Map(commands.map((c) => [c.id, c.status]));
  const approval = fix.approvalId ? (await db.select().from(serverOperationApprovals).where(eq(serverOperationApprovals.id, fix.approvalId)))[0] : undefined;
  const approvedBy = approval ? await userRef(db, approval.approvedByUserId) : null;
  const rejectedBy = await userRef(db, fix.rejectedByUserId);
  const operationsOn = server?.caps.operations === true;
  return {
    taskId: fix.taskId,
    serverId: fix.serverId,
    serverCode: server ? `SRV-${server.number}` : null,
    status: fix.status,
    steps: fix.steps.map((s, index) => {
      const commandId = fix.stepCommands[String(index)] ?? null;
      const c = commandId ? statusOf.get(commandId) : undefined;
      const status =
        c === "done" ? "done" : c === "failed" || c === "expired" ? "failed" : c === "cancelled" ? "skipped" : c ? "running" : fix.status === "stopped" || fix.status === "failed" ? "skipped" : "waiting";
      return { index, action: s.action, params: s.params, why: s.why, status, commandId };
    }),
    approval: approval && approvedBy ? { by: approvedBy, at: approval.approvedAt.toISOString() } : null,
    rejection: fix.rejectedAt && rejectedBy ? { by: rejectedBy, at: fix.rejectedAt.toISOString(), note: fix.rejectionNote ?? "" } : null,
    operationsOn,
    canRequestPlan: perms.has("servers.operate") && operationsOn && OPEN_FOR_REQUEST.has(fix.status),
    canApprove: perms.has("plans.approve") && fix.status === "awaiting_approval",
    canStop: (perms.has("servers.operate") || perms.has("plans.approve")) && STOPPABLE.has(fix.status),
    planError: fix.planError,
    pruneWarning: await pruneWarning(db, user, fix),
  };
}

export async function serverFixRoutes(instance: FastifyInstance): Promise<void> {
  const app = instance.withTypeProvider<ZodTypeProvider>();
  const fixOf = async (ticketId: string) => (await app.db.select().from(serverFixes).where(eq(serverFixes.taskId, ticketId)))[0];
  const response = { 200: serverFixViewSchema, 404: errorSchema, 409: errorSchema, ...authErrorResponses };

  app.get("/:ticketId/server-fix", { config: { access: onTask("member") }, schema: { params, response } }, async (request, reply) => {
    const fix = await fixOf(request.params.ticketId);
    if (!fix) return apiError(reply, 404, "not_found", "This task has no server correction");
    return viewOf(app.db, request.user!, routePermissions(request), fix);
  });

  // Un piano NUOVO: lo propone una sessione `server_fix` nel worker (sole letture + propose_server_plan).
  app.post("/:ticketId/server-fix", { config: { access: onTask("servers.operate") }, schema: { params, response } }, async (request, reply) => {
    const perms = routePermissions(request);
    if (!perms.has("servers.operate")) return apiError(reply, 403, "forbidden", "Asking for a plan needs servers.operate in this project");
    const fix = await fixOf(request.params.ticketId);
    if (!fix) return apiError(reply, 404, "not_found", "This task has no server correction");
    const [server] = await app.db.select({ caps: servers.agentCapabilities }).from(servers).where(eq(servers.id, fix.serverId));
    if (server?.caps.operations !== true) return apiError(reply, 409, "operations_off", "The agent on this server has operations turned off");
    const updated = await app.db
      .update(serverFixes)
      .set({ status: "proposing", steps: [], planError: null, approvalId: null, currentStep: null, stepCommands: {}, requestedByUserId: request.user!.id, rejectedAt: null, rejectedByUserId: null, rejectionNote: null, updatedAt: new Date(), finishedAt: null })
      .where(and(eq(serverFixes.id, fix.id), inArray(serverFixes.status, [...OPEN_FOR_REQUEST])))
      .returning();
    if (updated.length === 0) return apiError(reply, 409, "fix_busy", "A plan is being proposed or run: stop it first");
    return viewOf(app.db, request.user!, perms, updated[0]!);
  });

  app.post("/:ticketId/server-fix/approve", { config: { access: onTask("plans.approve") }, schema: { params, response } }, async (request, reply) => {
    const perms = routePermissions(request);
    // Difesa in profondità, come resolvePlan: il permesso NEL PROGETTO DELLA TASK.
    if (!perms.has("plans.approve")) return apiError(reply, 403, "forbidden", "Approving needs plans.approve in this project");
    const fix = await fixOf(request.params.ticketId);
    if (!fix) return apiError(reply, 404, "not_found", "This task has no server correction");
    if (fix.status !== "awaiting_approval") return apiError(reply, 409, "not_awaiting_approval", "There is no plan waiting for approval");
    // Il piano si RIVALIDA sullo stato di adesso: un container slegato o sparito → stantio.
    const ctx = await attributionContext(app.db, fix.serverId);
    const check = validateServerPlan({ plan: { steps: fix.steps }, projectId: fix.projectId, serverProjects: ctx.serverProjects, seenContainers: ctx.seenContainers });
    if (!check.ok) return apiError(reply, 409, "plan_stale", `The plan no longer holds (${check.reason}): ask for a new one`);
    const approved = await app.db.transaction(async (tx) => {
      const [approval] = await tx
        .insert(serverOperationApprovals)
        .values({ serverId: fix.serverId, taskId: fix.taskId, sessionId: fix.sessionId, steps: check.plan.steps, approvedByUserId: request.user!.id })
        .returning();
      return tx
        .update(serverFixes)
        .set({ status: "approved", approvalId: approval!.id, updatedAt: new Date() })
        .where(and(eq(serverFixes.id, fix.id), eq(serverFixes.status, "awaiting_approval")))
        .returning();
    });
    if (approved.length === 0) return apiError(reply, 409, "not_awaiting_approval", "There is no plan waiting for approval");
    return viewOf(app.db, request.user!, perms, approved[0]!);
  });

  app.post(
    "/:ticketId/server-fix/reject",
    { config: { access: onTask("plans.approve") }, schema: { params, body: z.strictObject({ note: z.string().max(4000).default("") }), response } },
    async (request, reply) => {
      const perms = routePermissions(request);
      if (!perms.has("plans.approve")) return apiError(reply, 403, "forbidden", "Rejecting needs plans.approve in this project");
      const fix = await fixOf(request.params.ticketId);
      if (!fix) return apiError(reply, 404, "not_found", "This task has no server correction");
      const updated = await app.db
        .update(serverFixes)
        .set({ status: "rejected", rejectedByUserId: request.user!.id, rejectedAt: new Date(), rejectionNote: request.body.note, updatedAt: new Date(), finishedAt: new Date() })
        .where(and(eq(serverFixes.id, fix.id), eq(serverFixes.status, "awaiting_approval")))
        .returning();
      if (updated.length === 0) return apiError(reply, 409, "not_awaiting_approval", "There is no plan waiting for approval");
      return viewOf(app.db, request.user!, perms, updated[0]!);
    },
  );

  // Lo Stop: servers.operate O plans.approve nel progetto (la rotta chiede `member`, il controllo è qui).
  app.post("/:ticketId/server-fix/stop", { config: { access: onTask("member") }, schema: { params, response } }, async (request, reply) => {
    const perms = routePermissions(request);
    if (!perms.has("servers.operate") && !perms.has("plans.approve")) return apiError(reply, 403, "forbidden", "Stopping needs servers.operate or plans.approve in this project");
    const fix = await fixOf(request.params.ticketId);
    if (!fix) return apiError(reply, 404, "not_found", "This task has no server correction");
    const stopped = await app.db.transaction(async (tx) => {
      const rows = await tx
        .update(serverFixes)
        .set({ status: "stopped", stoppedByUserId: request.user!.id, updatedAt: new Date(), finishedAt: new Date() })
        .where(and(eq(serverFixes.id, fix.id), inArray(serverFixes.status, [...STOPPABLE])))
        .returning();
      if (rows.length === 0) return rows;
      if (fix.approvalId) {
        await tx.update(serverOperationApprovals).set({ revokedAt: new Date() }).where(eq(serverOperationApprovals.id, fix.approvalId));
        await cancelServerCommands(tx as unknown as Db, { approvalId: fix.approvalId });
      }
      return rows;
    });
    if (stopped.length === 0) return apiError(reply, 409, "not_running", "Nothing to stop");
    return viewOf(app.db, request.user!, perms, stopped[0]!);
  });
}
