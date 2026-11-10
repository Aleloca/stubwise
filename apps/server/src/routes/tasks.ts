import {
  aiJobs,
  repositories,
  ticketRepositories,
  tickets,
  projects,
} from "@stubwise/db";
import {
  decisionRequestViewSchema,
  isoWeekSchema,
  newTaskBodySchema,
  stalledTaskViewSchema,
  taskPatchSchema,
  taskSizeSchema,
  taskActivityEntryViewSchema,
  taskListQuerySchema,
  taskListResponseSchema,
  taskViewSchema,
  taskWorkViewSchema,
  type TaskWorkView,
  taskDeleteBusySchema,
  taskDeletionPreviewSchema,
} from "@stubwise/shared";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import type { FastifyInstance, FastifyReply } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { routePermissions, type RouteAccess } from "../auth/access.js";
import { fromBody, fromTicket, ticketVisible } from "../auth/project-resolvers.js";
import { apiError } from "../errors.js";
import {
  claudeStateOf,
  loadTaskViews,
  serverToday,
  stallsOf,
  taskFilterConditions,
  TASK_LIST_CAP,
} from "../services/task-view.js";
import { askDecision } from "../services/decisions.js";
import { taskActivity } from "../services/task-activity.js";
import {
  bulkUpdateTasks,
  createTask,
  planTask,
  setFollowing,
  setManualStall,
  updateTask,
  type TaskWriteError,
} from "../services/task-writes.js";
import { authErrorResponses, errorSchema } from "./shared.js";
import { loadTaskWorkExtras } from "../services/task-work.js";
import { cancelRun } from "../services/cancel-run.js";
import { claudeStart } from "../services/claude-assign.js";
import { deleteTask, taskDeletionPreview } from "../services/task-delete.js";

/**
 * `/api/tasks` (integrazione area 2, fetta 1): le task nella forma del
 * prototipo per l'app nuova. Le letture filtrano per visibilità nella WHERE
 * (`loadTaskViews`), e una task invisibile risponde 404 `not_found` come una
 * che non esiste. Web vecchio, mobile e MCP continuano a usare `/api/tickets`.
 */

const onTicket = (permission: "member" | "tickets.edit" | "tickets.comment" | "runs.start" = "member"): RouteAccess => ({
  kind: "project",
  permission,
  project: fromTicket("ticketId"),
  resource: ticketVisible("ticketId"),
});

const ticketParamsSchema = z.object({ ticketId: z.uuid() });

/** `owner/repo` dall'URL della PR (`https://github.com/acme/shop/pull/7`). */
function repoOfPrUrl(url: string, fallback: string): string {
  try {
    const parts = new URL(url).pathname.split("/").filter((p) => p.length > 0);
    return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : fallback;
  } catch {
    return fallback;
  }
}

const WRITE_ERRORS: Record<TaskWriteError, string> = {
  status_not_in_project: "The status does not belong to the task's project",
  department_not_found: "Department not found",
  assignee_not_found: "Assignee not found",
  milestone_cross_project: "The milestone belongs to another project",
  request_not_found: "Request not found in this project",
  request_not_convertible: "The request is already converted or archived",
  past_week: "A past week cannot be planned",
  chat_message_not_found: "Chat message not found",
  claude_assign_forbidden: "Assigning Claude starts the work: it needs permission to start runs in this project",
};

/** Un errore di scrittura: 403 per «assegnare Claude» senza `runs.start`, altrimenti lo status dato. */
function writeError(reply: FastifyReply, error: TaskWriteError, status: 400 | 409): FastifyReply {
  return apiError(reply, error === "claude_assign_forbidden" ? 403 : status, error, WRITE_ERRORS[error]);
}

const bulkForbiddenSchema = z.object({ code: z.string(), message: z.string(), codes: z.array(z.string()) });

export async function taskRoutes(instance: FastifyInstance): Promise<void> {
  const app = instance.withTypeProvider<ZodTypeProvider>();

  // Rotte letterali PRIMA delle parametriche (trappola di routing in CLAUDE.md).
  app.get(
    "/",
    {
      config: { access: { kind: "user" } },
      schema: {
        querystring: taskListQuerySchema,
        response: { 200: taskListResponseSchema, ...authErrorResponses },
      },
    },
    async (request) => {
      const today = serverToday();
      const loaded = await loadTaskViews(app.db, request.user!, taskFilterConditions(request.query, today));
      let kept = loaded;
      if (request.query.stalled !== undefined) {
        const stalls = await stallsOf(app.db, request.user!, loaded, today);
        kept = loaded.filter((t) => stalls.has(t.view.id) === request.query.stalled);
      }
      // Il tetto vale per ciò che si è LETTO: col filtro `stalled` quello che
      // resta può essere poco anche quando la lettura è stata tagliata.
      return {
        items: kept.slice(0, TASK_LIST_CAP).map((t) => t.view),
        truncated: loaded.length > TASK_LIST_CAP,
      };
    },
  );

  app.get(
    "/stalled",
    {
      config: { access: { kind: "user" } },
      schema: {
        querystring: taskListQuerySchema,
        response: { 200: z.array(stalledTaskViewSchema), ...authErrorResponses },
      },
    },
    async (request) => {
      const today = serverToday();
      const loaded = await loadTaskViews(app.db, request.user!, taskFilterConditions(request.query, today));
      const stalls = await stallsOf(app.db, request.user!, loaded, today);
      return loaded
        .flatMap((t) => {
          const stall = stalls.get(t.view.id);
          return stall ? [{ task: t.view, stall }] : [];
        })
        .sort((a, b) => a.stall.since.localeCompare(b.stall.since));
    },
  );

  app.get(
    "/by-code/:code",
    {
      config: { access: { kind: "user" } },
      schema: {
        params: z.object({ code: z.string().min(3).max(32) }),
        response: { 200: taskViewSchema, 404: errorSchema, ...authErrorResponses },
      },
    },
    async (request, reply) => {
      const match = /^([A-Za-z][A-Za-z0-9]{1,5})-(\d{1,9})$/.exec(request.params.code);
      const notFound = () => apiError(reply, 404, "not_found", "Not found");
      if (!match) return notFound();
      const [view] = await loadTaskViews(
        app.db,
        request.user!,
        [eq(projects.code, match[1]!.toUpperCase()), eq(tickets.number, Number(match[2]))],
        1,
      );
      return view ? view.view : notFound();
    },
  );

  // --- scritture ---------------------------------------------------------------

  app.post(
    "/",
    {
      config: { access: { kind: "project", permission: "tickets.create", project: fromBody("projectId") } },
      schema: {
        body: newTaskBodySchema,
        response: { 201: taskViewSchema, 400: errorSchema, 404: errorSchema, 409: errorSchema, ...authErrorResponses },
      },
    },
    async (request, reply) => {
      const result = await createTask(app.db, request.user!, request.body, claudeStart(app, request));
      if (!result.ok && result.error === "request_not_convertible") {
        return writeError(reply, result.error, 409);
      }
      if (!result.ok) return writeError(reply, result.error, 400);
      return reply.code(201).send(result.task);
    },
  );

  // Letterale PRIMA di `/:ticketId` (trappola di routing).
  app.patch(
    "/bulk",
    {
      config: { access: { kind: "user" } },
      schema: {
        body: z.object({
          ids: z.array(z.uuid()).min(1).max(200),
          patch: z
            .object({
              statusId: z.uuid(),
              assigneeId: z.uuid().nullable(),
              milestoneId: z.uuid().nullable(),
              size: taskSizeSchema.nullable(),
              departmentId: z.uuid(),
              plannedWeek: isoWeekSchema.nullable(),
            })
            .partial(),
        }),
        response: {
          200: z.array(taskViewSchema),
          400: errorSchema,
          404: errorSchema,
          401: errorSchema,
          403: bulkForbiddenSchema,
        },
      },
    },
    async (request, reply) => {
      const result = await bulkUpdateTasks(app.db, request.user!, request.body.ids, request.body.patch, claudeStart(app, request));
      if (result.ok) return result.tasks;
      switch (result.error) {
        case "not_found":
          return apiError(reply, 404, "not_found", "Not found");
        case "forbidden":
          return reply
            .code(403)
            .send({ code: "forbidden", message: "Some tasks cannot be edited", codes: result.codes });
        case "status_cross_project":
          return apiError(reply, 400, "status_cross_project", "A status can be set only on tasks of one project");
        default:
          // Lo schema del 403 del blocco porta `codes`: la regola è del progetto, non di una task.
          if (result.error === "claude_assign_forbidden") {
            return reply.code(403).send({ code: result.error, message: WRITE_ERRORS[result.error], codes: [] });
          }
          return writeError(reply, result.error, 400);
      }
    },
  );

  /**
   * «Elimina task» (fetta 3.0 della chat): il dialogo legge qui se si può,
   * perché no, cosa la occupa e le figlie che restano (`services/task-delete.ts`).
   * Chi può lo decide il SERVIZIO (autore con `tickets.edit`, o
   * `tickets.moderate`): la rotta chiede solo di vedere la task.
   */
  app.get(
    "/:ticketId/deletion",
    {
      config: { access: onTicket("member") },
      schema: {
        params: ticketParamsSchema,
        response: { 200: taskDeletionPreviewSchema, 404: errorSchema, ...authErrorResponses },
      },
    },
    async (request, reply) => {
      const preview = await taskDeletionPreview(
        app.db,
        { ...request.user!, permissions: routePermissions(request) },
        request.params.ticketId,
      );
      if (!preview) return apiError(reply, 404, "not_found", "Task not found");
      return preview;
    },
  );

  /**
   * Elimina la task: un'eliminazione VERA, non si annulla (regole nel docblock
   * di `services/task-delete.ts`). 403 `forbidden` senza il permesso, 409
   * `busy` con le ragioni, 404 per una invisibile. I file degli allegati si
   * tolgono DOPO il commit, best-effort (come l'eliminazione di un commento).
   */
  app.delete(
    "/:ticketId",
    {
      config: { access: onTicket("member") },
      schema: {
        params: ticketParamsSchema,
        response: {
          204: z.null(),
          404: errorSchema,
          409: taskDeleteBusySchema,
          ...authErrorResponses,
        },
      },
    },
    async (request, reply) => {
      const result = await deleteTask(
        app.db,
        { ...request.user!, permissions: routePermissions(request) },
        request.params.ticketId,
      );
      if (!result.ok) {
        if (result.error === "busy") {
          return reply.code(409).send({ code: "busy", message: "The task is busy", reasons: result.reasons });
        }
        if (result.error === "forbidden") return apiError(reply, 403, "forbidden", "You can't delete this task");
        return apiError(reply, 404, "not_found", "Task not found");
      }
      if (result.storageKeys.length > 0) {
        try {
          const storage = await app.storage();
          if (storage) {
            for (const key of result.storageKeys) {
              try {
                await storage.deleteObject(key);
              } catch (error) {
                request.log.warn({ err: error }, "allegato della task eliminata non rimosso dallo storage");
              }
            }
          }
        } catch (error) {
          request.log.warn({ err: error }, "storage non raggiungibile: allegati della task eliminata restano");
        }
      }
      return reply.code(204).send(null);
    },
  );

  app.patch(
    "/:ticketId",
    {
      config: { access: onTicket("tickets.edit") },
      schema: {
        params: ticketParamsSchema,
        body: taskPatchSchema,
        response: { 200: taskViewSchema, 400: errorSchema, 404: errorSchema, ...authErrorResponses },
      },
    },
    async (request, reply) => {
      const result = await updateTask(app.db, request.user!, request.params.ticketId, request.body, claudeStart(app, request));
      if (!result.ok) return writeError(reply, result.error, 400);
      return result.task;
    },
  );

  app.put(
    "/:ticketId/manual-stall",
    {
      config: { access: onTicket("tickets.edit") },
      schema: {
        params: ticketParamsSchema,
        body: z.object({ reason: z.string().trim().min(1).max(200), note: z.string().max(2000).optional() }),
        response: { 200: taskViewSchema, 404: errorSchema, ...authErrorResponses },
      },
    },
    async (request) => setManualStall(app.db, request.user!, request.params.ticketId, request.body),
  );

  app.delete(
    "/:ticketId/manual-stall",
    {
      config: { access: onTicket("tickets.edit") },
      schema: {
        params: ticketParamsSchema,
        response: { 200: taskViewSchema, 404: errorSchema, ...authErrorResponses },
      },
    },
    async (request) => setManualStall(app.db, request.user!, request.params.ticketId, null),
  );

  for (const [method, following] of [
    ["PUT", true],
    ["DELETE", false],
  ] as const) {
    app.route({
      method,
      url: "/:ticketId/follow",
      config: { access: onTicket() },
      schema: {
        params: ticketParamsSchema,
        response: { 204: z.null(), 404: errorSchema, ...authErrorResponses },
      },
      handler: async (request, reply) => {
        await setFollowing(app.db, request.user!.id, request.params.ticketId, following);
        return reply.code(204).send(null);
      },
    });
  }

  // Pianificare dal Planning (fetta 2): persona e settimana insieme, con la
  // regola `planBlock` decisa qui (vedi `planTask`).
  app.post(
    "/:ticketId/plan",
    {
      config: { access: onTicket() },
      schema: {
        params: ticketParamsSchema,
        body: z.object({ assigneeId: z.uuid().nullable(), week: isoWeekSchema.nullable() }),
        response: { 200: taskViewSchema, 400: errorSchema, 404: errorSchema, ...authErrorResponses },
      },
    },
    async (request, reply) => {
      const result = await planTask(app.db, request.user!, request.params.ticketId, request.body, claudeStart(app, request));
      if (result.ok) return result.task;
      if (result.error === "forbidden") {
        return apiError(reply, 403, "forbidden", "You can plan only your own tasks in this project");
      }
      if (result.error === "past_week") return apiError(reply, 400, "past_week", WRITE_ERRORS.past_week);
      if (result.error === "claude_assign_forbidden") {
        return apiError(reply, 403, "claude_assign_forbidden", WRITE_ERRORS.claude_assign_forbidden);
      }
      return apiError(reply, 400, "invalid_assignee", "The person is not a member of the project");
    },
  );

  app.post(
    "/:ticketId/decisions",
    {
      config: { access: onTicket("tickets.comment") },
      schema: {
        params: ticketParamsSchema,
        body: z.object({
          askedOfId: z.uuid(),
          question: z.string().trim().min(1).max(2000),
          options: z.array(z.string().trim().min(1).max(200)).max(8).default([]),
        }),
        response: { 201: decisionRequestViewSchema, 400: errorSchema, 404: errorSchema, ...authErrorResponses },
      },
    },
    async (request, reply) => {
      const result = await askDecision(app.db, request.user!, request.params.ticketId, request.body);
      if (!result.ok) {
        return apiError(reply, 400, result.error, "The person asked cannot see this task");
      }
      return reply.code(201).send(result.decision);
    },
  );

  app.get(
    "/:ticketId/activity",
    {
      config: { access: onTicket() },
      schema: {
        params: ticketParamsSchema,
        response: { 200: z.array(taskActivityEntryViewSchema), 404: errorSchema, ...authErrorResponses },
      },
    },
    async (request) => taskActivity(app.db, request.params.ticketId),
  );

  /** Il lavoro di Claude sulla task, per chi guarda: il riassunto della fetta 1 più l'area 3. */
  const workView = async (
    ticketId: string,
    viewerId: string,
    permissions: ReturnType<typeof routePermissions>,
  ): Promise<TaskWorkView> => {
    const [job] = await app.db
      .select({ status: aiJobs.status })
      .from(aiJobs)
      .where(eq(aiJobs.ticketId, ticketId))
      .orderBy(desc(aiJobs.createdAt))
      .limit(1);
    const prs = await app.db
      .select({
        url: ticketRepositories.prUrl,
        number: ticketRepositories.prNumber,
        state: ticketRepositories.prState,
        repoName: repositories.name,
      })
      .from(ticketRepositories)
      .innerJoin(repositories, eq(repositories.id, ticketRepositories.repositoryId))
      .where(and(eq(ticketRepositories.ticketId, ticketId), sql`${ticketRepositories.prUrl} is not null`))
      .orderBy(asc(ticketRepositories.id));
    return {
      claude: claudeStateOf(job?.status ?? null),
      pullRequests: prs.map((pr) => ({
        repo: repoOfPrUrl(pr.url!, pr.repoName),
        number: pr.number,
        url: pr.url!,
        state: pr.state === "closed_unmerged" ? ("closed" as const) : pr.state,
      })),
      webHref: `/tickets/${ticketId}`,
      // Area 3, fetta 3a: il lavoro intero, in lettura, coi permessi di chi guarda.
      ...(await loadTaskWorkExtras(app.db, { ticketId, viewerId, permissions })),
    };
  };

  app.get(
    "/:ticketId/work",
    {
      config: { access: onTicket() },
      schema: {
        params: ticketParamsSchema,
        response: { 200: taskWorkViewSchema, 404: errorSchema, ...authErrorResponses },
      },
    },
    async (request): Promise<TaskWorkView> =>
      workView(request.params.ticketId, request.user!.id, routePermissions(request)),
  );

  /**
   * «Annulla il lavoro» (area 3, fetta 3b): chiude subito il job PARCHEGGIATO
   * della task (`services/cancel-run.ts`), per chi ha `runs.start`. Su un job
   * in esecuzione 409 `run_in_progress` (prima «Ferma»), senza lavoro vivo 409
   * `nothing_to_cancel`. Risponde col lavoro aggiornato.
   */
  app.post(
    "/:ticketId/cancel-run",
    {
      config: { access: onTicket("runs.start") },
      schema: {
        params: ticketParamsSchema,
        response: { 200: taskWorkViewSchema, 202: taskWorkViewSchema, 404: errorSchema, 409: errorSchema, ...authErrorResponses },
      },
    },
    async (request, reply) => {
      const { ticketId } = request.params;
      const permissions = routePermissions(request);
      const result = await cancelRun(app.db, {
        ticketId,
        actor: { id: request.user!.id, email: request.user!.email, permissions },
        log: request.log,
      });
      if (!result.ok) {
        if (result.error === "forbidden") return apiError(reply, 403, "forbidden", "Missing permission");
        if (result.error === "run_in_progress") {
          return apiError(reply, 409, "run_in_progress", "Claude is working right now: stop it first");
        }
        return apiError(reply, 409, "nothing_to_cancel", "There is no work to cancel");
      }
      // Un job in esecuzione: richiesta registrata, la chiusura arriva dal worker.
      if (result.kind === "requested") reply.code(202);
      return workView(ticketId, request.user!.id, permissions);
    },
  );
}
