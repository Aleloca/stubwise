import { forwardRef, useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { Trans, useTranslation } from "react-i18next";
import { CodeLink } from "../../../components/CodeLink";
import { SentenceWithWho } from "../../../components/WhoCanLink";
import { CLAUDE_PANEL_ID } from "../../../layout/claudePanel/panelEvents";
import { usePeople } from "../../../data/queries";
import type { ProductAnswerChoice, ProductCommentThread, ProductQuestionView, RichText } from "../../../data/types";
import { answerLabel, questionKey, type QuestionWords } from "../../../domain/productDocs/claudeText";
import { Avatar } from "../../../tasks-ui/PersonChip";
import { smallSecondary } from "../../task/parts";
import { SourceLine } from "../claude/SourceLine";
import { RichView } from "../editor/RichView";
import { CommentComposer } from "./CommentComposer";
import { CommentLine, commentTime } from "./CommentThread";

// La domanda di Claude nella colonna dei commenti (11b, Task 10; shape
// product-claude-questions.md §3.1–3.3, [PQ 2]–[PQ 4]): un commento con le
// risposte già scritte. Stessa cornice di un filo (bordo 1 px `rule`, raggio
// 8, padding 12): la frase citata, la radice di Claude (senza «Resolve»: si
// chiude rispondendo), la fonte nella forma di chi guarda, la domanda, il
// prima e dopo, le risposte (la consigliata per prima, come `ClaudeAnswers`),
// le risposte scritte e «Reply…». Tutto viene dalla `ProductQuestionView`
// del livello dati: qui non si ricalcola nessuna regola.

type Answerable = Exclude<ProductAnswerChoice, "request">;

/** Il nome di chi ha risposto per primo (un `already_answered`), che la colonna ricorda. */
export interface FirstAnswer {
  byId: string | null;
  option: ProductAnswerChoice;
}

/** La domanda, con il codice della task (divergenza) come `CodeLink`. */
export function QuestionSentence({ words }: { words: QuestionWords }) {
  const { key, params } = questionKey(words);
  return (
    <Trans
      i18nKey={key}
      values={params}
      components={{ code: words.taskCode ? <CodeLink code={words.taskCode} quiet /> : <span /> }}
    />
  );
}

/**
 * Le risposte, nell'ordine del dato (la consigliata per prima, segnata
 * «Recommended» come in `ClaudeAnswers`), tutte della stessa misura. Il
 * filo e la Home le usano uguali. `busy`: la risposta in volo («Answering…»
 * sul bottone premuto, tutti spenti). «Update it» spento per
 * `changed_after` porta la sua frase (`blockedId`).
 */
export function QuestionAnswerButtons({
  options,
  recommended,
  busy,
  blocked,
  blockedId,
  onAnswer,
  onRequest,
  className = "",
}: {
  options: readonly ProductAnswerChoice[];
  recommended: ProductAnswerChoice | null;
  busy: ProductAnswerChoice | null;
  blocked: boolean;
  blockedId?: string;
  onAnswer: (option: Answerable) => void;
  onRequest: () => void;
  className?: string;
}) {
  const { t } = useTranslation();
  // ←/→ fra le risposte (shape Q §6), in giro; Tab resta di ogni bottone.
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    const buttons = [...e.currentTarget.querySelectorAll<HTMLButtonElement>("button[data-answer]")];
    const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (at === -1) return;
    e.preventDefault();
    const step = e.key === "ArrowRight" ? 1 : -1;
    buttons[(at + step + buttons.length) % buttons.length]!.focus();
  };
  return (
    <div
      role="group"
      aria-label={t("productDocs.question.answersLabel")}
      onKeyDown={onKeyDown}
      className={`flex flex-wrap gap-2 ${className}`}
    >
      {options.map((option) => {
        const off = busy !== null || (option === "apply" && blocked);
        return (
          <button
            key={option}
            type="button"
            data-answer={option}
            aria-disabled={off || undefined}
            aria-describedby={option === "apply" && blocked ? blockedId : undefined}
            onClick={() => {
              if (off) return;
              if (option === "request") onRequest();
              else onAnswer(option);
            }}
            className={`${smallSecondary} h-auto min-h-7 max-w-full py-1 text-left [overflow-wrap:anywhere] aria-disabled:cursor-default aria-disabled:opacity-60 aria-disabled:hover:bg-transparent ${option === recommended ? "border-ink/60" : ""}`}
          >
            <span className="flex flex-wrap items-baseline gap-x-2">
              <span>{busy === option ? t("productDocs.question.answering") : answerLabel(t, option)}</span>
              {option === recommended && (
                <span className="text-xs font-semibold text-ink-muted">{t("productDocs.question.recommended")}</span>
              )}
            </span>
          </button>
        );
      })}
    </div>
  );
}

function Version({ label, children, strong }: { label: string; children: React.ReactNode; strong: boolean }) {
  return (
    <div className="flex flex-col gap-0.5">
      <p className="text-xs font-semibold text-ink-muted">{label}</p>
      <div className={`text-sm leading-[18px] [overflow-wrap:anywhere] ${strong ? "text-ink" : "text-ink-muted"}`}>
        {children}
      </div>
    </div>
  );
}

/**
 * Il prima e dopo: «Now» / «Proposed»; per la divergenza «The page says» /
 * «Was built» e la frase proposta. A domanda chiusa la frase di adesso non
 * si mostra: dopo «Update it» è già quella proposta, e accanto direbbe che
 * la pagina diceva così prima.
 */
function BeforeAfter({ q, closed }: { q: ProductQuestionView; closed: boolean }) {
  const { t } = useTranslation();
  const rich = (content: RichText) => <RichView content={content} />;
  const diverges = q.reason === "diverges";
  return (
    <div className="flex flex-col gap-2" data-question-versions="">
      {q.current && !closed && (
        <Version label={t(diverges ? "productDocs.question.pageSays" : "productDocs.question.now")} strong={false}>
          {rich(q.current)}
        </Version>
      )}
      {diverges && q.built && (
        <Version label={t("productDocs.question.wasBuilt")} strong={false}>
          {q.built}
        </Version>
      )}
      {q.apply && (
        <Version label={t("productDocs.question.proposed")} strong>
          {rich(q.apply)}
        </Version>
      )}
    </div>
  );
}

export const QuestionThread = forwardRef<
  HTMLElement,
  {
    thread: ProductCommentThread;
    projectId: string;
    projectCode: string;
    canComment: boolean;
    active: boolean;
    resolved?: boolean;
    /** Una scheda «Open a request» di chi guarda è aperta nel riquadro. */
    preparing: boolean;
    /** Chi guarda è arrivato secondo: chi ha risposto prima, e cosa. */
    firstAnswer: FirstAnswer | null;
    /** Risponde (la colonna scrive e sposta il fuoco); rifiuta con l'errore del livello dati. */
    onAnswer: (option: Answerable) => Promise<unknown>;
    onRequest: () => void;
    /** `already_answered`: la colonna ricarica il filo risolto e ci porta il fuoco. */
    onAlreadyAnswered: (first: FirstAnswer) => void;
    /** `changed_after` fra lettura e clic: si rilegge (il bottone si spegne con la sua frase). */
    onStale: () => void;
    onReply?: (body: string) => Promise<unknown>;
    onActive?: () => void;
  }
>(function QuestionThread(
  {
    thread,
    projectId,
    projectCode,
    canComment,
    active,
    resolved = false,
    preparing,
    firstAnswer,
    onAnswer,
    onRequest,
    onAlreadyAnswered,
    onStale,
    onReply,
    onActive,
  },
  ref,
) {
  const { t, i18n } = useTranslation();
  const people = usePeople().data;
  const { root, replies } = thread;
  const q = root.question!;
  const claude = people?.find((p) => p.isClaude);
  const nameOf = (id: string | null) => (id ? (people?.find((p) => p.id === id)?.name ?? null) : null);
  const [busy, setBusy] = useState<ProductAnswerChoice | null>(null);
  const [refusal, setRefusal] = useState<{ kind: "forbidden" } | { kind: "error"; option: Answerable } | null>(null);
  const blockedId = useId();
  const article = useRef<HTMLElement | null>(null);
  const setArticle = (el: HTMLElement | null) => {
    article.current = el;
    if (typeof ref === "function") ref(el);
    else if (ref) ref.current = el;
  };
  /** Il fuoco sul filo PRIMA che i bottoni spariscano (fix round 1, I1 e M6): mai sul body. */
  const holdFocus = () => {
    if (article.current?.contains(document.activeElement)) article.current.focus({ preventScroll: true });
  };

  // Un doppio clic risponde una volta sola: il secondo arriva prima che lo stato spenga i bottoni.
  const inFlight = useRef(false);
  const answer = (option: Answerable) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(option);
    setRefusal(null);
    onAnswer(option)
      .catch((error: unknown) => {
        const e = error as { message?: string; byId?: string | null; option?: ProductAnswerChoice } | null;
        if (e?.message === "already_answered") {
          holdFocus();
          onAlreadyAnswered({ byId: e.byId ?? null, option: e.option ?? option });
        } else if (e?.message === "changed_after") onStale();
        else if (e?.message === "forbidden") {
          // Il permesso perso: la frase col «Who?», e il filo si rilegge in sola lettura.
          holdFocus();
          setRefusal({ kind: "forbidden" });
          onStale();
        } else setRefusal({ kind: "error", option });
      })
      .finally(() => {
        inFlight.current = false;
        setBusy(null);
      });
  };

  const answered = (() => {
    if (firstAnswer) {
      const name = nameOf(firstAnswer.byId);
      const label = answerLabel(t, firstAnswer.option);
      return name
        ? t("productDocs.question.answeredFirst", { name, answer: label })
        : t("productDocs.question.answeredFirstSomeone", { answer: label });
    }
    if (!q.answer) return null;
    const label = answerLabel(t, q.answer.option);
    return q.answer.byName
      ? t("productDocs.question.answeredBy", { name: q.answer.byName, answer: label })
      : t("productDocs.question.answeredBySomeone", { answer: label });
  })();
  const open = !resolved && !firstAnswer && q.answer === null;

  // La scheda «Open a request» annullata (la riga sparisce, la domanda resta
  // aperta): il fuoco torna al bottone del filo (shape Q §6), se era nel
  // riquadro o perso; chi intanto è andato altrove lo tiene.
  const wasPreparing = useRef(preparing);
  useEffect(() => {
    const was = wasPreparing.current;
    wasPreparing.current = preparing;
    if (!was || preparing || !open) return;
    const active = document.activeElement;
    const panel = document.getElementById(CLAUDE_PANEL_ID);
    if (active && active !== document.body && active.isConnected && !panel?.contains(active)) return;
    article.current?.querySelector<HTMLElement>('[data-answer="request"]')?.focus();
  }, [preparing, open]);

  return (
    <article
      ref={setArticle}
      tabIndex={-1}
      data-thread={root.id}
      data-question=""
      aria-label={t("productDocs.question.threadLabel", { quote: root.quote })}
      onFocus={onActive}
      onClick={onActive}
      className={`flex flex-col gap-2 rounded-lg border bg-surface p-3 outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus ${active ? "border-rule-strong" : "border-rule"}`}
    >
      {thread.anchorGone && (
        <p className="text-xs text-ink-muted">{t("productDocs.comments.deleted")}</p>
      )}
      <p title={root.quote} className="line-clamp-2 text-xs leading-4 text-ink-muted [overflow-wrap:anywhere]">
        {t("productDocs.comments.quoted", { quote: root.quote })}
      </p>
      <p className="flex min-w-0 items-center gap-1.5">
        <Avatar person={claude} />
        <span className="min-w-0 truncate text-sm font-semibold text-ink">{root.authorName}</span>
        <time dateTime={root.createdAt} className="num shrink-0 text-xs text-ink-faint">
          {commentTime(root.createdAt, i18n.language)}
        </time>
      </p>
      <SourceLine sources={[q.source]} />
      <p className="text-md leading-5 text-pretty text-ink [overflow-wrap:anywhere]">
        <QuestionSentence words={{ ...q, canRequest: q.options.includes("request") }} />
      </p>
      <BeforeAfter q={q} closed={!open} />
      {answered && (
        <p data-question-answer="" className="text-xs text-ink-muted">
          {answered}
          {!firstAnswer && q.answer?.requestCode && (
            <>
              <span aria-hidden="true"> · </span>
              <CodeLink code={q.answer.requestCode} quiet />
            </>
          )}
        </p>
      )}
      {open && q.canAnswer && (
        <div className="flex flex-col gap-1.5">
          <QuestionAnswerButtons
            options={q.options}
            recommended={q.recommended}
            busy={busy}
            blocked={q.applyBlocked !== null}
            blockedId={blockedId}
            onAnswer={answer}
            onRequest={onRequest}
          />
          {q.applyBlocked && (
            <p id={blockedId} className="text-xs leading-4 text-ink-muted">
              {q.applyBlocked.byId ? (
                <Trans
                  i18nKey="productDocs.question.changedAfter"
                  values={{ name: nameOf(q.applyBlocked.byId) ?? "" }}
                  components={{ b: <strong className="font-semibold text-ink" /> }}
                />
              ) : (
                t("productDocs.question.changedAfterNobody")
              )}
            </p>
          )}
          {preparing && <p className="text-xs leading-4 text-ink-muted">{t("productDocs.question.preparing")}</p>}
          {refusal?.kind === "forbidden" && (
            <p className="text-xs leading-4 text-ink-muted">
              <SentenceWithWho
                text={t("productDocs.question.forbidden", { code: projectCode })}
                action="editDocs"
                projectId={projectId}
                projectCode={projectCode}
              />
            </p>
          )}
          {refusal?.kind === "error" && (
            <p role="alert" className="flex flex-wrap items-center gap-x-1.5 text-xs text-critical">
              <span>{t("productDocs.question.failed")}</span>
              <span aria-hidden="true">·</span>
              <button
                type="button"
                onClick={() => {
                  // Il bottone della risposta prende il fuoco prima che l'avviso sparisca (fix round 1, I2).
                  article.current?.querySelector<HTMLElement>(`[data-answer="${refusal.option}"]`)?.focus();
                  answer(refusal.option);
                }}
                className="font-medium underline underline-offset-2"
              >
                {t("productDocs.question.retry")}
              </button>
            </p>
          )}
        </div>
      )}
      {open && !q.canAnswer && (
        <p className="text-xs leading-4 text-pretty text-ink-muted">
          <SentenceWithWho
            text={
              refusal?.kind === "forbidden"
                ? t("productDocs.question.forbidden", { code: projectCode })
                : t("productDocs.question.readOnly", { code: projectCode })
            }
            action="editDocs"
            projectId={projectId}
            projectCode={projectCode}
          />
        </p>
      )}
      {replies.map((reply) => (
        <CommentLine key={reply.id} comment={reply} />
      ))}
      {canComment && open && onReply && (
        <CommentComposer
          compact
          projectId={projectId}
          projectCode={projectCode}
          placeholder={t("productDocs.comments.reply")}
          sendLabel={t("productDocs.comments.send")}
          onSubmit={onReply}
        />
      )}
    </article>
  );
});
