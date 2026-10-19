import type {
  AgentSessionQuestion,
  AnswerBody,
  InboxQuestion,
  Reader,
  TranscriptItem,
} from "@stubwise/shared";
import { ApiError } from "@stubwise/api-client";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { StyleSheet, Text, View } from "react-native";
import { agentSessionKeys, inboxKeys } from "../../lib/query-keys";
import { useAnswerQuestion } from "../../lib/work-mutations";
import { colors, radii } from "../../theme/tokens";
import { fontFamily, fontSize } from "../../theme/typography";
import { QuestionForm } from "../inbox/QuestionForm";
import { TranscriptItemView } from "./TranscriptItemView";

type SessionQuestionData = Reader<AgentSessionQuestion>;
type QuestionItem = Extract<TranscriptItem, { kind: "question" }>;

/**
 * Dove si risponde a questa domanda, o `null` se da qui non si può. Stessa
 * regola di `answerTarget` in `apps/web/src/components/agent-session/session-question.tsx`:
 * già risposta, `canAnswer` falso (lo decide il SERVER, mai il ruolo),
 * origine ignota (segnaposto del reader) o riferimento assente → si legge e basta.
 * Fino al 19 ott 2026 c'era anche l'origine `backlog` (le domande a bottoni
 * della chat CODE di una voce): dismessa con la chat stessa.
 */
export function answerTarget(q: SessionQuestionData): { source: "agent"; ticketId: string } | null {
  if (q.answered || !(q.canAnswer ?? false)) return null;
  if (q.source === "agent" && q.ticketId) return { source: "agent", ticketId: q.ticketId };
  return null;
}

/**
 * Una domanda dell'agente dentro la sessione (piano C, Task 7). Si risponde con
 * la rotta e la mutazione ESISTENTI (`useAnswerQuestion` sul ticket) e col
 * `QuestionForm` di sempre: rispondere non è intervenire, quindi può farlo
 * anche un member richiedente — chi può lo dice `canAnswer`. Senza un
 * bersaglio la domanda resta la riga in sola lettura della trascrizione.
 *
 * Oltre a ciò che la mutazione già invalida (il ticket), si rilegge la
 * sessione e l'inbox — anche su un 409, che dice che quello che si ha davanti
 * è stantio.
 */
export function SessionQuestion({
  sessionId,
  item,
  live,
}: {
  sessionId: string;
  item: QuestionItem;
  live: boolean;
}) {
  const target = answerTarget(item.question);
  if (target === null) return <TranscriptItemView item={item} live={live} />;
  return <AgentQuestionAnswer sessionId={sessionId} question={item.question} ticketId={target.ticketId} />;
}

function useSessionInvalidation(sessionId: string) {
  const queryClient = useQueryClient();
  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: agentSessionKeys.detail(sessionId) });
    void queryClient.invalidateQueries({ queryKey: inboxKeys.all });
  };
  return {
    onSuccess: invalidate,
    onError: (error: unknown) => {
      if (error instanceof ApiError && error.status === 409) invalidate();
    },
  };
}

function AgentQuestionAnswer({
  sessionId,
  question,
  ticketId,
}: {
  sessionId: string;
  question: SessionQuestionData;
  ticketId: string;
}) {
  const answer = useAnswerQuestion(ticketId);
  const after = useSessionInvalidation(sessionId);
  return (
    <QuestionBlock
      question={question}
      onSubmit={(body) => answer.mutate({ questionId: question.id, answer: body }, after)}
      pending={answer.isPending}
      disabled={answer.disabled}
      online={answer.online}
      errorMessage={answer.errorMessage}
    />
  );
}

function QuestionBlock({
  question,
  onSubmit,
  pending,
  disabled,
  online,
  errorMessage,
}: {
  question: SessionQuestionData;
  onSubmit: (body: AnswerBody) => void;
  pending: boolean;
  disabled: boolean;
  online: boolean;
  errorMessage: string | null;
}) {
  const { t } = useTranslation();
  const formQuestion: Reader<InboxQuestion> = {
    questionId: question.id,
    round: question.round,
    question: question.question,
    options: question.options ?? [],
    recommendedIndex: question.recommendedIndex,
    allowFreeText: question.allowFreeText ?? false,
  };
  return (
    <View style={styles.block} testID={`transcript-question-${question.id}`}>
      <Text style={styles.title}>{t("mobile.agents.question.title")}</Text>
      <QuestionForm
        question={formQuestion}
        onSubmit={onSubmit}
        pending={pending}
        disabled={disabled}
        online={online}
        errorMessage={errorMessage}
        testIDPrefix={`session-question-${question.id}`}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  block: {
    backgroundColor: colors.ink900,
    borderColor: colors.line,
    borderRadius: radii.control,
    borderWidth: 1,
    gap: 6,
    padding: 12,
  },
  title: {
    color: colors.faint,
    fontFamily: fontFamily.mono,
    fontSize: fontSize.label,
    letterSpacing: 1.2,
    textTransform: "uppercase",
  },
});
