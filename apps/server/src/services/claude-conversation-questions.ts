import { agentSessionInputs, claudeConversationQuestions, claudeConversations, users, type Db } from "@stubwise/db";
import type { AnswerClaudeQuestionInput, ClaudeConversationQuestion } from "@stubwise/shared";
import { and, asc, desc, eq, inArray, isNotNull, isNull, lt } from "drizzle-orm";
import type { SessionUser } from "../auth/session.js";
import { readerLimits } from "../claude-actions/proposals.js";
import { sendAgentMessage, type SendAgentMessageResult } from "./agent-sessions.js";
import { personName } from "./people.js";

/**
 * Area 10, F2: le domande a scelta di Claude nella conversazione libera. Le
 * scrive il worker (`askConversationQuestion`); qui si leggono e si risponde.
 * Chi legge una pubblica vede solo quelle prima del seguito privato, come le
 * proposte (`readerLimits`); risponde SOLO l'autore, e la risposta entra come un
 * suo messaggio nella STESSA transazione che segna la domanda.
 */
export async function listConversationQuestions(db: Db, user: SessionUser, sessionId: string): Promise<ClaudeConversationQuestion[]> {
  const limits = await readerLimits(db, user, sessionId);
  const rows = await db
    .select()
    .from(claudeConversationQuestions)
    .where(
      and(
        eq(claudeConversationQuestions.sessionId, sessionId),
        limits ? and(isNotNull(claudeConversationQuestions.eventId), lt(claudeConversationQuestions.eventId, limits.cut)) : undefined,
      ),
    )
    .orderBy(asc(claudeConversationQuestions.createdAt));
  const ids = [...new Set(rows.flatMap((r) => (r.answeredBy ? [r.answeredBy] : [])))];
  const people = ids.length > 0 ? await db.select({ id: users.id, email: users.email, displayName: users.displayName }).from(users).where(inArray(users.id, ids)) : [];
  const nameOf = new Map(people.map((p) => [p.id, personName(p)]));
  return rows.map((r) => ({
    id: r.id,
    text: r.text,
    options: r.options,
    answer:
      r.answeredAt === null
        ? null
        : {
            index: r.answerOptionIndex,
            text: r.answerText,
            by: r.answeredBy ? { id: r.answeredBy, name: nameOf.get(r.answeredBy) ?? "" } : null,
            at: r.answeredAt.toISOString(),
          },
  }));
}

export type AnswerQuestionResult =
  | { ok: true; inputId: string }
  | { ok: false; error: "not_found" | "forbidden" | "answered" | "stale" | "invalid_option" | Exclude<SendAgentMessageResult, { ok: true }>["error"] };

/**
 * Review di F2 (I3, M5): la risposta che entra nella conversazione porta la
 * DOMANDA, «<domanda>» → <scelta>: il modello non legge gli eventi `question`
 * (la trascrizione recente è fatta di messaggi), e senza la domanda una
 * risposta «Supporto» non dice a cosa risponde. È anche il segno, nel testo,
 * che quel messaggio risponde a una domanda.
 */
export const answerText = (question: string, choice: string) => `«${question}» → ${choice}`;

class Refused extends Error {
  constructor(readonly result: Exclude<AnswerQuestionResult, { ok: true }>) {
    super(result.error);
  }
}

export async function answerConversationQuestion(
  db: Db,
  user: SessionUser,
  sessionId: string,
  questionId: string,
  input: AnswerClaudeQuestionInput,
): Promise<AnswerQuestionResult> {
  const [conv] = await db.select({ ownerId: claudeConversations.ownerId }).from(claudeConversations).where(eq(claudeConversations.sessionId, sessionId));
  if (!conv) return { ok: false, error: "not_found" };
  // Una pubblica la leggono altri: rispondere è dell'autore.
  if (conv.ownerId !== user.id) return { ok: false, error: "forbidden" };
  try {
    return await db.transaction(async (tx) => {
      const [q] = await tx
        .select()
        .from(claudeConversationQuestions)
        .where(and(eq(claudeConversationQuestions.id, questionId), eq(claudeConversationQuestions.sessionId, sessionId)))
        .for("update");
      if (!q) throw new Refused({ ok: false, error: "not_found" });
      if (q.answeredAt !== null) throw new Refused({ ok: false, error: "answered" });
      // Review di F2 (M4): la domanda vale finché il suo turno è l'ultimo; se la
      // persona ha già scritto altro dopo, la conversazione è andata avanti.
      const [last] = await tx
        .select({ id: agentSessionInputs.id })
        .from(agentSessionInputs)
        .where(eq(agentSessionInputs.sessionId, sessionId))
        .orderBy(desc(agentSessionInputs.createdAt), desc(agentSessionInputs.id))
        .limit(1);
      if (last && last.id !== q.inputId) throw new Refused({ ok: false, error: "stale" });
      let choice: string;
      if ("index" in input) {
        const option = q.options[input.index];
        if (!option) throw new Refused({ ok: false, error: "invalid_option" });
        choice = option.label;
      } else {
        choice = input.text;
      }
      const text = answerText(q.text, choice);
      // Il messaggio della persona: la stessa strada di ogni suo messaggio
      // (budget, archiviata, permessi). Se rifiuta, la domanda NON resta segnata.
      const sent = await sendAgentMessage(tx as unknown as Db, { sessionId, actor: user, text, interrupt: false });
      if (!sent.ok) throw new Refused(sent);
      const marked = await tx
        .update(claudeConversationQuestions)
        .set({
          answeredAt: new Date(),
          answeredBy: user.id,
          ...("index" in input ? { answerOptionIndex: input.index } : { answerText: input.text }),
        })
        .where(and(eq(claudeConversationQuestions.id, q.id), isNull(claudeConversationQuestions.answeredAt)))
        .returning({ id: claudeConversationQuestions.id });
      if (marked.length === 0) throw new Refused({ ok: false, error: "answered" });
      return { ok: true as const, inputId: sent.inputId };
    });
  } catch (error) {
    if (error instanceof Refused) return error.result;
    throw error;
  }
}
