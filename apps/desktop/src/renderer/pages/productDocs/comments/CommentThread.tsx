import { forwardRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { now } from "../../../data/dates";
import { usePeople } from "../../../data/queries";
import type { ProductCommentThread, ProductCommentView } from "../../../data/types";
import { formatDate } from "../../../notifications/time";
import { CommentComposer } from "./CommentComposer";

// Un filo della colonna (shape product-comments-history.md §3.3, §3.5,
// [PC 1]): bordo 1 px `rule`, raggio 8, padding 12, nessuna ombra; attivo
// `rule-strong`. In testa, se l'ancora non c'è più, «Sentence deleted»
// ([PC 7]); poi la frase citata fra virgolette tipografiche (2 righe al più,
// il `title` intero); la radice (nome · ora, «Resolve» a destra per chi
// scrive); le risposte (più di 3: la prima, «Show N more replies», le ultime
// due); la casella «Reply…». Un filo risolto si legge e basta, con «Reopen»
// per chi scrive. Chi legge soltanto non ha né casella né bottoni ([PC 8]).
// I commenti non si modificano né si eliminano nel 11a.

/** L'ora di oggi («10:02»), la data dei giorni prima («Nov 3»), in cifre tabellari. */
export function commentTime(iso: string, language: string): string {
  if (iso.slice(0, 10) === now().slice(0, 10)) {
    return new Intl.DateTimeFormat(language, {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
      timeZone: "UTC",
    }).format(new Date(iso));
  }
  return formatDate(iso, language);
}

/**
 * Il testo di un commento, con le «@Nome» delle persone menzionate
 * (`mentionIds`, che chi guarda vede) in 600 `ink`: è testo, non un gettone.
 */
function CommentBody({ comment }: { comment: ProductCommentView }) {
  const people = usePeople().data ?? [];
  const names = comment.mentionIds
    .map((id) => people.find((p) => p.id === id)?.name)
    .filter((n): n is string => !!n)
    .map((n) => `@${n}`)
    .sort((a, b) => b.length - a.length);
  if (names.length === 0) return <>{comment.body}</>;
  const pattern = new RegExp(`(${names.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`, "g");
  return (
    <>
      {comment.body.split(pattern).map((part, i) =>
        names.includes(part) ? (
          <span key={i} data-mention="" className="font-semibold text-ink">
            {part}
          </span>
        ) : (
          part
        ),
      )}
    </>
  );
}

function Line({ comment, action }: { comment: ProductCommentView; action?: ReactNode }) {
  const { i18n } = useTranslation();
  return (
    <div className="flex flex-col gap-1">
      <p className="flex min-w-0 items-baseline gap-1.5">
        <span className="min-w-0 truncate text-sm font-semibold text-ink">{comment.authorName}</span>
        <time dateTime={comment.createdAt} className="num shrink-0 text-xs text-ink-faint">
          {commentTime(comment.createdAt, i18n.language)}
        </time>
        {action && <span className="ml-auto shrink-0">{action}</span>}
      </p>
      <p className="text-md leading-5 whitespace-pre-wrap text-ink [overflow-wrap:anywhere]">
        <CommentBody comment={comment} />
      </p>
    </div>
  );
}

const textButton =
  "inline-flex h-6 items-center gap-1 rounded-md px-1.5 text-xs font-medium text-ink-muted transition-colors duration-[var(--duration-fast)] ease-out hover:bg-ink/6 hover:text-ink";

export const CommentThread = forwardRef<
  HTMLElement,
  {
    thread: ProductCommentThread;
    projectId: string;
    projectCode: string;
    canComment: boolean;
    active: boolean;
    resolved?: boolean;
    style?: React.CSSProperties;
    onResolve?: () => void;
    onReopen?: () => void;
    onReply?: (body: string) => Promise<unknown>;
    onActive?: () => void;
    /** «Resolve» o «Reopen» del filo, per rimetterci il fuoco. */
    actionRef?: (el: HTMLButtonElement | null) => void;
  }
>(function CommentThread(
  {
    thread,
    projectId,
    projectCode,
    canComment,
    active,
    resolved = false,
    style,
    onResolve,
    onReopen,
    onReply,
    onActive,
    actionRef,
  },
  ref,
) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const { root, replies } = thread;
  const hidden = !expanded && replies.length > 3 ? replies.length - 3 : 0;
  const shown = hidden > 0 ? [replies[0]!, ...replies.slice(-2)] : replies;

  const action = !canComment ? undefined : resolved ? (
    <button ref={actionRef} type="button" onClick={onReopen} className={textButton}>
      {t("productDocs.comments.reopen")}
    </button>
  ) : (
    <button ref={actionRef} type="button" onClick={onResolve} className={textButton}>
      <svg viewBox="0 0 16 16" width={14} height={14} fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
        <path d="m3.5 8.5 3 3 6-7" />
      </svg>
      {t("productDocs.comments.resolve")}
    </button>
  );

  return (
    <article
      ref={ref}
      tabIndex={-1}
      data-thread={root.id}
      aria-label={t("productDocs.comments.threadLabel", { name: root.authorName, quote: root.quote })}
      style={style}
      onFocus={onActive}
      onClick={onActive}
      className={`flex flex-col gap-2 rounded-lg border bg-surface p-3 outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus ${active ? "border-rule-strong" : "border-rule"}`}
    >
      {thread.anchorGone && (
        <p className="flex items-center gap-1.5 text-xs text-ink-muted">
          <svg viewBox="0 0 16 16" width={14} height={14} fill="none" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" aria-hidden="true" focusable="false">
            <circle cx="4.5" cy="11.5" r="2" />
            <circle cx="11.5" cy="11.5" r="2" />
            <path d="M6 10 12.5 2.5M10 10 3.5 2.5" />
          </svg>
          {t("productDocs.comments.deleted")}
        </p>
      )}
      <p title={root.quote} className="line-clamp-2 text-xs leading-4 text-ink-muted [overflow-wrap:anywhere]">
        {`“${root.quote}”`}
      </p>
      <Line comment={root} action={action} />
      {shown.map((reply, i) => (
        <div key={reply.id} className="flex flex-col gap-2">
          {hidden > 0 && i === 1 && (
            <button type="button" onClick={() => setExpanded(true)} className={`${textButton} self-start`}>
              {t("productDocs.comments.moreReplies", { count: hidden })}
            </button>
          )}
          <Line comment={reply} />
        </div>
      ))}
      {canComment && !resolved && onReply && (
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
