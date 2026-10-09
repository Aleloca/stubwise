import { type AgentSessionQuestion, type Reader } from "@stubwise/shared";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  answerBacklogQuestion,
  answerTicketQuestion,
  ApiError,
  type AnswerBody,
  type InboxQuestion,
} from "../../lib/api";
import { agentSessionKeys, backlogKeys, inboxKeys, ticketKeys } from "../../lib/queries";
import { answerErrorMessage, QuestionPanel } from "../question-panel";

type SessionQuestionData = Reader<AgentSessionQuestion>;

/** Dove si risponde a questa domanda, o `null` se da qui non si può. */
function answerTarget(
  q: SessionQuestionData,
): { source: "agent"; ticketId: string } | { source: "backlog"; itemId: string } | null {
  if (q.answered || !(q.canAnswer ?? false)) return null;
  if (q.source === "agent" && q.ticketId) return { source: "agent", ticketId: q.ticketId };
  if (q.source === "backlog" && q.backlogItemId) return { source: "backlog", itemId: q.backlogItemId };
  // Origine ignota (segnaposto del reader) o riferimento assente: si legge e basta.
  return null;
}

/**
 * Una domanda dell'agente dentro la sessione (piano B, Task 7). Si risponde con
 * le rotte ESISTENTI e col pannello esistente: rispondere non è intervenire,
 * quindi può farlo anche un member richiedente — chi può lo dice il server
 * (`canAnswer`), mai il ruolo. Una domanda di backlog si risponde anche se la
 * voce non ha un'analisi attiva (regola del server): qui non si promette che
 * il lavoro riparta.
 *
 * `anchor`: la prima domanda aperta porta `id="question"`, il bersaglio del
 * link `#question` (Task 8).
 */
export function SessionQuestion({
  sessionId,
  question: q,
  anchor = false,
}: {
  sessionId: string;
  question: SessionQuestionData;
  anchor?: boolean;
}) {
  const { t } = useTranslation("agents");
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const target = answerTarget(q);

  const answer = useMutation({
    mutationFn: (body: AnswerBody): Promise<unknown> => {
      if (target === null) throw new Error("question not answerable");
      return target.source === "agent"
        ? answerTicketQuestion(target.ticketId, q.id, body)
        : answerBacklogQuestion(target.itemId, q.id, body);
    },
    onMutate: () => setError(null),
    onSuccess: () => invalidate(),
    onError: (cause) => {
      setError(answerErrorMessage(cause, t));
      // Un 409 dice che quello che si ha davanti è stantio: si rilegge.
      if (cause instanceof ApiError && cause.status === 409) invalidate();
    },
  });

  function invalidate() {
    void queryClient.invalidateQueries({ queryKey: agentSessionKeys.detail(sessionId) });
    void queryClient.invalidateQueries({ queryKey: inboxKeys.all });
    if (target?.source === "agent") {
      void queryClient.invalidateQueries({ queryKey: ticketKeys.questions(target.ticketId) });
    } else if (target?.source === "backlog") {
      // Come la chat del backlog (`backlog-chat.tsx`).
      void queryClient.invalidateQueries({ queryKey: backlogKeys.detail(target.itemId) });
    }
  }

  const panelQuestion: InboxQuestion = {
    questionId: q.id,
    round: q.round,
    question: q.question,
    options: q.options ?? [],
    recommendedIndex: q.recommendedIndex,
    allowFreeText: q.allowFreeText ?? false,
  };

  return (
    <div
      id={anchor ? "question" : undefined}
      className="scroll-mt-4 rounded-sm border border-line bg-ink-900 px-3 py-2"
    >
      <p className="font-mono text-[11px] tracking-[0.14em] text-fg-faint uppercase">
        {t("question.title")}
        {q.answered ? ` · ${t("question.answered")}` : ""}
      </p>
      <p className="mt-1 text-sm whitespace-pre-wrap text-fg">{q.question}</p>
      {target !== null && (
        <div className="mt-2">
          <QuestionPanel
            question={panelQuestion}
            showQuestionText={false}
            onSubmit={(body) => answer.mutate(body)}
            pending={answer.isPending}
            error={error}
          />
        </div>
      )}
    </div>
  );
}
