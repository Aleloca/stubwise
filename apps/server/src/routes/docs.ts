import {
  docGenerationStatusSchema,
  docGenerationTriggerSchema,
  docJobStatusSchema,
} from "@stubwise/shared";
import { and, desc, eq, or } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { requireAdmin, requireAuth } from "../auth/session.js";
import {
  docGenerationJobs,
  docGenerations,
  projects,
} from "@stubwise/db";
import { apiError } from "../errors.js";
import { authErrorResponses, errorSchema } from "./shared.js";

const projectIdParamsSchema = z.object({ projectId: z.uuid() });

/** Job di generazione restituito dalle route di trigger/stato. */
const jobSchema = z.object({
  id: z.uuid(),
  status: docJobStatusSchema,
  trigger: docGenerationTriggerSchema,
  error: z.string().nullable(),
  createdAt: z.string(),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
});

type DocGenerationJobRow = typeof docGenerationJobs.$inferSelect;

function toJob(row: DocGenerationJobRow): z.infer<typeof jobSchema> {
  return {
    id: row.id,
    status: row.status,
    trigger: row.trigger,
    error: row.error,
    createdAt: row.createdAt.toISOString(),
    startedAt: row.startedAt?.toISOString() ?? null,
    finishedAt: row.finishedAt?.toISOString() ?? null,
  };
}

/** Generazione corrente (puntata da projects.currentDocGenerationId). */
const generationSchema = z.object({
  id: z.uuid(),
  status: docGenerationStatusSchema,
  commitSha: z.string().nullable(),
  model: z.string().nullable(),
  cost: z.string().nullable(),
  stats: z.unknown().nullable(),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
  createdAt: z.string(),
});

type DocGenerationRow = typeof docGenerations.$inferSelect;

function toGeneration(row: DocGenerationRow): z.infer<typeof generationSchema> {
  return {
    id: row.id,
    status: row.status,
    commitSha: row.commitSha,
    model: row.model,
    cost: row.cost,
    stats: row.stats ?? null,
    startedAt: row.startedAt?.toISOString() ?? null,
    finishedAt: row.finishedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * Route della documentazione (non-chat), registrate sotto /api.
 * Trigger della generazione (solo admin) e stato corrente (auth).
 */
export async function docsRoutes(instance: FastifyInstance): Promise<void> {
  const app = instance.withTypeProvider<ZodTypeProvider>();

  // --- M6.1: trigger generazione + stato ---------------------------------

  /**
   * Avvia una generazione manuale: inserisce un job `queued`. Idempotente sul
   * job attivo — se esiste già un job `queued`/`running` per il progetto, lo
   * restituisce invece di accodarne un secondo (evita doppie generazioni
   * concorrenti sullo stesso progetto). 404 se il progetto non esiste.
   */
  app.post(
    "/projects/:projectId/docs/generate",
    {
      preHandler: requireAdmin,
      schema: {
        params: projectIdParamsSchema,
        response: { 200: jobSchema, 202: jobSchema, 404: errorSchema, ...authErrorResponses },
      },
    },
    async (request, reply) => {
      const { projectId } = request.params;

      const [project] = await app.db
        .select({ id: projects.id })
        .from(projects)
        .where(eq(projects.id, projectId));
      if (!project) return apiError(reply, 404, "project_not_found", "Project not found");

      // Job attivo già in coda/in esecuzione: lo riusiamo (idempotente).
      const [active] = await app.db
        .select()
        .from(docGenerationJobs)
        .where(
          and(
            eq(docGenerationJobs.projectId, projectId),
            or(eq(docGenerationJobs.status, "queued"), eq(docGenerationJobs.status, "running")),
          ),
        )
        .orderBy(desc(docGenerationJobs.createdAt))
        .limit(1);
      if (active) return reply.code(200).send(toJob(active));

      const [created] = await app.db
        .insert(docGenerationJobs)
        .values({ projectId, status: "queued", trigger: "manual" })
        .returning();
      if (!created) throw new Error("insert del job non ha restituito la riga");
      return reply.code(202).send(toJob(created));
    },
  );

  /**
   * Stato della documentazione del progetto: la generazione corrente (se c'è)
   * e l'ultimo job (qualunque stato). Null-safe quando non c'è ancora nulla.
   */
  app.get(
    "/projects/:projectId/docs/status",
    {
      preHandler: requireAuth,
      schema: {
        params: projectIdParamsSchema,
        response: {
          200: z.object({
            generation: generationSchema.nullable(),
            latestJob: jobSchema.nullable(),
          }),
          404: errorSchema,
          ...authErrorResponses,
        },
      },
    },
    async (request, reply) => {
      const { projectId } = request.params;

      const [project] = await app.db
        .select({ id: projects.id, currentDocGenerationId: projects.currentDocGenerationId })
        .from(projects)
        .where(eq(projects.id, projectId));
      if (!project) return apiError(reply, 404, "project_not_found", "Project not found");

      let generation: z.infer<typeof generationSchema> | null = null;
      if (project.currentDocGenerationId) {
        const [gen] = await app.db
          .select()
          .from(docGenerations)
          .where(eq(docGenerations.id, project.currentDocGenerationId));
        generation = gen ? toGeneration(gen) : null;
      }

      const [job] = await app.db
        .select()
        .from(docGenerationJobs)
        .where(eq(docGenerationJobs.projectId, projectId))
        .orderBy(desc(docGenerationJobs.createdAt))
        .limit(1);

      return { generation, latestJob: job ? toJob(job) : null };
    },
  );
}
