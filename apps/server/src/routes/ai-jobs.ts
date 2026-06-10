import { desc, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { requireAuth } from "../auth/session.js";
import type { Db } from "../db/client.js";
import { aiJobs, aiJobStatus, tickets } from "../db/schema.js";
import { authErrorResponses, errorSchema } from "./shared.js";

/**
 * Forma pubblica di un AIJob nelle risposte API: la riga del DB con le date
 * in ISO 8601. `startedAt`/`finishedAt` sono nulli finché il worker non
 * prende in carico / conclude il job. Alimenta l'OpenAPI generata (Task 9).
 */
export const aiJobSchema = z.object({
  id: z.uuid(),
  ticketId: z.uuid(),
  status: z.enum(aiJobStatus.enumValues),
  log: z.string(),
  prUrl: z.string().nullable(),
  error: z.string().nullable(),
  createdAt: z.iso.datetime(),
  startedAt: z.iso.datetime().nullable(),
  finishedAt: z.iso.datetime().nullable(),
});

const ticketParamsSchema = z.object({ ticketId: z.uuid() });

type AiJobRow = typeof aiJobs.$inferSelect;

function toPublicAiJob(row: AiJobRow): z.infer<typeof aiJobSchema> {
  return {
    id: row.id,
    ticketId: row.ticketId,
    status: row.status,
    log: row.log,
    prUrl: row.prUrl,
    error: row.error,
    createdAt: row.createdAt.toISOString(),
    startedAt: row.startedAt?.toISOString() ?? null,
    finishedAt: row.finishedAt?.toISOString() ?? null,
  };
}

/** True se il ticket esiste: i job di un ticket fantasma sono 404. */
async function ticketExists(db: Db, ticketId: string): Promise<boolean> {
  const [row] = await db.select({ id: tickets.id }).from(tickets).where(eq(tickets.id, ticketId));
  return row !== undefined;
}

/**
 * Route dei job AI, registrate sotto /api/tickets/:ticketId/jobs. Solo
 * lettura: i job li crea la pipeline (Task 19+), la UI mostra la timeline.
 */
export async function aiJobRoutes(instance: FastifyInstance): Promise<void> {
  const app = instance.withTypeProvider<ZodTypeProvider>();

  app.get(
    "/",
    {
      preHandler: requireAuth,
      schema: {
        params: ticketParamsSchema,
        response: { 200: z.array(aiJobSchema), 404: errorSchema, ...authErrorResponses },
      },
    },
    async (request, reply) => {
      const { ticketId } = request.params;
      if (!(await ticketExists(app.db, ticketId))) {
        return reply.code(404).send({ message: "Ticket non trovato" });
      }
      // Dal più recente al più vecchio: la timeline in UI parte dall'ultimo
      // tentativo. L'id spareggia i job creati nello stesso istante.
      const rows = await app.db
        .select()
        .from(aiJobs)
        .where(eq(aiJobs.ticketId, ticketId))
        .orderBy(desc(aiJobs.createdAt), desc(aiJobs.id));
      return rows.map(toPublicAiJob);
    },
  );
}
