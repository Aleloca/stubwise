import { useId, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useAnswerQuestion } from "../../../data/queries";
import { inputClass } from "../../../tasks-ui/Dialog";
import type { Ev } from "./flow";
import {
  cardClass,
  clock,
  primaryButton,
  quietButton,
  useFocusWhenResolved,
  usePersonName,
} from "./parts";

/** Il pallino «ti aspetta» nell'intestazione di una scheda che chiede a me. */
export function WaitingDot({ label }: { label: string }) {
  return (
    <span className="flex items-center gap-1.5 text-xs font-medium text-ink">
      <span aria-hidden="true" className="size-2 rounded-full bg-ink" />
      {label}
    </span>
  );
}

/**
 * La domanda di Claude (`ask_user`): opzioni come righe a tutta larghezza,
 * la consigliata per prima con l'etichetta «Recommended», «Other…» per una
 * risposta libera. Un clic risponde. Risposta: la scheda si riduce a una
 * riga. Chi non può rispondere legge le opzioni e chi può farlo; una
 * risposta arrivata prima da un altro dice chi.
 */
export function QuestionCard({
  conversationId,
  event,
  canAnswer,
  ownerId,
  projectCode,
}: {
  conversationId: string;
  event: Ev<"question">;
  canAnswer: boolean;
  ownerId: string;
  projectCode: string | null;
}) {
  const { t } = useTranslation();
  const answer = useAnswerQuestion();
  const owner = usePersonName(ownerId);
  return (
    <QuestionCardView
      event={event}
      canAnswer={canAnswer}
      pending={answer.isPending}
      onAnswer={(payload) =>
        answer.mutateAsync({ id: conversationId, questionId: event.questionId, answer: payload })
      }
      note={
        projectCode
          ? t("claude.conversation.question.whoCanAnswer", { name: owner, code: projectCode })
          : t("claude.conversation.question.ownerAnswers", { name: owner })
      }
    />
  );
}

/**
 * La scheda della domanda, ovunque stia (conversazione, thread della Chat):
 * `onAnswer` risponde, `title` sostituisce «Claude asks», `note` è la riga
 * per chi non può rispondere. `renderText`: come si scrive il testo della
 * domanda per chi guarda (R-E9 nella Chat).
 */
export function QuestionCardView({
  event,
  canAnswer,
  pending,
  onAnswer,
  note,
  title,
  renderText,
}: {
  event: Ev<"question">;
  canAnswer: boolean;
  pending: boolean;
  onAnswer: (payload: { optionIndex: number | null; text: string | null }) => Promise<unknown>;
  note: string;
  title?: string;
  renderText?: (text: string) => ReactNode;
}) {
  const { t, i18n } = useTranslation();
  const [other, setOther] = useState<string | null>(null);
  const [lostTo, setLostTo] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const answeredBy = usePersonName(event.answer?.byId ?? lostTo);
  const text = renderText ? renderText(event.text) : event.text;
  const otherId = useId();
  const headingId = useId();
  const resolvedRef = useFocusWhenResolved<HTMLParagraphElement>(event.answer !== null);

  // In ordine: la consigliata prima, poi le altre come le ha scritte Claude.
  const options = event.options
    .map((option, index) => ({ option, index }))
    .sort((a, b) => Number(!!b.option.recommended) - Number(!!a.option.recommended));

  if (event.answer) {
    const label =
      event.answer.optionIndex !== null
        ? (event.options[event.answer.optionIndex]?.label ?? "")
        : (event.answer.text ?? "");
    return (
      <p
        ref={resolvedRef}
        tabIndex={-1}
        className="event-enter flex min-w-0 flex-wrap items-baseline gap-x-1.5 rounded-md text-sm text-ink-muted"
      >
        <span className="text-ink">{text}</span>
        <span aria-hidden="true">—</span>
        <span>
          {t("claude.conversation.question.answeredBy", { name: answeredBy })}{" "}
          <span className="font-medium text-ink">{label}</span>
        </span>
        <span aria-hidden="true">·</span>
        <time className="num" dateTime={event.answer.at}>
          {clock(event.answer.at, i18n.language)}
        </time>
      </p>
    );
  }

  const send = (payload: { optionIndex: number | null; text: string | null }) => {
    setFailed(false);
    onAnswer(payload).catch((error: Error) => {
      if (error.message === "already_answered") {
        setLostTo((error as Error & { byId?: string | null }).byId ?? "");
      } else setFailed(true);
    });
  };
  const disabled = !canAnswer || pending || lostTo !== null;

  return (
    <section
      aria-labelledby={headingId}
      data-question={event.questionId}
      className={`${cardClass} gap-3 p-4`}
    >
      <header className="flex flex-wrap items-center justify-between gap-2">
        <h3 id={headingId} className="text-sm font-semibold text-ink">
          {title ?? t("claude.conversation.question.title")}
        </h3>
        {canAnswer && lostTo === null && (
          <WaitingDot label={t("claude.conversation.waitingOnYou")} />
        )}
      </header>
      <p className="max-w-[68ch] text-md text-ink">{text}</p>
      <ul className="flex flex-col gap-1.5">
        {options.map(({ option, index }) => {
          const content = (
            <>
              <span className="flex min-w-0 flex-wrap items-baseline gap-x-2">
                <span className="font-medium text-ink">{option.label}</span>
                {option.recommended && (
                  <span className="text-xs font-semibold text-ink-muted">
                    {t("claude.conversation.question.recommended")}
                  </span>
                )}
              </span>
              {option.consequence && (
                <span className="text-sm text-ink-muted">{option.consequence}</span>
              )}
            </>
          );
          const rowClass = `flex min-h-10 w-full min-w-0 flex-col justify-center gap-0.5 rounded-md border px-3 py-2 text-left text-md ${option.recommended ? "border-ink/40" : "border-rule"}`;
          return (
            <li key={index}>
              {canAnswer ? (
                <button
                  type="button"
                  disabled={disabled}
                  onClick={() => send({ optionIndex: index, text: null })}
                  className={`${rowClass} transition-colors duration-[var(--duration-fast)] ease-out hover:bg-ink/5 active:bg-ink/10 disabled:opacity-60`}
                >
                  {content}
                </button>
              ) : (
                <div className={rowClass}>{content}</div>
              )}
            </li>
          );
        })}
        {canAnswer && (
          <li>
            {other === null ? (
              <button
                type="button"
                disabled={disabled}
                onClick={() => setOther("")}
                className="flex min-h-10 w-full items-center rounded-md border border-dashed border-rule-strong px-3 text-left text-md text-ink-muted transition-colors duration-[var(--duration-fast)] ease-out hover:bg-ink/5 hover:text-ink"
              >
                {t("claude.conversation.question.other")}
              </button>
            ) : (
              <form
                className="flex flex-col gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (other.trim()) send({ optionIndex: null, text: other.trim() });
                }}
              >
                <label htmlFor={otherId} className="sr-only">
                  {t("claude.conversation.question.otherLabel")}
                </label>
                <textarea
                  id={otherId}
                  autoFocus
                  rows={2}
                  value={other}
                  onChange={(e) => setOther(e.target.value)}
                  placeholder={t("claude.conversation.question.otherPlaceholder")}
                  className={`${inputClass} resize-none`}
                />
                <div className="flex flex-wrap justify-end gap-2">
                  <button type="button" className={quietButton} onClick={() => setOther(null)}>
                    {t("claude.conversation.cancel")}
                  </button>
                  <button
                    type="submit"
                    className={primaryButton}
                    disabled={disabled || !other.trim()}
                  >
                    {t("claude.conversation.question.send")}
                  </button>
                </div>
              </form>
            )}
          </li>
        )}
      </ul>
      {lostTo !== null && (
        <p role="status" className="text-sm text-ink">
          {t("claude.conversation.question.alreadyAnswered", { name: answeredBy })}
        </p>
      )}
      {failed && (
        <p role="alert" className="text-sm text-critical">
          {t("claude.conversation.question.failed")}
        </p>
      )}
      {!canAnswer && <p className="text-sm text-ink-muted">{note}</p>}
    </section>
  );
}
