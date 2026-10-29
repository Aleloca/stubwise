import { Link } from "@tanstack/react-router";
import { useId, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useAnswerQuestionNow, useDecidePlanNow, usePeople } from "../../../data/queries";
import type { ClaudeDecision, Person } from "../../../data/types";
import { relativeTime } from "../../../notifications/time";
import { inputClass } from "../../../tasks-ui/Dialog";
import { Avatar } from "../../../tasks-ui/PersonChip";
import { useToast } from "../../../tasks-ui/Toast";
import { ghostButton, smallPrimary, smallSecondary } from "../../task/parts";
import { deferAnswer } from "../pendingAnswers";

type Question = Extract<ClaudeDecision, { kind: "question" }>;
type Plan = Extract<ClaudeDecision, { kind: "plan" }>;

/**
 * Una domanda o un piano di Claude in «Decide», nella forma di una
 * richiesta di decisione: chi chiede (Claude, il suo anello), la domanda,
 * l'oggetto col codice, le opzioni sul posto. È lo stesso evento della
 * conversazione: la risposta passa dalle sue scritture (`answerQuestion`,
 * `decidePlan`), parte dopo la finestra dell'«Undo», e chiude la scheda
 * anche nella conversazione. Chi arriva secondo legge chi è arrivato prima.
 */
export function ClaudeDecisionItem({
  decision,
  onOpenTask,
}: {
  decision: ClaudeDecision;
  onOpenTask: (code: string) => void;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const { data: people } = usePeople();
  const name = (id: string | null | undefined) =>
    people?.find((p) => p.id === id)?.name ?? t("taskUi.stall.someone");
  const label = decision.objectCode ?? decision.title;

  /** Tiene la risposta nella finestra dell'«Undo», poi la manda; dice com'è andata. */
  const defer = (send: () => Promise<unknown>, done: string, failed: string) => {
    const cancel = deferAnswer(decision.id, send, (error) => {
      const byId = (error as { byId?: string | null } | null)?.byId;
      if ((error as Error | null)?.message === "already_answered") {
        toast.show(
          t(
            decision.kind === "plan"
              ? "home.decide.claude.alreadyDecided"
              : "home.decide.claude.alreadyAnswered",
            { name: name(byId) },
          ),
        );
      } else toast.error(failed);
    });
    toast.show(done, { action: { label: t("home.decide.undo"), run: cancel } });
  };

  const claude = people?.find((p) => p.isClaude);
  return decision.kind === "question" ? (
    <QuestionItem
      decision={decision}
      claude={claude}
      onOpenTask={onOpenTask}
      defer={defer}
      label={label}
    />
  ) : (
    <PlanItem
      decision={decision}
      claude={claude}
      onOpenTask={onOpenTask}
      defer={defer}
      label={label}
    />
  );
}

type Defer = (send: () => Promise<unknown>, done: string, failed: string) => void;

interface ItemProps<D> {
  decision: D;
  claude: Person | undefined;
  onOpenTask: (code: string) => void;
  defer: Defer;
  /** Il codice dell'oggetto, o il titolo della libera: nei messaggi. */
  label: string;
}
function QuestionItem({ decision, claude, onOpenTask, defer, label }: ItemProps<Question>) {
  const { t } = useTranslation();
  const answerNow = useAnswerQuestionNow();
  return (
    <Shell
      decision={decision}
      claude={claude}
      heading={t("home.decide.claude.asks")}
      onOpenTask={onOpenTask}
      content={<QuestionText text={decision.text} />}
      actions={
        <ClaudeAnswers
          question={decision.text}
          options={decision.options}
          onAnswer={(answer) =>
            defer(
              () => answerNow(decision.conversationId, decision.questionId, answer),
              t("home.decide.answered", { code: label }),
              t("home.decide.answerFailed", { code: label }),
            )
          }
        />
      }
    />
  );
}

/** Il testo di una domanda in «Decide»: due righe al più, intero nel `title`. */
export function QuestionText({ text }: { text: string }) {
  return (
    <p
      title={text}
      className="line-clamp-2 max-w-[72ch] text-lg font-medium text-ink [overflow-wrap:anywhere]"
    >
      {text}
    </p>
  );
}

/**
 * Le risposte a una domanda di Claude sul posto: le opzioni come bottoni (la
 * consigliata prima, con cosa comporta a vista), più «Other…» a testo
 * libero. La stessa forma per la conversazione e per @Claude nella Chat.
 */
export function ClaudeAnswers({
  question,
  options: given,
  onAnswer,
}: {
  question: string;
  options: Question["options"];
  onAnswer: (answer: { optionIndex: number | null; text: string | null }) => void;
}) {
  const { t } = useTranslation();
  // Senza opzioni si risponde solo a parole: il campo è già aperto.
  const free = given.length === 0;
  const [other, setOther] = useState(free);
  const [text, setText] = useState("");
  const textId = useId();
  // In ordine: la consigliata prima, come nella conversazione.
  const options = given
    .map((option, index) => ({ option, index }))
    .sort((a, b) => Number(!!b.option.recommended) - Number(!!a.option.recommended));

  return other ? (
    <form
      className="flex max-w-[72ch] flex-col gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (text.trim()) onAnswer({ optionIndex: null, text: text.trim() });
      }}
    >
      <label htmlFor={textId} className="sr-only">
        {t("home.decide.yourAnswer")}
      </label>
      <textarea
        id={textId}
        rows={2}
        autoFocus={!free}
        value={text}
        placeholder={t("home.decide.yourAnswer")}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape" && !free) {
            e.stopPropagation();
            setOther(false);
          }
        }}
        className={`${inputClass} resize-y`}
      />
      <div className="flex gap-2">
        <button type="submit" className={smallPrimary} disabled={!text.trim()}>
          {t("home.decide.send")}
        </button>
        {!free && (
          <button type="button" className={ghostButton} onClick={() => setOther(false)}>
            {t("home.decide.cancel")}
          </button>
        )}
      </div>
    </form>
  ) : (
    <div
      role="group"
      aria-label={t("home.decide.options", { question })}
      className="flex flex-wrap gap-2"
    >
      {options.map(({ option, index }) => (
        <button
          key={index}
          type="button"
          className={`${smallSecondary} h-auto min-h-7 max-w-full flex-col items-start gap-0.5 py-1 text-left [overflow-wrap:anywhere] ${option.recommended ? "border-ink/60" : ""}`}
          onClick={() => onAnswer({ optionIndex: index, text: null })}
        >
          <span className="flex flex-wrap items-baseline gap-x-2">
            <span>{option.label}</span>
            {option.recommended && (
              <span className="text-xs font-semibold text-ink-muted">
                {t("home.decide.claude.recommended")}
              </span>
            )}
          </span>
          {/* Cosa comporta, a vista come nella conversazione (non solo al passaggio). */}
          {option.consequence && (
            <span className="max-w-[44ch] text-xs font-normal text-ink-muted">
              {option.consequence}
            </span>
          )}
        </button>
      ))}
      <button type="button" className={ghostButton} onClick={() => setOther(true)}>
        {t("home.decide.other")}
      </button>
    </div>
  );
}

function PlanItem({ decision, claude, onOpenTask, defer, label }: ItemProps<Plan>) {
  const { t } = useTranslation();
  const decideNow = useDecidePlanNow();
  const [rejecting, setRejecting] = useState<string | null>(null);
  const reasonId = useId();
  const hintId = useId();

  const decide = (choice: "approve" | "reject", instructions?: string) =>
    defer(
      () => decideNow(decision.conversationId, decision.planId, choice, instructions),
      t(choice === "approve" ? "home.decide.claude.approved" : "home.decide.claude.rejected", {
        code: label,
      }),
      t("home.decide.claude.planFailed", { code: label }),
    );

  // Correzione di server con l'approvazione spenta: resta qui finché tiene
  // occupato il server, ma l'unica decisione possibile è il rifiuto.
  const blocked = decision.blockedReason;
  return (
    <Shell
      decision={decision}
      claude={claude}
      heading={t(blocked ? "home.decide.claude.planRejectOnly" : "home.decide.claude.plan")}
      onOpenTask={onOpenTask}
      content={
        <>
          <p
            title={decision.summary}
            className="line-clamp-2 max-w-[72ch] text-lg font-medium text-ink [overflow-wrap:anywhere]"
          >
            {decision.summary}
          </p>
          {blocked && (
            <p role="note" data-plan-blocked className="max-w-[72ch] text-sm text-ink">
              {t(`home.decide.claude.blocked.${blocked}`, { code: decision.serverCode })}
            </p>
          )}
        </>
      }
      actions={
        rejecting === null ? (
          <div
            role="group"
            aria-label={
              decision.objectCode
                ? t("home.decide.claude.planOptions", { code: decision.objectCode })
                : t("home.decide.claude.planOptionsFree")
            }
            className="flex flex-wrap items-center gap-2"
          >
            {!blocked && (
              <button type="button" className={smallPrimary} onClick={() => decide("approve")}>
                {t("home.decide.claude.approve")}
              </button>
            )}
            <button type="button" className={smallSecondary} onClick={() => setRejecting("")}>
              {t("home.decide.claude.reject")}
            </button>
            <Link to="/claude/$id" params={{ id: decision.conversationId }} className={ghostButton}>
              {t("home.decide.claude.readPlan")}
            </Link>
          </div>
        ) : (
          <form
            className="flex max-w-[72ch] flex-col gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              decide("reject", rejecting.trim() || undefined);
            }}
          >
            <label htmlFor={reasonId} className="text-sm font-medium text-ink">
              {t("home.decide.claude.instructions")}
            </label>
            <textarea
              id={reasonId}
              rows={2}
              autoFocus
              value={rejecting}
              aria-describedby={hintId}
              onChange={(e) => setRejecting(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  e.stopPropagation();
                  setRejecting(null);
                }
              }}
              className={`${inputClass} resize-y`}
            />
            <p id={hintId} className="text-xs text-ink-muted">
              {t("home.decide.claude.instructionsHint")}
            </p>
            <div className="flex gap-2">
              <button type="submit" className={smallPrimary}>
                {t("home.decide.claude.rejectAndSend")}
              </button>
              <button type="button" className={ghostButton} onClick={() => setRejecting(null)}>
                {t("home.decide.cancel")}
              </button>
            </div>
          </form>
        )
      }
    />
  );
}

/**
 * La cornice comune, la stessa di una richiesta di decisione: chi chiede
 * con l'ora, il contenuto, l'oggetto citato col codice (la task apre il
 * pannello; una richiesta o una libera aprono la conversazione).
 */
function Shell({
  decision,
  claude,
  heading,
  onOpenTask,
  content,
  actions,
}: {
  decision: ClaudeDecision;
  claude: Person | undefined;
  heading: string;
  onOpenTask: (code: string) => void;
  /** La domanda o il riassunto del piano. */
  content: ReactNode;
  /** Le opzioni (o il campo aperto). */
  actions: ReactNode;
}) {
  const { t, i18n } = useTranslation();
  const objectClass =
    "flex min-w-0 items-baseline gap-2 self-start rounded-sm text-left text-sm text-ink-muted hover:text-ink";
  const object = (
    <>
      {decision.objectCode && (
        <span className="num shrink-0 text-xs font-semibold tracking-[0.02em] text-ink">
          {decision.objectCode}
        </span>
      )}
      <span className="min-w-0 truncate">{decision.title}</span>
    </>
  );
  return (
    <div
      data-claude-decision={decision.id}
      className="flex flex-col gap-2 border-b border-rule py-3 pr-3 pl-4"
    >
      <div className="flex items-center gap-2 text-sm text-ink-muted">
        <Avatar person={claude} />
        <span className="min-w-0 truncate">{heading}</span>
        <span aria-hidden="true" className="text-ink-faint">
          ·
        </span>
        <span className="num shrink-0 text-ink-faint">
          {relativeTime(decision.at, t, i18n.language)}
        </span>
      </div>
      {content}
      {decision.taskId && decision.objectCode ? (
        <button
          type="button"
          onClick={() => onOpenTask(decision.objectCode!)}
          className={objectClass}
        >
          {object}
        </button>
      ) : (
        <Link
          to="/claude/$id"
          params={{ id: decision.conversationId }}
          title={t("home.decide.claude.openConversation")}
          className={objectClass}
        >
          {object}
        </Link>
      )}
      {actions}
    </div>
  );
}
