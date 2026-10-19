import { type AgentSessionQuestion, type Reader } from "@stubwise/shared";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  answerTicketQuestion,
  ApiError,
  type AnswerBody,
  type InboxQuestion,
} from "../../lib/api";
import { agentSessionKeys, inboxKeys, ticketKeys } from "../../lib/queries";
import { Markdown } from "../markdown";
import { answerErrorMessage, QuestionPanel } from "../question-panel";
import { QuestionAnswer, useQuestionStatusSuffix } from "./question-answer";

type SessionQuestionData = Reader<AgentSessionQuestion>;

/** Dove si risponde a questa domanda, o `null` se da qui non si può. */
function answerTarget(
  q: SessionQuestionData,
): { ticketId: string } | null {
  if (q.answered || !(q.canAnswer ?? false)) return null;
  if (q.source === "agent" && q.ticketId) return { ticketId: q.ticketId };
  // Origine ignota (segnaposto del reader) o riferimento assente: si legge e basta.
  return null;
}

/**
 * Una domanda dell'agente dentro la sessione (piano B, Task 7). Si risponde con
 * le rotte ESISTENTI e col pannello esistente: rispondere non è intervenire,
 * quindi può farlo anche un member richiedente — chi può lo dice il server
 * (`canAnswer`), mai il ruolo. Le domande sono solo dei job dei ticket (le
 * domande della chat del backlog non esistono più, 19 ott 2026).
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
  const statusSuffix = useQuestionStatusSuffix(q);

  const answer = useMutation({
    mutationFn: (body: AnswerBody): Promise<unknown> => {
      if (target === null) throw new Error("question not answerable");
      return answerTicketQuestion(target.ticketId, q.id, body);
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
    if (target !== null) {
      void queryClient.invalidateQueries({ queryKey: ticketKeys.questions(target.ticketId) });
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
        {statusSuffix}
      </p>
      <div className="mt-1 text-fg">
        <Markdown question source={q.question} />
      </div>
      <QuestionAnswer question={q} />
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
