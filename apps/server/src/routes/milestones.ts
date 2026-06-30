import { ticketStatusSchema } from "@stubwise/shared";
import { and, asc, eq, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { requireAuth } from "../auth/session.js";
import type { Db } from "@stubwise/db";
import { milestoneStatus, milestones, projects, repositories, tickets } from "@stubwise/db";
import { apiError } from "../errors.js";
import { authErrorResponses, errorSchema, isUniqueViolation } from "./shared.js";

/**
 * Stato terminale "completato" di un ticket ai fini dell'avanzamento di una
 * milestone: "done". È lo stato che indica lavoro concluso (la PR è mergiata /
 * il fix è completato); "closed" è invece una chiusura amministrativa (es.
 * non-faremo) e NON conta come completato.
 */
const COMPLETED_STATUS = "done" satisfies z.infer<typeof ticketStatusSchema>;

/** Avanzamento di una milestone: totale, completati e ripartizione per stato. */
const milestoneCountsSchema = z.object({
  total: z.number().int(),
  completed: z.number().int(),
  byStatus: z.record(ticketStatusSchema, z.number().int()),
});

/** Proiezione pubblica della milestone, senza avanzamento (POST). */
const milestoneSchema = z.object({
  id: z.uuid(),
  projectId: z.uuid(),
  name: z.string(),
  dueDate: z.iso.datetime().nullable(),
  status: z.enum(milestoneStatus.enumValues),
  createdAt: z.iso.datetime(),
});

/** Milestone con avanzamento (GET lista/dettaglio, PATCH). */
const milestoneWithCountsSchema = milestoneSchema.extend({ counts: milestoneCountsSchema });

const nameSchema = z.string().min(1).max(200);
// ISO datetime o null (azzeramento). Optional separa "campo assente" da "null".
const dueDateSchema = z.iso.datetime().nullable();
const statusSchema = z.enum(milestoneStatus.enumValues);

const createMilestoneBodySchema = z.object({
  projectId: z.uuid(),
  // Repository d'origine della milestone: deve appartenere al progetto (400
  // altrimenti). In Fase 1 la milestone è product-level ma porta un repo
  // d'origine valorizzato (continuità con i dati esistenti, schema NOT NULL).
  repositoryId: z.uuid(),
  name: nameSchema,
  dueDate: dueDateSchema.optional(),
  status: statusSchema.optional(),
});

const updateMilestoneBodySchema = z.object({
  name: nameSchema.optional(),
  dueDate: dueDateSchema.optional(),
  status: statusSchema.optional(),
});

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
    dueDate: row.dueDate?.toISOString() ?? null,
    status: row.status,
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
 * Avanzamento di UNA milestone, con una sola aggregazione SQL sui ticket della
 * milestone raggruppati per stato. Usato dal dettaglio e dal PATCH.
 */
async function countsForMilestone(db: Db, milestoneId: string): Promise<Counts> {
  const rows = await db
    .select({ status: tickets.status, count: sql<number>`count(*)::int` })
    .from(tickets)
    .where(eq(tickets.milestoneId, milestoneId))
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
): Promise<z.infer<typeof milestoneWithCountsSchema> | null> {
  const [row] = await db.select().from(milestones).where(eq(milestones.id, id));
  if (!row) return null;
  const counts = await countsForMilestone(db, id);
  return toPublicMilestoneWithCounts(row, counts);
}

/**
 * Route delle milestone, registrate sotto /api/milestones. Tutte dietro
 * requireAuth e aperte a ogni utente autenticato: pianificare verso una
 * milestone è lavoro quotidiano dei member, non un privilegio admin.
 */
export async function milestoneRoutes(instance: FastifyInstance): Promise<void> {
  const app = instance.withTypeProvider<ZodTypeProvider>();

  app.post(
    "/",
    {
      preHandler: requireAuth,
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
      const { projectId, repositoryId, name, dueDate, status } = request.body;

      const [project] = await app.db
        .select({ id: projects.id })
        .from(projects)
        .where(eq(projects.id, projectId));
      if (!project) return apiError(reply, 404, "project_not_found", "Project not found");

      // Il repository d'origine deve appartenere al progetto (400 altrimenti).
      const [repository] = await app.db
        .select({ id: repositories.id })
        .from(repositories)
        .where(and(eq(repositories.id, repositoryId), eq(repositories.projectId, projectId)));
      if (!repository) {
        return apiError(
          reply,
          400,
          "repository_not_in_project",
          "Repository not found in this project",
        );
      }

      try {
        const [created] = await app.db
          .insert(milestones)
          .values({
            projectId,
            repositoryId,
            name,
            dueDate: dueDate !== undefined && dueDate !== null ? new Date(dueDate) : null,
            ...(status !== undefined ? { status } : {}),
          })
          .returning();
        if (!created) throw new Error("insert della milestone non ha restituito la riga");
        return await reply.code(201).send(toPublicMilestone(created));
      } catch (error) {
        if (isUniqueViolation(error)) {
          return apiError(reply, 409, "milestone_exists", "A milestone with this name already exists in the project");
        }
        throw error;
      }
    },
  );

  app.get(
    "/",
    {
      preHandler: requireAuth,
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
        .where(and(eq(tickets.projectId, projectId), sql`${tickets.milestoneId} is not null`))
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
      preHandler: requireAuth,
      schema: {
        params: idParamsSchema,
        response: { 200: milestoneWithCountsSchema, 404: errorSchema, ...authErrorResponses },
      },
    },
    async (request, reply) => {
      const result = await loadMilestoneWithCounts(app.db, request.params.id);
      if (!result) return apiError(reply, 404, "milestone_not_found", "Milestone not found");
      return result;
    },
  );

  app.patch(
    "/:id",
    {
      preHandler: requireAuth,
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
      const { name, dueDate, status } = request.body;

      const updates: Partial<typeof milestones.$inferInsert> = {};
      if (name !== undefined) updates.name = name;
      if (dueDate !== undefined) updates.dueDate = dueDate === null ? null : new Date(dueDate);
      if (status !== undefined) updates.status = status;

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
        const counts = await countsForMilestone(app.db, id);
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
      preHandler: requireAuth,
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
