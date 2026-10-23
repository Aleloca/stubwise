import {
  milestoneCountsSchema,
  milestoneDraftSchema,
  milestonePatchSchema,
  milestoneSchema,
  milestoneWithCountsSchema,
  ticketStatusSchema,
} from "@stubwise/shared";
import { and, asc, eq, sql, type SQL } from "drizzle-orm";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { routePermissions } from "../auth/access.js";
import { fromBody, fromMilestone, fromQuery } from "../auth/project-resolvers.js";
import type { Db } from "@stubwise/db";
import { milestones, tickets } from "@stubwise/db";
import { apiError } from "../errors.js";
import { authErrorResponses, errorSchema, isUniqueViolation } from "./shared.js";
import { createMilestone } from "../services/milestones.js";

/**
 * Stato terminale "completato" di un ticket ai fini dell'avanzamento di una
 * milestone: "done". È lo stato che indica lavoro concluso (la PR è mergiata /
 * il fix è completato); "closed" è invece una chiusura amministrativa (es.
 * non-faremo) e NON conta come completato.
 */
const COMPLETED_STATUS = "done" satisfies z.infer<typeof ticketStatusSchema>;

/**
 * Schemi di richiesta e risposta: vivono in `@stubwise/shared`, così la web app
 * ne deriva i propri tipi invece di riscriverli. È la ragione per cui la
 * creazione dalla UI aveva potuto divergere dal body atteso dal server senza
 * che nulla se ne accorgesse.
 */
const createMilestoneBodySchema = milestoneDraftSchema;
const updateMilestoneBodySchema = milestonePatchSchema;

const listMilestonesQuerySchema = z.object({ projectId: z.uuid() });
const idParamsSchema = z.object({ id: z.uuid() });

type MilestoneRow = typeof milestones.$inferSelect;
type Counts = z.infer<typeof milestoneCountsSchema>;

/** Counts a zero, con tutti gli stati ticket presenti nel byStatus. */
function emptyCounts(): Counts {
  const byStatus = Object.fromEntries(
    ticketStatusSchema.options.map((s) => [s, 0]),
  ) as Counts["byStatus"];
  return { total: 0, completed: 0, byStatus };
}

/** Proiezione pubblica senza avanzamento. */
function toPublicMilestone(row: MilestoneRow): z.infer<typeof milestoneSchema> {
  return {
    id: row.id,
    projectId: row.projectId,
    name: row.name,
    description: row.description,
    dueDate: row.dueDate?.toISOString() ?? null,
    status: row.status,
    closedAt: row.closedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

/** Proiezione pubblica con avanzamento. */
function toPublicMilestoneWithCounts(
  row: MilestoneRow,
  counts: Counts,
): z.infer<typeof milestoneWithCountsSchema> {
  return { ...toPublicMilestone(row), counts };
}

/**
 * I ticket che contano nell'avanzamento per chi guarda: la regola di
 * `tickets.view_all` (senza, solo quelli che ha chiesto lui), come
 * nell'elenco dei ticket — un conteggio non dice quanti ticket altrui ci sono.
 * `undefined` = tutti.
 */
function countedTickets(request: FastifyRequest): SQL | undefined {
  return routePermissions(request).has("tickets.view_all")
    ? undefined
    : eq(tickets.requestedByUserId, request.user!.id);
}

/**
 * Avanzamento di UNA milestone, con una sola aggregazione SQL sui ticket della
 * milestone raggruppati per stato. Usato dal dettaglio e dal PATCH.
 */
async function countsForMilestone(
  db: Db,
  milestoneId: string,
  counted: SQL | undefined,
): Promise<Counts> {
  const rows = await db
    .select({ status: tickets.status, count: sql<number>`count(*)::int` })
    .from(tickets)
    .where(and(eq(tickets.milestoneId, milestoneId), counted))
    .groupBy(tickets.status);
  const counts = emptyCounts();
  for (const row of rows) {
    counts.byStatus[row.status] = row.count;
    counts.total += row.count;
    if (row.status === COMPLETED_STATUS) counts.completed = row.count;
  }
  return counts;
}

/**
 * Carica una milestone e il suo avanzamento. Restituisce null se la milestone
 * non esiste (i chiamanti traducono in 404).
 */
async function loadMilestoneWithCounts(
  db: Db,
  id: string,
  counted: SQL | undefined,
): Promise<z.infer<typeof milestoneWithCountsSchema> | null> {
  const [row] = await db.select().from(milestones).where(eq(milestones.id, id));
  if (!row) return null;
  const counts = await countsForMilestone(db, id, counted);
  return toPublicMilestoneWithCounts(row, counts);
}

/**
 * Route delle milestone, registrate sotto /api/milestones. Leggerle basta
 * essere membri del progetto; crearle, modificarle e cancellarle è
 * pianificare i ticket (`tickets.edit`), lavoro quotidiano e non un
 * privilegio di chi gestisce il progetto.
 */
export async function milestoneRoutes(instance: FastifyInstance): Promise<void> {
  const app = instance.withTypeProvider<ZodTypeProvider>();

  app.post(
    "/",
    {
      config: { access: { kind: "project", permission: "tickets.edit", project: fromBody("projectId") } },
      schema: {
        body: createMilestoneBodySchema,
        response: {
          201: milestoneSchema,
          400: errorSchema,
          404: errorSchema,
          409: errorSchema,
          ...authErrorResponses,
        },
      },
    },
    async (request, reply) => {
      // La mutazione vive in `services/milestones.ts`: qui resta solo la
      // traduzione degli errori tipizzati in risposte HTTP.
      const result = await createMilestone(app.db, request.body);
      if (!result.ok) {
        if (result.error === "project_not_found") {
          return apiError(reply, 404, "project_not_found", "Project not found");
        }
        if (result.error === "repository_not_in_project") {
          return apiError(
            reply,
            400,
            "repository_not_in_project",
            "Repository not found in this project",
          );
        }
        return apiError(
          reply,
          409,
          "milestone_exists",
          "A milestone with this name already exists in the project",
        );
      }
      return await reply.code(201).send(toPublicMilestone(result.milestone));
    },
  );

  app.get(
    "/",
    {
      config: { access: { kind: "project", permission: "member", project: fromQuery("projectId") } },
      schema: {
        querystring: listMilestonesQuerySchema,
        response: { 200: z.array(milestoneWithCountsSchema), 400: errorSchema, ...authErrorResponses },
      },
    },
    async (request) => {
      const { projectId } = request.query;

      const rows = await app.db
        .select()
        .from(milestones)
        .where(eq(milestones.projectId, projectId))
        // open prima di closed; poi dueDate asc con NULLS LAST; poi name.
        .orderBy(
          sql`case when ${milestones.status} = 'open' then 0 else 1 end`,
          sql`${milestones.dueDate} asc nulls last`,
          asc(milestones.name),
        );

      // UNA sola aggregazione per tutto il progetto: i counts di OGNI milestone
      // in una query (GROUP BY milestone_id, status), poi mappati in memoria.
      // Niente N+1.
      const aggRows = await app.db
        .select({
          milestoneId: tickets.milestoneId,
          status: tickets.status,
          count: sql<number>`count(*)::int`,
        })
        .from(tickets)
        .where(
          and(
            eq(tickets.projectId, projectId),
            sql`${tickets.milestoneId} is not null`,
            countedTickets(request),
          ),
        )
        .groupBy(tickets.milestoneId, tickets.status);

      const countsByMilestone = new Map<string, Counts>();
      for (const row of aggRows) {
        if (row.milestoneId === null) continue;
        let counts = countsByMilestone.get(row.milestoneId);
        if (!counts) {
          counts = emptyCounts();
          countsByMilestone.set(row.milestoneId, counts);
        }
        counts.byStatus[row.status] = row.count;
        counts.total += row.count;
        if (row.status === COMPLETED_STATUS) counts.completed = row.count;
      }

      return rows.map((row) =>
        toPublicMilestoneWithCounts(row, countsByMilestone.get(row.id) ?? emptyCounts()),
      );
    },
  );

  app.get(
    "/:id",
    {
      config: { access: { kind: "project", permission: "member", project: fromMilestone("id") } },
      schema: {
        params: idParamsSchema,
        response: { 200: milestoneWithCountsSchema, 404: errorSchema, ...authErrorResponses },
      },
    },
    async (request, reply) => {
      const result = await loadMilestoneWithCounts(app.db, request.params.id, countedTickets(request));
      if (!result) return apiError(reply, 404, "milestone_not_found", "Milestone not found");
      return result;
    },
  );

  app.patch(
    "/:id",
    {
      config: { access: { kind: "project", permission: "tickets.edit", project: fromMilestone("id") } },
      schema: {
        params: idParamsSchema,
        body: updateMilestoneBodySchema,
        response: {
          200: milestoneWithCountsSchema,
          400: errorSchema,
          404: errorSchema,
          409: errorSchema,
          ...authErrorResponses,
        },
      },
    },
    async (request, reply) => {
      const { name, description, dueDate, status } = request.body;

      const updates: Partial<typeof milestones.$inferInsert> = {};
      if (name !== undefined) updates.name = name;
      if (description !== undefined) updates.description = description;
      if (dueDate !== undefined) updates.dueDate = dueDate === null ? null : new Date(dueDate);
      if (status !== undefined) {
        updates.status = status;
        // `closedAt` lo governa il passaggio di stato, non il client: chiudere
        // la data la mette, riaprire la toglie. Una PATCH che non tocca
        // `status` non ci mette mano. Non è idempotente sul valore — richiudere
        // una milestone già chiusa riscrive la data — ma la seconda chiusura è
        // comunque l'ultima, e non esiste uno stato "chiusa senza data".
        updates.closedAt = status === "closed" ? new Date() : null;
      }

      if (Object.keys(updates).length === 0) {
        return apiError(reply, 400, "no_fields", "Provide at least one field to update");
      }

      const id = request.params.id;
      try {
        const updated = await app.db
          .update(milestones)
          .set(updates)
          .where(eq(milestones.id, id))
          .returning();
        if (updated.length === 0) {
          return apiError(reply, 404, "milestone_not_found", "Milestone not found");
        }
        const counts = await countsForMilestone(app.db, id, countedTickets(request));
        return toPublicMilestoneWithCounts(updated[0]!, counts);
      } catch (error) {
        if (isUniqueViolation(error)) {
          return apiError(reply, 409, "milestone_exists", "A milestone with this name already exists in the project");
        }
        throw error;
      }
    },
  );

  app.delete(
    "/:id",
    {
      config: { access: { kind: "project", permission: "tickets.edit", project: fromMilestone("id") } },
      schema: {
        params: idParamsSchema,
        response: { 204: z.null(), 404: errorSchema, ...authErrorResponses },
      },
    },
    async (request, reply) => {
      // I ticket assegnati alla milestone passano a milestone_id null via FK
      // (ON DELETE SET NULL): non vengono cancellati.
      const deleted = await app.db
        .delete(milestones)
        .where(eq(milestones.id, request.params.id))
        .returning({ id: milestones.id });
      if (deleted.length === 0) return apiError(reply, 404, "milestone_not_found", "Milestone not found");
      return reply.code(204).send(null);
    },
  );
}
