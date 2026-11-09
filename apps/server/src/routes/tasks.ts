import {
  aiJobs,
  comments,
  decisionRequests,
  repositories,
  ticketEvents,
  ticketRepositories,
  tickets,
  projects,
} from "@stubwise/db";
import {
  stalledTaskViewSchema,
  taskActivityEntryViewSchema,
  taskListQuerySchema,
  taskListResponseSchema,
  taskViewSchema,
  taskWorkViewSchema,
  type TaskActivityEntryView,
  type TaskWorkView,
} from "@stubwise/shared";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import type { RouteAccess } from "../auth/access.js";
import { fromTicket, ticketVisible } from "../auth/project-resolvers.js";
import { apiError } from "../errors.js";
import {
  claudeStateOf,
  loadTaskViews,
  serverToday,
  stallsOf,
  taskFilterConditions,
  TASK_LIST_CAP,
} from "../services/task-view.js";
import { authErrorResponses, errorSchema } from "./shared.js";

/**
 * `/api/tasks` (integrazione area 2, fetta 1): le task nella forma del
 * prototipo per l'app nuova. Le letture filtrano per visibilità nella WHERE
 * (`loadTaskViews`), e una task invisibile risponde 404 `not_found` come una
 * che non esiste. Web vecchio, mobile e MCP continuano a usare `/api/tickets`.
 */

const onTicket = (permission: "member" = "member"): RouteAccess => ({
  kind: "project",
  permission,
  project: fromTicket("ticketId"),
  resource: ticketVisible("ticketId"),
});

const ticketParamsSchema = z.object({ ticketId: z.uuid() });

const EVENT_FIELD: Record<string, string> = {
  status_changed: "status",
  assignee_changed: "assignee",
  priority_changed: "priority",
  type_changed: "type",
  labels_changed: "labels",
  title_changed: "title",
  body_changed: "description",
  relation_added: "links",
  relation_removed: "links",
  milestone_changed: "milestone",
};

function eventValue(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map((v) => (typeof v === "string" ? v : JSON.stringify(v))).join(", ");
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

/** `owner/repo` dall'URL della PR (`https://github.com/acme/shop/pull/7`). */
function repoOfPrUrl(url: string, fallback: string): string {
  try {
    const parts = new URL(url).pathname.split("/").filter((p) => p.length > 0);
    return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : fallback;
  } catch {
    return fallback;
  }
}

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
      return {
        items: kept.slice(0, TASK_LIST_CAP).map((t) => t.view),
        truncated: kept.length > TASK_LIST_CAP,
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

  app.get(
    "/:ticketId/activity",
    {
      config: { access: onTicket() },
      schema: {
        params: ticketParamsSchema,
        response: { 200: z.array(taskActivityEntryViewSchema), 404: errorSchema, ...authErrorResponses },
      },
    },
    async (request) => {
      const { ticketId } = request.params;
      const [commentRows, eventRows, decisionRows] = await Promise.all([
        app.db.select().from(comments).where(eq(comments.ticketId, ticketId)),
        app.db.select().from(ticketEvents).where(eq(ticketEvents.ticketId, ticketId)),
        app.db
          .select({ id: decisionRequests.id, by: decisionRequests.askedByUserId, at: decisionRequests.createdAt })
          .from(decisionRequests)
          .where(eq(decisionRequests.ticketId, ticketId)),
      ]);
      const entries: (TaskActivityEntryView & { sortAt: number })[] = [
        ...commentRows.map((c) => ({
          id: c.id,
          taskId: ticketId,
          kind: "comment" as const,
          authorId: c.authorType === "user" ? c.authorId : null,
          at: c.createdAt.toISOString(),
          body: c.body,
          ...(c.replyToCommentId ? { replyToId: c.replyToCommentId } : {}),
          ...(c.editedAt ? { editedAt: c.editedAt.toISOString() } : {}),
          ...(c.deletedAt ? { deletedAt: c.deletedAt.toISOString() } : {}),
          ...(c.deletedByUserId ? { deletedById: c.deletedByUserId } : {}),
          sortAt: c.createdAt.getTime(),
        })),
        ...eventRows.map((e) => {
          const payload = (e.payload ?? {}) as Record<string, unknown>;
          return {
            id: e.id,
            taskId: ticketId,
            kind: "field_change" as const,
            authorId: e.actorId,
            at: e.createdAt.toISOString(),
            field: EVENT_FIELD[e.kind] ?? e.kind,
            from: eventValue(payload.from),
            to: eventValue(payload.to),
            sortAt: e.createdAt.getTime(),
          };
        }),
        ...decisionRows.map((d) => ({
          id: d.id,
          taskId: ticketId,
          kind: "decision" as const,
          authorId: d.by,
          at: d.at.toISOString(),
          decisionRequestId: d.id,
          sortAt: d.at.getTime(),
        })),
      ];
      return entries
        .sort((a, b) => a.sortAt - b.sortAt || a.id.localeCompare(b.id))
        .map((entry): TaskActivityEntryView => {
          const { sortAt, ...rest } = entry;
          void sortAt;
          return rest;
        });
    },
  );

  app.get(
    "/:ticketId/work",
    {
      config: { access: onTicket() },
      schema: {
        params: ticketParamsSchema,
        response: { 200: taskWorkViewSchema, 404: errorSchema, ...authErrorResponses },
      },
    },
    async (request): Promise<TaskWorkView> => {
      const { ticketId } = request.params;
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
      };
    },
  );
}
