import { ApiError } from "@stubwise/api-client";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { getMailOriginal, type MailOriginal } from "../lib/api";
import { formatRelativeTime } from "../lib/format";
import { mailDetailQueryOptions } from "../lib/queries";

/**
 * Il pannello di LETTURA a destra (fase 9, Task 5, design §5): l'estratto già
 * in database, mostrato subito, e il messaggio originale su Gmail, riletto
 * SOLO su richiesta esplicita — stesso principio della fase 7b, ora dentro
 * la terza colonna invece che su una pagina a sé (la lista al centro resta
 * visibile: non serve più un link "torna alla posta").
 *
 * `source` è `"email" | "email_triage"` (mai `"calendar"`: il calendario non
 * ha un estratto né un messaggio Gmail — la sua vista è `/calendar`).
 */
export function MailReadingPane({ source, id }: { source: "email" | "email_triage"; id: string }) {
  const { t } = useTranslation();
  const query = useQuery(mailDetailQueryOptions(source, id));

  const original = useMutation({
    mutationFn: () => getMailOriginal(source, id),
  });

  if (query.isPending) {
    return (
      <div aria-hidden="true" className="space-y-2">
        <div className="h-4 w-2/3 rounded-sm bg-ink-800" />
        <div className="h-24 rounded-sm bg-ink-800" />
      </div>
    );
  }

  if (query.isError) {
    return (
      <div className="rounded-sm border border-dashed border-line-strong px-4 py-12 text-center">
        <p className="text-sm text-fg-muted">
          {query.error instanceof ApiError && query.error.status === 404
            ? t("mail:detail.notFound")
            : t("mail:detail.loadError")}
        </p>
      </div>
    );
  }

  return (
    <article>
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
          <pre className="mt-2 max-h-[40vh] overflow-auto rounded-sm border border-line bg-ink-900 p-4 text-sm whitespace-pre-wrap text-fg">
            {query.data.textExcerpt}
          </pre>
        ) : (
          <p className="mt-2 rounded-sm border border-dashed border-line-strong px-4 py-6 text-center font-mono text-[12px] text-fg-faint">
            {t("mail:detail.noExcerpt")}
          </p>
        )}
      </section>

      <section className="mt-6 border-t border-line pt-4">
        {/*
         * La nota va accanto al COMANDO, sempre — non solo mentre la
         * richiesta è in corso: il design vuole che sia il comando a
         * dichiarare cosa sta per fare PRIMA che lo si prema.
         */}
        {!original.isSuccess && (
          <>
            <button
              type="button"
              disabled={original.isPending}
              onClick={() => original.mutate()}
              className="inline-flex min-h-9 items-center rounded-sm border border-line-strong px-3 font-mono text-[11px] tracking-[0.12em] text-fg-muted uppercase transition-colors hover:border-signal-dim hover:text-fg disabled:cursor-not-allowed disabled:opacity-50"
            >
              {original.isPending ? t("mail:detail.readingOriginal") : t("mail:detail.readOriginal")}
            </button>
            <p className="mt-2 font-mono text-[11px] text-fg-faint">{t("mail:detail.originalNotice")}</p>
          </>
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
  );
}

function originalErrorMessage(t: (key: string) => string, error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === "message_gone") return t("mail:detail.originalError.messageGone");
    if (error.code === "token_expired") return t("mail:detail.originalError.tokenExpired");
  }
  return t("mail:detail.originalError.googleUnavailable");
}

/**
 * `data-src="URL"` → aggiunge `src="URL"` (STESSO url, già validato
 * http/https da `sanitizeEmailHtml` lato server prima di finire in
 * `data-src`): questo è l'UNICO modo in cui un'immagine remota può caricare,
 * ed è un gesto esplicito dell'utente ("mostra immagini"), mai automatico.
 * Sicuro anche se l'HTML restasse "vivo" più a lungo del previsto: non
 * introduce un tag o un attributo nuovo, copia soltanto un valore che il
 * server ha già accettato.
 */
function revealImages(html: string): string {
  return html.replace(/(<img\b[^>]*?)\sdata-src="([^"]*)"/g, (_match, prefix: string, url: string) => {
    return `${prefix} data-src="${url}" src="${url}"`;
  });
}

/** Documento minimo per l'`<iframe srcDoc>`: sfondo CHIARO deliberato, vedi il commento su `EmailBodyFrame`. */
function wrapEmailDocument(bodyHtml: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="color-scheme" content="light"><style>
    body { margin: 0; padding: 12px; font-family: -apple-system, "Segoe UI", Roboto, sans-serif; font-size: 14px; line-height: 1.5; color: #1a1a1a; background: #ffffff; word-wrap: break-word; }
    img { max-width: 100%; height: auto; }
    a { color: #1a56db; }
  </style></head><body>${bodyHtml}</body></html>`;
}

/**
 * Il corpo HTML sanificato, in un `<iframe sandbox>` — SECONDA difesa
 * indipendente dalla sanificazione lato server (design §4): anche se questa
 * avesse un buco, il contenuto non ha un'origine da cui fare danni.
 *
 * `sandbox="allow-popups allow-popups-to-escape-sandbox"`: **mai**
 * `allow-scripts` né `allow-same-origin` (i due esplicitamente vietati dal
 * design) — ma senza NESSUN permesso un link cliccato dentro l'iframe non
 * naviga da nessuna parte (il sandbox di default blocca anche l'apertura di
 * popup), il che renderebbe inutile ogni link legittimo nell'email.
 * `allow-popups` lo riabilita; `allow-popups-to-escape-sandbox` fa sì che la
 * scheda aperta sia un browser NORMALE (senza eredita il sandbox, altrimenti
 * il sito di destinazione — che quasi certamente usa JS — non funzionerebbe
 * lì dentro). Nessuna delle due riguarda l'ESECUZIONE dentro QUESTO iframe:
 * il contenuto dell'email resta sempre senza script e senza origine propria.
 *
 * Sfondo CHIARO deliberato (non il tema scuro di Stubwise): il contenuto è
 * di un estraneo, autorato assumendo (quasi sempre) uno sfondo chiaro — un
 * testo nero senza `background` esplicito diventerebbe illeggibile su
 * inchiostro scuro. È la stessa logica di un lettore PDF o di un embed: il
 * documento resta nel SUO aspetto, dentro una cornice che è chiaramente
 * Stubwise (il bordo, il bottone "mostra immagini").
 */
function EmailBodyFrame({ html }: { html: string }) {
  const { t } = useTranslation();
  const [showImages, setShowImages] = useState(false);
  const hasHiddenImages = useMemo(() => /\sdata-src="/.test(html), [html]);
  const rendered = useMemo(() => (showImages ? revealImages(html) : html), [html, showImages]);
  const srcDoc = useMemo(() => wrapEmailDocument(rendered), [rendered]);

  return (
    <div>
      {hasHiddenImages && (
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2 rounded-sm border border-line-strong bg-ink-900 px-3 py-2">
          <p className="font-mono text-[11px] text-fg-faint">{t("mail:detail.imagesBlockedNotice")}</p>
          {!showImages && (
            <button
              type="button"
              onClick={() => setShowImages(true)}
              className="inline-flex min-h-8 items-center rounded-sm border border-line-strong px-2 font-mono text-[11px] tracking-[0.1em] text-fg-muted uppercase transition-colors hover:border-signal-dim hover:text-fg"
            >
              {t("mail:detail.showImages")}
            </button>
          )}
        </div>
      )}
      <iframe
        title={t("mail:detail.bodyFrameTitle")}
        srcDoc={srcDoc}
        sandbox="allow-popups allow-popups-to-escape-sandbox"
        className="h-[50vh] w-full rounded-sm border border-signal-dim/40 bg-white"
      />
    </div>
  );
}

function OriginalMessage({ original }: { original: MailOriginal }) {
  const { t } = useTranslation();
  // `original.bodyHtml` può essere `undefined`, non solo `null`: il client
  // non valida la risposta con lo schema (nessun `.parse()` a runtime), e il
  // campo è nuovo (fase 9) — un server precedente semplicemente non lo manda.
  return (
    <div className="mt-3">
      {original.bodyHtml ? (
        <EmailBodyFrame html={original.bodyHtml} />
      ) : original.bodyText !== null ? (
        <pre className="max-h-[50vh] overflow-auto rounded-sm border border-signal-dim/40 bg-ink-900 p-4 text-sm whitespace-pre-wrap text-fg">
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
