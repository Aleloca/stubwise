import { ApiError } from "@stubwise/api-client";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { getRouteApi, Link } from "@tanstack/react-router";
import { getMailOriginal, type MailOriginal } from "../lib/api";
import { formatRelativeTime } from "../lib/format";
import { mailDetailQueryOptions } from "../lib/queries";

const route = getRouteApi("/authed/mail/$source/$id");

/**
 * `/mail/:source/:id` (fase 7b, Task 8): il dettaglio di un'email, in DUE
 * fonti — l'estratto già in database, mostrato subito (design §3, punto 1),
 * e il messaggio originale su Gmail, riletto SOLO su richiesta esplicita
 * (punto 2). La distinzione è DETTA, non lasciata implicita: l'estratto
 * dichiara di essere un estratto, il bottone dichiara che sta chiedendo il
 * messaggio a Google adesso.
 *
 * `source` è `"email" | "email_triage"` (mai `"calendar"`: il calendario non
 * ha un estratto né un messaggio Gmail — la sua vista è `/calendar`, Task 9).
 */
export function MailDetailPage() {
  const { t } = useTranslation();
  const { source, id } = route.useParams();
  const detailSource = source === "email_triage" ? "email_triage" : "email";
  const query = useQuery(mailDetailQueryOptions(detailSource, id));

  const original = useMutation({
    mutationFn: () => getMailOriginal(detailSource, id),
  });

  return (
    <div className="page mx-auto w-full max-w-3xl">
      <Link
        to="/mail"
        className="inline-flex items-center font-mono text-[11px] tracking-[0.12em] text-fg-muted uppercase transition-colors hover:text-fg"
      >
        ← {t("mail:detail.back")}
      </Link>

      {query.isPending ? (
        <div aria-hidden="true" className="mt-4 space-y-2">
          <div className="h-4 w-2/3 rounded-sm bg-ink-800" />
          <div className="h-24 rounded-sm bg-ink-800" />
        </div>
      ) : query.isError ? (
        <div className="mt-4 rounded-sm border border-dashed border-line-strong px-4 py-12 text-center">
          <p className="text-sm text-fg-muted">
            {query.error instanceof ApiError && query.error.status === 404
              ? t("mail:detail.notFound")
              : t("mail:detail.loadError")}
          </p>
        </div>
      ) : (
        <article className="mt-4">
          <header className="border-b border-line pb-4">
            <h1 className="text-lg font-semibold break-words">
              {query.data.subject ?? <span className="text-fg-faint">{t("mail:noSubject")}</span>}
            </h1>
            <p className="mt-1 font-mono text-[11px] text-fg-faint">
              <span className="text-fg-muted">{query.data.from}</span>
              {query.data.to.length > 0 && (
                <>
                  {" "}
                  → <span title={query.data.to.join(", ")}>{query.data.to[0]}</span>
                  {query.data.to.length > 1 && ` +${query.data.to.length - 1}`}
                </>
              )}
              {" · "}
              <time dateTime={query.data.receivedAt} title={query.data.receivedAt}>
                {formatRelativeTime(query.data.receivedAt)}
              </time>
            </p>
            <a
              href={query.data.url}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-2 inline-flex min-h-9 items-center rounded-sm border border-line-strong px-3 font-mono text-[11px] tracking-[0.12em] text-fg-muted uppercase transition-colors hover:border-ink-700 hover:text-fg"
            >
              {t("mail:open")}
            </a>
          </header>

          <section className="mt-4">
            <p className="font-mono text-[11px] text-fg-faint">{t("mail:detail.excerptNotice")}</p>
            {query.data.textExcerpt !== null ? (
              <pre className="mt-2 max-h-[50vh] overflow-auto rounded-sm border border-line bg-ink-900 p-4 text-sm whitespace-pre-wrap text-fg">
                {query.data.textExcerpt}
              </pre>
            ) : (
              <p className="mt-2 rounded-sm border border-dashed border-line-strong px-4 py-6 text-center font-mono text-[12px] text-fg-faint">
                {t("mail:detail.noExcerpt")}
              </p>
            )}
          </section>

          <section className="mt-6 border-t border-line pt-4">
            {!original.isSuccess && (
              <button
                type="button"
                disabled={original.isPending}
                onClick={() => original.mutate()}
                className="inline-flex min-h-9 items-center rounded-sm border border-line-strong px-3 font-mono text-[11px] tracking-[0.12em] text-fg-muted uppercase transition-colors hover:border-signal-dim hover:text-fg disabled:cursor-not-allowed disabled:opacity-50"
              >
                {original.isPending ? t("mail:detail.readingOriginal") : t("mail:detail.readOriginal")}
              </button>
            )}
            {original.isPending && (
              <p className="mt-2 font-mono text-[11px] text-fg-faint">{t("mail:detail.originalNotice")}</p>
            )}
            {original.isError && (
              <p role="alert" className="mt-2 font-mono text-[11px] text-danger">
                {originalErrorMessage(t, original.error)}
              </p>
            )}
            {original.isSuccess && <OriginalMessage original={original.data} />}
          </section>

          <p className="mt-6 font-mono text-[11px] text-fg-faint">{t("mail:detail.retentionNotice")}</p>
        </article>
      )}
    </div>
  );
}

function originalErrorMessage(t: (key: string) => string, error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === "message_gone") return t("mail:detail.originalError.messageGone");
    if (error.code === "token_expired") return t("mail:detail.originalError.tokenExpired");
  }
  return t("mail:detail.originalError.googleUnavailable");
}

function OriginalMessage({ original }: { original: MailOriginal }) {
  const { t } = useTranslation();
  return (
    <div className="mt-3">
      {original.bodyText !== null ? (
        <pre className="max-h-[60vh] overflow-auto rounded-sm border border-signal-dim/40 bg-ink-900 p-4 text-sm whitespace-pre-wrap text-fg">
          {original.bodyText}
        </pre>
      ) : (
        <p className="font-mono text-[11px] text-fg-faint">{t("mail:detail.noExcerpt")}</p>
      )}
      {original.attachments.length > 0 && (
        <div className="mt-3">
          <p className="font-mono text-[11px] tracking-[0.12em] text-fg-faint uppercase">
            {t("mail:detail.attachments")}
          </p>
          <ul className="mt-1 space-y-1">
            {original.attachments.map((attachment, index) => (
              <li key={index} className="font-mono text-[12px] text-fg-muted">
                {attachment.filename}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
