import type { AgentSessionQuestion, Reader } from "@stubwise/shared";
import { useTranslation } from "react-i18next";
import { answerLabel } from "../../lib/question-answer";
import { InlineMarkdown } from "../markdown";

type SessionQuestionData = Reader<AgentSessionQuestion>;

/**
 * Il suffisso del titolo di una domanda chiusa: «Risposta data». (Il «Non
 * ora» era delle sole domande della chat del backlog, dismesse il 19 ott 2026.)
 */
export function useQuestionStatusSuffix(q: SessionQuestionData): string {
  const { t } = useTranslation("agents");
  if (!q.answered) return "";
  return ` · ${t("question.answered")}`;
}

/**
 * COSA è stato risposto a una domanda della sessione, con lo stesso linguaggio
 * dello storico delle Q&A sulla pagina ticket (`PastQuestion`): la riga in
 * `text-signal` con l'etichetta dell'opzione scelta (markdown inline) o il
 * testo libero com'è stato scritto. Senza una risposta leggibile — server più
 * vecchio senza il campo, jsonb di una versione precedente — non
 * disegna niente: resta la sola dicitura del titolo, come prima.
 */
export function QuestionAnswer({ question }: { question: SessionQuestionData }) {
  const { t } = useTranslation("agents");
  if (!question.answered) return null;
  const label = answerLabel({ answer: question.answer ?? null, options: question.options });
  if (label === null) return null;
  return (
    <p className="mt-1 text-sm text-signal" data-testid={`session-question-answer-${question.id}`}>
      <span className="sr-only">{t("question.answerLabel")} </span>
      {label.option ? <InlineMarkdown source={label.text} /> : label.text}
    </p>
  );
}
