import { agentSessionEvents, agentSessions, claudeConversationQuestions, claudeConversations, type Db } from "@stubwise/db";
import { AGENT_SESSION_EVENTS_CHANNEL } from "@stubwise/shared";
import { and, eq, isNull, sql } from "drizzle-orm";
import { INVALID_QUESTION_TEXT, parseChatQuestion } from "./mention.js";

/** Il segmento degli eventi scritti fuori da un turno del CLI (come le proposte del server). */
const EVENT_SEGMENT = "stubwise-claude-actions";

/**
 * Area 10, F2: `ask_question` nella conversazione LIBERA. UNA domanda per turno
 * (l'input che lo apre: indice unico), scritta dal worker — il token del turno
 * resta GET-only più le proposte. Si scrivono la domanda e l'evento `question`
 * (solo `{ questionId }`: testo e opzioni si leggono dalla tabella), poi il
 * modello chiude il turno; la risposta della persona arriva come un suo
 * messaggio (`POST …/questions/:questionId/answer`) e il turno riparte.
 */
export async function askConversationQuestion(db: Db, sessionId: string, inputId: string, args: Record<string, unknown>): Promise<{ ok: boolean; text: string }> {
  const parsed = parseChatQuestion(args);
  if (!parsed) return { ok: false, text: INVALID_QUESTION_TEXT };
  const [conv] = await db
    .select({ id: claudeConversations.sessionId })
    .from(claudeConversations)
    .innerJoin(agentSessions, eq(agentSessions.id, claudeConversations.sessionId))
    .where(and(eq(claudeConversations.sessionId, sessionId), eq(agentSessions.kind, "free"), isNull(claudeConversations.archivedAt)));
  if (!conv) return { ok: false, text: "You cannot ask now: this conversation is closed." };
  const asked = await db.transaction(async (tx) => {
    const [q] = await tx
      .insert(claudeConversationQuestions)
      .values({ sessionId, inputId, text: parsed.question, options: parsed.options })
      .onConflictDoNothing()
      .returning({ id: claudeConversationQuestions.id });
    if (!q) return null;
    const [event] = await tx
      .insert(agentSessionEvents)
      .values({ sessionId, segmentId: EVENT_SEGMENT, type: "question", data: { questionId: q.id } })
      .returning({ id: agentSessionEvents.id });
    await tx.update(claudeConversationQuestions).set({ eventId: event!.id }).where(eq(claudeConversationQuestions.id, q.id));
    return q.id;
  });
  if (!asked) return { ok: false, text: "You already asked your one question in this answer: say what is still unclear in words." };
  await db.execute(sql`select pg_notify(${AGENT_SESSION_EVENTS_CHANNEL}, ${JSON.stringify({ sessionId })})`).catch(() => undefined);
  return {
    ok: true,
    text: "The question is shown to the person as a card with your options. End your turn now, with nothing else: when they answer, you will continue.",
  };
}
