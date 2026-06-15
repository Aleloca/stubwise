import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import type { Comment } from "../lib/api";
import { formatDateTime, formatRelativeTime } from "../lib/format";
import { FormError } from "./field";
import { Markdown } from "./markdown";

interface CommentThreadProps {
  comments: Comment[];
  /** authorId → email, per firmare i commenti degli utenti. */
  authorEmails: Map<string, string>;
  /** Invio del nuovo commento; il rigetto lascia il testo nel campo. */
  onSubmit: (body: string) => Promise<unknown>;
  pending: boolean;
}

/**
 * Thread dei commenti in ordine cronologico + form di risposta. Tre voci
 * distinte: gli utenti (firmati con l'email), l'AI (badge ambra + filo a
 * sinistra) e il sistema (badge neutro "SISTEMA", es. chiusura automatica al
 * merge della PR). Il sistema non si confonde né con l'AI né con un utente
 * rimosso.
 */
export function CommentThread({ comments, authorEmails, onSubmit, pending }: CommentThreadProps) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    const body = draft.trim();
    if (!body || pending) return;
    setError(null);
    try {
      await onSubmit(body);
      setDraft("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("tickets:comments.submitFailed"));
    }
  }

  return (
    <div className="space-y-4">
      {comments.length === 0 ? (
        <p className="font-mono text-[12px] text-fg-faint">{t("tickets:comments.empty")}</p>
      ) : (
        <ol className="space-y-3">
          {comments.map((comment) => (
            <li
              key={comment.id}
              className={`rounded-sm border bg-ink-900 px-4 py-3 ${
                comment.authorType === "ai"
                  ? "border-signal-dim/40 shadow-[inset_2px_0_0_0_var(--color-signal)]"
                  : comment.authorType === "system"
                    ? "border-line shadow-[inset_2px_0_0_0_var(--color-line-strong)]"
                    : "border-line"
              }`}
            >
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                {comment.authorType === "ai" ? (
                  <>
                    <span className="rounded-sm bg-signal px-1.5 py-px font-mono text-[10px] font-semibold tracking-[0.12em] text-ink-950 uppercase">
                      AI
                    </span>
                    <span className="font-mono text-[12px] text-fg-muted">Stubwise</span>
                  </>
                ) : comment.authorType === "system" ? (
                  <span className="rounded-sm border border-line-strong px-1.5 py-px font-mono text-[10px] font-semibold tracking-[0.12em] text-fg-muted uppercase">
                    {t("tickets:comments.system")}
                  </span>
                ) : (
                  <span className="font-mono text-[12px] text-fg-muted">
                    {(comment.authorId && authorEmails.get(comment.authorId)) ??
                      t("tickets:comments.removedUser")}
                  </span>
                )}
                <time
                  dateTime={comment.createdAt}
                  title={formatDateTime(comment.createdAt)}
                  className="font-mono text-[11px] text-fg-faint"
                >
                  {formatRelativeTime(comment.createdAt)}
                </time>
              </div>
              <div className="mt-2">
                <Markdown source={comment.body} />
              </div>
            </li>
          ))}
        </ol>
      )}

      <form onSubmit={(event) => void handleSubmit(event)} className="space-y-2">
        <label
          htmlFor="comment-body"
          className="block font-mono text-[11px] tracking-[0.14em] text-fg-muted uppercase"
        >
          {t("tickets:comments.addComment")}
        </label>
        <textarea
          id="comment-body"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          rows={3}
          placeholder={t("tickets:comments.placeholder")}
          className="w-full rounded-sm border border-line-strong bg-ink-950/70 px-3 py-2 text-sm text-fg placeholder:text-fg-faint transition-colors hover:border-ink-700 focus-visible:border-signal-dim"
        />
        <FormError message={error} />
        <button
          type="submit"
          disabled={pending || draft.trim() === ""}
          className="rounded-sm bg-signal px-3 py-1.5 font-mono text-[12px] font-semibold tracking-[0.08em] text-ink-950 uppercase transition-colors hover:bg-signal-bright active:bg-signal-dim disabled:cursor-not-allowed disabled:bg-signal-dim disabled:opacity-60"
        >
          {pending ? t("tickets:comments.submitPending") : t("tickets:comments.submit")}
        </button>
      </form>
    </div>
  );
}
