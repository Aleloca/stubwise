import { and, asc, eq, isNull } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { requireAuth } from "../auth/session.js";
import type { Db } from "@stubwise/db";
import { comments, tickets } from "@stubwise/db";
import { ticketCommentSchema } from "@stubwise/shared";
import { authErrorResponses, errorSchema, foreignKeyViolationConstraint } from "./shared.js";
import { apiError } from "../errors.js";
import {
  addComment,
  deleteComment,
  editComment,
  loadCommentProjection,
  type CommentDerived,
  type CommentViewer,
} from "../services/comments.js";

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
const commentParamsSchema = z.object({ ticketId: z.uuid(), commentId: z.uuid() });

/** Stesso tetto del POST: una modifica non può allungare un commento oltre. */
const editCommentBodySchema = z.object({ body: z.string().min(1).max(20_000) });

const WRITE_ERRORS = {
  comment_not_found: [404, "Comment not found on this ticket"],
  comment_deleted: [409, "Comment has been deleted"],
  forbidden: [403, "Not allowed to change this comment"],
} as const;

type CommentRow = typeof comments.$inferSelect;

function toPublicComment(row: CommentRow, derived: CommentDerived): z.infer<typeof commentSchema> {
  return {
    id: row.id,
    ticketId: row.ticketId,
    authorType: row.authorType,
    authorId: row.authorId,
    // Un eliminato ha già `body = ''` (CHECK della 0084): il testo non esiste.
    body: row.body,
    createdAt: row.createdAt.toISOString(),
    // Derivati a lettura, per CHI GUARDA (`loadCommentProjection`).
    ...derived,
  };
}

/** Chi guarda: `requireAuth` è passato, quindi `request.user` è popolato. */
function viewerOf(request: { user?: { id: string; role: "admin" | "member" } | null }): CommentViewer {
  const user = request.user;
  if (!user) throw new Error("commenti: request.user assente dopo requireAuth");
  return { id: user.id, role: user.role };
}

/**
 * True se `commentId` è un commento VIVO di `ticketId`: a un commento
 * eliminato non si risponde (D1, piano 2026-10-05). Un campo di risposta
 * aperto prima della cancellazione, o un'app vecchia che vede una riga vuota
 * con «Reply», riceve lo stesso 422 `reply_target_invalid` che sa già
 * mostrare.
 */
async function isCommentOfTicket(db: Db, commentId: string, ticketId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: comments.id })
    .from(comments)
    .where(
      and(eq(comments.id, commentId), eq(comments.ticketId, ticketId), isNull(comments.deletedAt)),
    );
  return row !== undefined;
}

/** Il vincolo della FK self-reference del padre (0083). */
const REPLY_TARGET_FK = "comments_reply_to_comment_id_comments_id_fk";

/**
 * True SOLO se l'errore è la violazione della FK del padre: il commento a cui
 * si risponde è sparito fra il controllo e l'insert. Un'altra FK della tabella
 * (il ticket, l'autore) non è un «reply target invalid», e tradurla così
 * mentirebbe: quella risale come errore vero.
 */
export function isReplyTargetFkViolation(error: unknown): boolean {
  return foreignKeyViolationConstraint(error) === REPLY_TARGET_FK;
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
        if (replyToCommentId !== undefined && isReplyTargetFkViolation(error)) {
          return apiError(reply, 422, "reply_target_invalid", "Reply target is not a comment of this ticket");
        }
        throw error;
      }
      const derive = await loadCommentProjection(app.db, ticketId, [created], viewerOf(request));
      return reply.code(201).send(toPublicComment(created, derive(created)));
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
      const derive = await loadCommentProjection(app.db, ticketId, rows, viewerOf(request));
      return rows.map((row) => toPublicComment(row, derive(row)));
    },
  );

  /**
   * MODIFICA un commento (piano 2026-10-05, decisione 1 e 3): solo l'autore,
   * solo un commento `user`, mai uno eliminato — e nemmeno un admin. 200 col
   * commento aggiornato, per chi guarda. Un corpo identico non segna
   * «modificato». Errori: 404 `comment_not_found` (assente o di un altro
   * ticket), 409 `comment_deleted`, 403 `forbidden`.
   */
  app.patch(
    "/:commentId",
    {
      preHandler: requireAuth,
      schema: {
        params: commentParamsSchema,
        body: editCommentBodySchema,
        response: {
          200: commentSchema,
          404: errorSchema,
          409: errorSchema,
          ...authErrorResponses,
        },
      },
    },
    async (request, reply) => {
      const { ticketId, commentId } = request.params;
      const viewer = viewerOf(request);
      const result = await editComment(app.db, {
        ticketId,
        commentId,
        actor: viewer,
        body: request.body.body,
      });
      if (!result.ok) {
        const [status, message] = WRITE_ERRORS[result.error];
        return apiError(reply, status, result.error, message);
      }
      const derive = await loadCommentProjection(app.db, ticketId, [result.row], viewer);
      return toPublicComment(result.row, derive(result.row));
    },
  );

  /**
   * CANCELLA un commento (decisione 1 e 2): l'autore o un admin, mai un
   * commento dell'AI o di sistema. La riga resta come segnaposto, il TESTO
   * sparisce dal database (`body = ''`, garantito anche da un CHECK). 204,
   * idempotente: una seconda cancellazione non riscrive chi né quando. Gli
   * allegati del commento se ne vanno con lui (D3): righe nella transazione,
   * oggetti dallo storage dopo, best-effort.
   *
   * ⚠️ LIMITI DICHIARATI (piano L1/L2): se il commento è il testo di un
   * rifiuto del piano, lo stesso testo resta nel registro decisioni — un
   * registro di FATTI che non si riscrive; la risposta dei commenti lo dice
   * con `inDecisionLog`, e la conferma della UI lo mostra. Ciò che l'agente
   * ne ha già tratto (piano, PR, log) non si tocca. «Sparisce davvero» vale
   * per le righe vive: tuple morte fino al vacuum, WAL, backup e la cache
   * persistita sui telefoni (fino al prossimo refetch) lo conservano.
   */
  app.delete(
    "/:commentId",
    {
      preHandler: requireAuth,
      schema: {
        params: commentParamsSchema,
        response: {
          204: z.null(),
          404: errorSchema,
          ...authErrorResponses,
        },
      },
    },
    async (request, reply) => {
      const { ticketId, commentId } = request.params;
      const result = await deleteComment(app.db, {
        ticketId,
        commentId,
        actor: viewerOf(request),
      });
      if (!result.ok) {
        const [status, message] = WRITE_ERRORS[result.error];
        return apiError(reply, status, result.error, message);
      }
      if (result.storageKeys.length > 0) {
        // Best-effort, come `DELETE /attachments/:id`: le righe sono già
        // sparite, un oggetto orfano resta a carico della lifecycle del bucket.
        // TUTTO dentro il try, anche `app.storage()`: la cancellazione è già
        // committata, e un 500 a questo punto direbbe al client che non è
        // avvenuta — riproverebbe su un commento già eliminato.
        try {
          const storage = await app.storage();
          if (storage) {
            for (const key of result.storageKeys) {
              try {
                await storage.deleteObject(key);
              } catch (error) {
                request.log.error(error, "delete dell'oggetto di un allegato di commento fallita");
              }
            }
          }
        } catch (error) {
          request.log.error(error, "storage non disponibile: oggetti degli allegati del commento non rimossi");
        }
      }
      return reply.code(204).send(null);
    },
  );
}
