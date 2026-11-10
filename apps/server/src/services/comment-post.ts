import { comments, tickets, type Db } from "@stubwise/db";
import { and, eq, isNull } from "drizzle-orm";
import { foreignKeyViolationConstraint } from "../routes/shared.js";
import { addComment, type CommentRow } from "./comments.js";
import { notifyTaskActivity } from "./task-notify.js";

/**
 * Un commento di una PERSONA su una task (`POST /api/tickets/:ticketId/comments`),
 * estratto dalla rotta perché lo usa anche l'esecutore delle azioni di Claude
 * (chat, fetta 3): la stessa scrittura, gli stessi rifiuti, lo stesso avviso
 * ai follower (il riferimento al commento, MAI il testo). Il permesso
 * (`tickets.comment`) e la visibilità li controlla il chiamante, come la rotta.
 */
export type PostCommentResult =
  | { ok: true; comment: CommentRow }
  | { ok: false; error: "ticket_not_found" | "reply_target_invalid" };

/** Il vincolo della FK self-reference del padre (0083). */
const REPLY_TARGET_FK = "comments_reply_to_comment_id_comments_id_fk";

export async function postUserComment(
  db: Db,
  input: { ticketId: string; authorId: string; body: string; replyToCommentId: string | null },
): Promise<PostCommentResult> {
  const [ticket] = await db.select({ id: tickets.id }).from(tickets).where(eq(tickets.id, input.ticketId));
  if (!ticket) return { ok: false, error: "ticket_not_found" };
  // Il padre deve esistere, essere VIVO ed essere di QUESTO ticket: una
  // risposta non attraversa i ticket. Il controllo precede l'insert.
  if (input.replyToCommentId !== null) {
    const [parent] = await db
      .select({ id: comments.id })
      .from(comments)
      .where(and(eq(comments.id, input.replyToCommentId), eq(comments.ticketId, input.ticketId), isNull(comments.deletedAt)));
    if (!parent) return { ok: false, error: "reply_target_invalid" };
  }
  try {
    const comment = await db.transaction(async (tx) => {
      const row = await addComment(tx, {
        ticketId: input.ticketId,
        authorType: "user",
        authorId: input.authorId,
        body: input.body,
        replyToCommentId: input.replyToCommentId,
      });
      await notifyTaskActivity(tx, {
        ticketId: input.ticketId,
        actorUserId: input.authorId,
        change: "comment",
        summary: "",
        commentId: row.id,
      });
      return row;
    });
    return { ok: true, comment };
  } catch (error) {
    // Il padre è sparito fra il controllo e l'insert: la FK lo dice.
    if (input.replyToCommentId !== null && foreignKeyViolationConstraint(error) === REPLY_TARGET_FK) {
      return { ok: false, error: "reply_target_invalid" };
    }
    throw error;
  }
}
