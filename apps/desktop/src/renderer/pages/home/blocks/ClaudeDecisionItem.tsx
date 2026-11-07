import { Link, useNavigate } from "@tanstack/react-router";
import { useId, useRef, useState, type ReactNode } from "react";
import { Trans, useTranslation } from "react-i18next";
import {
  useAnswerProductQuestionNow,
  useAnswerQuestionNow,
  useDecidePlanNow,
  usePeople,
} from "../../../data/queries";
import type {
  ClaudeDecision,
  ConversationClaudeDecision,
  Person,
  ProductQuestionDecision,
} from "../../../data/types";
import { questionSentence } from "../../../domain/productDocs/claudeText";
import { openClaudePanel } from "../../../layout/claudePanel/panelEvents";
import { relativeTime } from "../../../notifications/time";
import { inputClass } from "../../../tasks-ui/Dialog";
import { Avatar } from "../../../tasks-ui/PersonChip";
import { useToast } from "../../../tasks-ui/Toast";
import { SourceLine } from "../../productDocs/claude/SourceLine";
import { QuestionAnswerButtons, QuestionSentence } from "../../productDocs/comments/QuestionThread";
import { ghostButton, smallPrimary, smallSecondary } from "../../task/parts";
import { answerAtOnce, deferAnswer } from "../pendingAnswers";

type Question = Extract<ConversationClaudeDecision, { kind: "question" }>;
type Plan = Extract<ConversationClaudeDecision, { kind: "plan" }>;

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
  // 11b: una domanda di Claude sulla doc di prodotto (shape product-claude-questions §3.4).
  if (decision.kind === "productQuestion") return <ProductQuestionItem decision={decision} />;
  return <ConversationDecisionItem decision={decision} onOpenTask={onOpenTask} />;
}

function ConversationDecisionItem({
  decision,
  onOpenTask,
}: {
  decision: ConversationClaudeDecision;
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
  // occupato il server, ma l'unica decisione possibile è il rifiuto, che la
  // chiude (niente indicazioni: un piano riscritto sarebbe bloccato uguale).
  const blocked = decision.blockedReason;
  // Un piano di correzione non si approva da qui: chi approva legge i comandi
  // uno per uno nella scheda della task (shape server-task §3, B1).
  const fix = decision.serverCode !== null && decision.taskId !== null;
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
          {blocked ? (
            <p role="note" data-plan-blocked className="max-w-[72ch] text-sm text-ink">
              {t(`home.decide.claude.blocked.${blocked}`, { code: decision.serverCode })}
            </p>
          ) : (
            fix && (
              <p className="max-w-[72ch] text-sm text-ink-muted">
                {t("home.decide.claude.fixFromTask", { code: decision.serverCode })}
              </p>
            )
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
            {fix && !blocked ? (
              <button
                type="button"
                className={smallPrimary}
                onClick={() => onOpenTask(decision.objectCode ?? "")}
              >
                {t("home.decide.claude.openTask")}
              </button>
            ) : (
              !blocked && (
                <button type="button" className={smallPrimary} onClick={() => decide("approve")}>
                  {t("home.decide.claude.approve")}
                </button>
              )
            )}
            {blocked ? (
              <button type="button" className={smallSecondary} onClick={() => decide("reject")}>
                {t("home.decide.claude.rejectNow")}
              </button>
            ) : (
              <button type="button" className={smallSecondary} onClick={() => setRejecting("")}>
                {t("home.decide.claude.reject")}
              </button>
            )}
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
 * Una domanda di Claude sulla doc di prodotto in «Decide» (11b, Task 10;
 * shape product-claude-questions.md §3.4, [PQ 5]): la cornice delle domande
 * sui task, la domanda, la fonte nella forma di chi guarda, la frase
 * proposta, la pagina col codice (aperta sul filo) e gli stessi bottoni del
 * filo con la stessa consigliata, senza «Other…». «Update it» parte SUBITO
 * (la modifica si annulla dalla cronologia della pagina: il toast ci porta);
 * «Leave it as is» segue la finestra dell'«Undo» come le altre risposte;
 * «Open a request» apre il riquadro con la scheda e la voce resta. Chiusa
 * la voce, il fuoco va alla voce dopo (o al titolo di «Decide»): mai sul body.
 */
function ProductQuestionItem({ decision }: { decision: ProductQuestionDecision }) {
  const { t, i18n } = useTranslation();
  const toast = useToast();
  const navigate = useNavigate();
  const { data: people } = usePeople();
  const answerNow = useAnswerProductQuestionNow();
  const root = useRef<HTMLDivElement>(null);
  const blockedId = useId();
  const claude = people?.find((p) => p.isClaude);
  const name = (id: string | null | undefined) =>
    people?.find((p) => p.id === id)?.name ?? t("taskUi.stall.someone");
  const code = decision.pageCode;
  const words = { ...decision, canRequest: decision.options.includes("request") };
  const sentence = questionSentence(t, words);

  const failed = (error: unknown) => {
    const e = error as { message?: string; byId?: string | null } | null;
    if (e?.message === "already_answered") toast.show(t("home.decide.claude.alreadyAnswered", { name: name(e.byId) }));
    // Chi non ha più Modifica Docs (T10 M4c): la frase del permesso, e il suo «Who?».
    else if (e?.message === "forbidden")
      toast.error(t("home.decide.product.forbidden", { code: decision.projectCode }), {
        action: {
          label: t("home.decide.product.who"),
          run: () =>
            void navigate({
              to: "/admin/$section",
              params: { section: "who-can" },
              search: { action: "editDocs", project: decision.projectCode } as never,
            }),
        },
      });
    else toast.error(t("home.decide.answerFailed", { code }));
  };
  // La voce si chiude: il fuoco alla voce dopo (il suo primo comando), o al titolo del blocco.
  const moveFocus = () => {
    const item = root.current?.closest("li");
    if (!item || !item.contains(document.activeElement)) return;
    let next = item.nextElementSibling;
    while (next && next.hasAttribute("data-closed")) next = next.nextElementSibling;
    const target =
      next?.querySelector<HTMLElement>("button, a[href]") ??
      item.closest("section")?.querySelector<HTMLElement>("h2") ??
      null;
    if (!target) return;
    if (target.tagName === "H2" && !target.hasAttribute("tabindex")) {
      // Il titolo prende il fuoco una volta: lasciato, torna com'era.
      target.setAttribute("tabindex", "-1");
      target.addEventListener("blur", () => target.removeAttribute("tabindex"), { once: true });
    }
    target.focus({ preventScroll: true });
  };

  const answer = (option: "apply" | "keep") => {
    moveFocus();
    if (option === "apply") {
      answerAtOnce(
        decision.id,
        () =>
          answerNow(decision.commentId, "apply").then(({ revisionId }) =>
            toast.show(t("home.decide.product.updated", { code, title: decision.pageTitle }), {
              action: {
                label: t("home.decide.product.openHistory"),
                run: () =>
                  void navigate({
                    to: "/p/$code/docs/product/$page",
                    params: { code: decision.projectCode, page: code },
                    search: (revisionId ? { history: revisionId } : {}) as never,
                  }),
              },
            }),
          ),
        failed,
      );
      return;
    }
    const cancel = deferAnswer(decision.id, () => answerNow(decision.commentId, "keep"), failed);
    toast.show(t("home.decide.answered", { code }), { action: { label: t("home.decide.undo"), run: cancel } });
  };

  return (
    <div ref={root}>
      <Frame
        id={decision.id}
        at={decision.at}
        claude={claude}
        heading={t("home.decide.claude.asks")}
        content={
          <>
            <p title={sentence} className="line-clamp-2 max-w-[72ch] text-lg font-medium text-ink [overflow-wrap:anywhere]">
              <QuestionSentence words={words} />
            </p>
            <SourceLine sources={[decision.source]} className="max-w-[72ch]" />
            {decision.apply && (
              <p
                title={decision.apply.text}
                className="max-w-[72ch] truncate text-sm text-ink-muted"
              >
                {t("home.decide.product.proposed", { text: decision.apply.text })}
              </p>
            )}
          </>
        }
        object={
          <a
            href={decision.link}
            className="flex min-w-0 items-baseline gap-2 self-start rounded-sm text-left text-sm text-ink-muted hover:text-ink"
          >
            <span className="num shrink-0 text-xs font-semibold tracking-[0.02em] text-ink">{code}</span>
            <span className="min-w-0 truncate">{decision.pageTitle}</span>
          </a>
        }
        actions={
          <div className="flex flex-col gap-1.5">
            <QuestionAnswerButtons
              options={decision.options}
              recommended={decision.recommended}
              busy={null}
              blocked={decision.applyBlocked !== null}
              blockedId={blockedId}
              onAnswer={answer}
              onRequest={() =>
                openClaudePanel({
                  draft: t("claude.answers.productDocs.ask.question", { id: decision.commentId }),
                  fresh: true,
                  send: true,
                })
              }
            />
            {decision.applyBlocked && (
              <p id={blockedId} className="max-w-[72ch] text-xs text-ink-muted">
                {decision.applyBlocked.byId ? (
                  <Trans
                    i18nKey="productDocs.question.changedAfter"
                    values={{ name: name(decision.applyBlocked.byId) }}
                    components={{ b: <strong className="font-semibold text-ink" /> }}
                  />
                ) : (
                  t("productDocs.question.changedAfterNobody")
                )}
              </p>
            )}
          </div>
        }
        language={i18n.language}
      />
    </div>
  );
}

/** La cornice di una voce di Claude in «Decide»: chi chiede con l'ora, il contenuto, l'oggetto, le risposte. */
function Frame({
  id,
  at,
  claude,
  heading,
  content,
  object,
  actions,
  language,
}: {
  id: string;
  at: string;
  claude: Person | undefined;
  heading: string;
  content: ReactNode;
  object: ReactNode;
  actions: ReactNode;
  language: string;
}) {
  const { t } = useTranslation();
  return (
    <div data-claude-decision={id} className="flex flex-col gap-2 border-b border-rule py-3 pr-3 pl-4">
      <div className="flex items-center gap-2 text-sm text-ink-muted">
        <Avatar person={claude} />
        <span className="min-w-0 truncate">{heading}</span>
        <span aria-hidden="true" className="text-ink-faint">
          ·
        </span>
        <span className="num shrink-0 text-ink-faint">{relativeTime(at, t, language)}</span>
      </div>
      {content}
      {object}
      {actions}
    </div>
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
  decision: ConversationClaudeDecision;
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
    <Frame
      id={decision.id}
      at={decision.at}
      claude={claude}
      heading={heading}
      content={content}
      language={i18n.language}
      actions={actions}
      object={
        decision.taskId && decision.objectCode ? (
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
        )
      }
    />
  );
}
