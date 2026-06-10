import { asc, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { requireAuth } from "../auth/session.js";
import type { Db } from "../db/client.js";
import { comments, tickets } from "../db/schema.js";
import { authErrorResponses, errorSchema } from "./shared.js";

/**
 * Forma pubblica di un commento. `authorId` è nullo per i commenti dell'AI
 * o se l'autore è stato eliminato. Alimenta l'OpenAPI generata (Task 9).
 */
export const commentSchema = z.object({
  id: z.uuid(),
  ticketId: z.uuid(),
  authorType: z.enum(["user", "ai"]),
  authorId: z.uuid().nullable(),
  body: z.string(),
  createdAt: z.iso.datetime(),
});

const createCommentBodySchema = z.object({
  body: z.string().min(1).max(20_000),
});

const ticketParamsSchema = z.object({ ticketId: z.uuid() });

type CommentRow = typeof comments.$inferSelect;

function toPublicComment(row: CommentRow): z.infer<typeof commentSchema> {
  return {
    id: row.id,
    ticketId: row.ticketId,
    authorType: row.authorType,
    authorId: row.authorId,
    body: row.body,
    createdAt: row.createdAt.toISOString(),
  };
}

/** True se il ticket esiste: i commenti di un ticket fantasma sono 404. */
async function ticketExists(db: Db, ticketId: string): Promise<boolean> {
  const [row] = await db.select({ id: tickets.id }).from(tickets).where(eq(tickets.id, ticketId));
  return row !== undefined;
}

/**
 * Route dei commenti, registrate sotto /api/tickets/:ticketId/comments.
 * Da qui nascono solo commenti di utenti (`authorType: "user"`); quelli
 * dell'AI li inserisce direttamente il worker.
 */
export async function commentRoutes(instance: FastifyInstance): Promise<void> {
  const app = instance.withTypeProvider<ZodTypeProvider>();

  app.post(
    "/",
    {
      preHandler: requireAuth,
      schema: {
        params: ticketParamsSchema,
        body: createCommentBodySchema,
        response: { 201: commentSchema, 404: errorSchema, ...authErrorResponses },
      },
    },
    async (request, reply) => {
      const { ticketId } = request.params;
      if (!(await ticketExists(app.db, ticketId))) {
        return reply.code(404).send({ message: "Ticket non trovato" });
      }
      const [created] = await app.db
        .insert(comments)
        .values({
          ticketId,
          authorType: "user",
          // requireAuth è passato: request.user è popolato.
          authorId: request.user?.id,
          body: request.body.body,
        })
        .returning();
      if (!created) throw new Error("L'insert del commento non ha restituito la riga creata");
      return reply.code(201).send(toPublicComment(created));
    },
  );

  app.get(
    "/",
    {
      preHandler: requireAuth,
      schema: {
        params: ticketParamsSchema,
        response: { 200: z.array(commentSchema), 404: errorSchema, ...authErrorResponses },
      },
    },
    async (request, reply) => {
      const { ticketId } = request.params;
      if (!(await ticketExists(app.db, ticketId))) {
        return reply.code(404).send({ message: "Ticket non trovato" });
      }
      const rows = await app.db
        .select()
        .from(comments)
        .where(eq(comments.ticketId, ticketId))
        .orderBy(asc(comments.createdAt), asc(comments.id));
      return rows.map(toPublicComment);
    },
  );
}
