import { and, asc, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { requireAuth } from "../auth/session.js";
import type { Db } from "@stubwise/db";
import { comments, tickets } from "@stubwise/db";
import { ticketCommentSchema, type CommentReplyTo } from "@stubwise/shared";
import { authErrorResponses, errorSchema, isForeignKeyViolation } from "./shared.js";
import { apiError } from "../errors.js";
import { addComment, loadReplyTargets } from "../services/comments.js";

/**
 * Forma pubblica di un commento. `authorId` è nullo per i commenti dell'AI
 * e di sistema, o se l'autore è stato eliminato. `system` copre le notifiche
 * automatiche (es. chiusura ticket al merge). Alimenta l'OpenAPI generata.
 *
 * DEFINITO IN `@stubwise/shared` (`ticketCommentSchema`) e qui soltanto
 * ri-esportato col nome storico: dall'app mobile lo stesso corpo lo legge il
 * client condiviso, e una seconda copia diverge al primo campo aggiunto da
 * una parte sola.
 */
export const commentSchema = ticketCommentSchema;

const createCommentBodySchema = z.object({
  body: z.string().min(1).max(20_000),
  /**
   * Il commento a cui si risponde (0083). OPZIONALE: le app già installate
   * non lo mandano, e un body che lo rendesse obbligatorio le romperebbe
   * (CLAUDE.md, «solo cambi additivi … alle richieste»). Deve essere un
   * commento dello STESSO ticket, di qualunque autore (anche AI o sistema).
   */
  replyToCommentId: z.uuid().optional(),
});

const ticketParamsSchema = z.object({ ticketId: z.uuid() });

type CommentRow = typeof comments.$inferSelect;

function toPublicComment(
  row: CommentRow,
  targets: Map<string, CommentReplyTo>,
): z.infer<typeof commentSchema> {
  return {
    id: row.id,
    ticketId: row.ticketId,
    authorType: row.authorType,
    authorId: row.authorId,
    body: row.body,
    createdAt: row.createdAt.toISOString(),
    // Derivato a lettura (`loadReplyTargets`): un padre non trovato è `null`.
    replyTo: row.replyToCommentId === null ? null : (targets.get(row.replyToCommentId) ?? null),
  };
}

/** True se `commentId` è un commento di `ticketId`. */
async function isCommentOfTicket(db: Db, commentId: string, ticketId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: comments.id })
    .from(comments)
    .where(and(eq(comments.id, commentId), eq(comments.ticketId, ticketId)));
  return row !== undefined;
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
        response: {
          201: commentSchema,
          404: errorSchema,
          422: errorSchema,
          ...authErrorResponses,
        },
      },
    },
    async (request, reply) => {
      const { ticketId } = request.params;
      const { replyToCommentId } = request.body;
      if (!(await ticketExists(app.db, ticketId))) {
        return apiError(reply, 404, "ticket_not_found", "Ticket not found");
      }
      // Il padre deve esistere ed essere di QUESTO ticket: una risposta non
      // attraversa i ticket. Il controllo precede l'insert, così un rifiuto
      // non lascia nessuna riga.
      if (
        replyToCommentId !== undefined &&
        !(await isCommentOfTicket(app.db, replyToCommentId, ticketId))
      ) {
        return apiError(reply, 422, "reply_target_invalid", "Reply target is not a comment of this ticket");
      }
      let created: CommentRow;
      try {
        created = await addComment(app.db, {
          ticketId,
          authorType: "user",
          // requireAuth è passato: request.user è popolato.
          authorId: request.user?.id,
          body: request.body.body,
          replyToCommentId: replyToCommentId ?? null,
        });
      } catch (error) {
        // Il padre è sparito fra il controllo e l'insert: la FK lo dice. Oggi
        // nessuna rotta cancella un commento, ma la finestra esiste.
        if (replyToCommentId !== undefined && isForeignKeyViolation(error)) {
          return apiError(reply, 422, "reply_target_invalid", "Reply target is not a comment of this ticket");
        }
        throw error;
      }
      const targets = await loadReplyTargets(app.db, [created.replyToCommentId]);
      return reply.code(201).send(toPublicComment(created, targets));
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
        return apiError(reply, 404, "ticket_not_found", "Ticket not found");
      }
      const rows = await app.db
        .select()
        .from(comments)
        .where(eq(comments.ticketId, ticketId))
        .orderBy(asc(comments.createdAt), asc(comments.id));
      const targets = await loadReplyTargets(
        app.db,
        rows.map((r) => r.replyToCommentId),
      );
      return rows.map((row) => toPublicComment(row, targets));
    },
  );
}
