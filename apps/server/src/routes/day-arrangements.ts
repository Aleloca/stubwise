import { taskDayArrangements, tickets } from "@stubwise/db";
import {
  dayArrangementSchema,
  isoWeekSchema,
  isoWeekToMonday,
  mondayToIsoWeek,
  setDayBodySchema,
  type DayArrangement,
} from "@stubwise/shared";
import { and, eq, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import type { RouteAccess } from "../auth/access.js";
import { fromTicket, ticketVisible } from "../auth/project-resolvers.js";
import { apiError } from "../errors.js";
import { visibleTasksCondition } from "../services/task-view.js";
import { authErrorResponses, errorSchema } from "./shared.js";

/**
 * Le sistemazioni per giorno di La mia settimana (integrazione area 2, fetta
 * 2): in che giorno (lun–ven) l'assegnatario si mette una task della
 * settimana. PERSONALI: si leggono e si scrivono solo le proprie, solo sulle
 * proprie task, e valgono finché la task resta sua e nella STESSA settimana
 * EFFETTIVA (`stubwise_effective_week`, slittamento compreso). Il trigger
 * `tickets_reset_day_arrangements` (0113) le cancella quando cambiano
 * settimana o assegnatario; la lettura filtra comunque, perché uno
 * slittamento cambia la settimana senza scrivere niente.
 */

const effectiveMonday = sql<string | null>`to_char(stubwise_effective_week(${tickets.plannedWeek}, ${tickets.closedAt}), 'YYYY-MM-DD')`;

const onTicket: RouteAccess = {
  kind: "project",
  permission: "member",
  project: fromTicket("ticketId"),
  resource: ticketVisible("ticketId"),
};

export async function dayArrangementRoutes(fastify: FastifyInstance): Promise<void> {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  app.get(
    "/me/day-arrangements",
    {
      config: { access: { kind: "user" } },
      schema: {
        querystring: z.object({ week: isoWeekSchema }),
        response: { 200: z.array(dayArrangementSchema), ...authErrorResponses },
      },
    },
    async (request): Promise<DayArrangement[]> => {
      const viewer = request.user!;
      const monday = isoWeekToMonday(request.query.week);
      const visible = await visibleTasksCondition(app.db, viewer);
      const rows = await app.db
        .select({ taskId: taskDayArrangements.ticketId, day: taskDayArrangements.day })
        .from(taskDayArrangements)
        .innerJoin(tickets, eq(tickets.id, taskDayArrangements.ticketId))
        .where(
          and(
            eq(taskDayArrangements.userId, viewer.id),
            eq(taskDayArrangements.week, monday),
            eq(tickets.assigneeId, viewer.id),
            sql`stubwise_effective_week(${tickets.plannedWeek}, ${tickets.closedAt}) = ${monday}::date`,
            ...(visible ? [visible] : []),
          ),
        );
      return rows.map((r) => ({ taskId: r.taskId, week: request.query.week, day: r.day as DayArrangement["day"] }));
    },
  );

  app.put(
    "/tasks/:ticketId/day",
    {
      config: { access: onTicket },
      schema: {
        params: z.object({ ticketId: z.uuid() }),
        body: setDayBodySchema,
        response: {
          200: dayArrangementSchema,
          404: errorSchema,
          409: errorSchema,
          ...authErrorResponses,
        },
      },
    },
    async (request, reply) => {
      const viewer = request.user!;
      const { ticketId } = request.params;
      const { week, day } = request.body;
      const [task] = await app.db
        .select({ assigneeId: tickets.assigneeId, monday: effectiveMonday })
        .from(tickets)
        .where(eq(tickets.id, ticketId));
      if (!task) return apiError(reply, 404, "not_found", "Task not found");
      if (task.assigneeId !== viewer.id) {
        return apiError(reply, 403, "forbidden", "Only the assignee arranges a task in their week");
      }
      if (!task.monday || mondayToIsoWeek(task.monday) !== week) {
        return apiError(reply, 409, "not_in_week", "The task is not planned in this week");
      }
      const monday = isoWeekToMonday(week);
      await app.db
        .insert(taskDayArrangements)
        .values({ ticketId, userId: viewer.id, week: monday, day })
        .onConflictDoUpdate({
          target: [taskDayArrangements.ticketId, taskDayArrangements.userId, taskDayArrangements.week],
          set: { day },
        });
      return { taskId: ticketId, week, day };
    },
  );
}
