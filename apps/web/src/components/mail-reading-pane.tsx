import { ApiError } from "@stubwise/api-client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { useTranslation } from "react-i18next";
import {
  getMailOriginal,
  postMailRepropose,
  type MailOriginal,
  type MailThreadReproposal,
} from "../lib/api";
import { formatRelativeTime } from "../lib/format";
import { mailDetailQueryOptions, mailKeys, mailThreadQueryOptions } from "../lib/queries";
import { UntrustedHtmlFrame } from "./untrusted-html-frame";

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
         *
         * ⚠️ Prima della cache (migrazione 0076) questa frase prometteva due
         * cose che ora sarebbero false: che il messaggio venga chiesto a
         * Google *adesso*, e che non si salvi nulla. Prima del tap non si
         * sa da dove arriverà il corpo — quindi la frase dice ciò che è vero
         * in entrambi i casi, e la PROVENIENZA la dichiara la risposta
         * (`bodySource`), dopo.
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
        {original.isSuccess && (
          <>
            <p className="font-mono text-[11px] text-fg-faint">
              {original.data.bodySource === "cache"
                ? t("mail:detail.originalFromCache", {
                    when:
                      original.data.fetchedAt !== null
                        ? formatRelativeTime(original.data.fetchedAt)
                        : t("mail:detail.originalFetchedUnknown"),
                  })
                : t("mail:detail.originalFromGoogle")}
            </p>
            <OriginalMessage original={original.data} />
          </>
        )}
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

function OriginalMessage({ original }: { original: MailOriginal }) {
  const { t } = useTranslation();
  // `original.bodyHtml` può essere `undefined`, non solo `null`: il client
  // non valida la risposta con lo schema (nessun `.parse()` a runtime), e il
  // campo è nuovo (fase 9) — un server precedente semplicemente non lo manda.
  return (
    <div className="mt-3">
      {original.bodyHtml ? (
        <UntrustedHtmlFrame html={original.bodyHtml} title={t("mail:detail.bodyFrameTitle")} />
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


/**
 * Il pannello di lettura di una CONVERSAZIONE («la posta si legge per
 * conversazione» §4): i messaggi in ordine, ciascuno col suo mittente, la sua
 * data e il suo corpo.
 *
 * È anche ciò che dissolve il terzo sintomo da cui nasce tutto questo: non
 * serve più indovinare dove finisce un'email dentro un blocco citato, perché
 * i messaggi separati li dà Gmail, già separati. Per questo qui NON si
 * spacchetta nessuna catena citata — sarebbe euristica su testo scritto da
 * chiunque (design, «Cosa NON si fa»).
 *
 * Il corpo di ogni messaggio è l'ESTRATTO (`textExcerpt`): il messaggio
 * originale, con citazioni e allegati, resta a un tap di distanza dalla
 * vista per messaggio — una conversazione lunga di originali sarebbe di
 * nuovo il muro di testo che si sta togliendo.
 */
export function MailThreadPane({ threadId, onClose }: { threadId: string; onClose: () => void }) {
  const { t } = useTranslation();
  const query = useQuery(mailThreadQueryOptions(threadId));

  if (query.isPending) {
    return (
      <div aria-hidden="true" className="space-y-2">
        <div className="h-4 w-2/3 rounded-sm bg-ink-800" />
        <div className="h-3 w-1/3 rounded-sm bg-ink-800" />
        <div className="h-24 rounded-sm bg-ink-800" />
      </div>
    );
  }

  if (query.isError || query.data === undefined) {
    return <p className="text-sm text-fg-muted">{t("mail:detail.loadError")}</p>;
  }

  const thread = query.data;

  return (
    <article data-testid="mail-thread-pane">
      <header className="flex items-start justify-between gap-3 border-b border-line pb-3">
        <div className="min-w-0">
          {/* NON FIDATO: React escapa. */}
          <h2 className="truncate text-base font-semibold">{thread.subject ?? t("mail:noSubject")}</h2>
          <p className="mt-0.5 font-mono text-[11px] text-fg-faint">
            {t("mail:thread.messages", { count: thread.messages.length })} · {thread.accountEmail}
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          data-testid="mail-thread-close"
          className="shrink-0 font-mono text-[11px] text-fg-muted hover:text-fg"
        >
          {t("common:close")}
        </button>
      </header>

      <ol className="mt-3 space-y-3">
        {thread.messages.map((message) => (
          <li
            key={message.id}
            data-testid={`mail-thread-message-${message.id}`}
            className="rounded-sm border border-line bg-ink-950/40 p-3"
          >
            <div className="flex items-baseline justify-between gap-2">
              <span className="min-w-0 truncate font-mono text-[12px] text-fg-muted">{message.from}</span>
              <time dateTime={message.receivedAt} className="shrink-0 font-mono text-[11px] text-fg-faint">
                {formatRelativeTime(message.receivedAt)}
              </time>
            </div>
            {/*
             * Un messaggio di CONTESTO si dichiara tale: è entrato col
             * thread di un ammesso e non produrrà mai una proposta. Senza
             * questa riga sembrerebbe uno che non ne ha ancora prodotta —
             * due cose diverse.
             */}
            {!message.admitted && (
              <p className="mt-1 font-mono text-[11px] text-fg-faint">{t("mail:thread.context")}</p>
            )}
            {message.textExcerpt !== null ? (
              <pre className="mt-2 max-h-64 overflow-auto text-sm whitespace-pre-wrap text-fg">
                {message.textExcerpt}
              </pre>
            ) : (
              <p className="mt-2 font-mono text-[11px] text-fg-faint">{t("mail:detail.noExcerpt")}</p>
            )}
            {/*
             * «Riproponi», sul MESSAGGIO e non sulla conversazione: è
             * l'unica via di recupero da una proposta fallita o ignorata
             * per sbaglio, e senza un bottone resterebbe raggiungibile solo
             * con una chiamata HTTP a mano. Il server manda solo le
             * riproposizioni DAVVERO possibili, quindi qui non si rivaluta
             * nessuno stato: array vuoto = niente da mostrare, ed è il caso
             * normale.
             *
             * ⚠️ Il `?? []` non è difensivismo: a differenza dell'app, il
             * web NON valida le risposte con Zod (`api.get` fa un cast),
             * quindi il `.default([])` dello schema qui non gira mai e un
             * server che precede questo campo manderebbe `undefined`. Senza,
             * non sarebbe una riga mancante: salterebbe TUTTO il pannello di
             * lettura. C'è un test che lo fissa, con una fixture che il
             * campo non ce l'ha.
             */}
            {(message.reproposals ?? []).map((action) => (
              <ReproposeAction key={`${action.source}-${action.id}`} action={action} threadId={threadId} />
            ))}
          </li>
        ))}
      </ol>

      <a
        href={thread.url}
        target="_blank"
        rel="noopener noreferrer"
        className="mt-4 inline-flex min-h-9 items-center rounded-sm border border-line-strong px-3 font-mono text-[11px] tracking-[0.12em] text-fg-muted uppercase transition-colors hover:border-ink-700 hover:text-fg"
      >
        {t("mail:thread.openInGmail")}
      </a>
    </article>
  );
}

/**
 * Una riproposizione sola. È un componente a sé perché ogni proposta ha la
 * PROPRIA mutazione: con una sola condivisa, riproporne una lascerebbe
 * «Riproponendo…» su tutte le altre dello stesso messaggio.
 *
 * Il nome del progetto compare solo quando c'è: su uno smistamento non
 * esiste ancora, ed è esattamente la domanda che quella card fa.
 */
function ReproposeAction({ action, threadId }: { action: MailThreadReproposal; threadId: string }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const mutation = useMutation({
    mutationFn: () => postMailRepropose(action.source, action.id),
    onSuccess: () => {
      // La conversazione si rilegge: la riproposizione appena consumata
      // sparisce da sé, senza che questo componente indovini il nuovo stato.
      void queryClient.invalidateQueries({ queryKey: mailKeys.thread(threadId) });
      void queryClient.invalidateQueries({ queryKey: mailKeys.summary() });
    },
  });

  if (mutation.isSuccess) {
    return <p className="mt-2 font-mono text-[11px] text-fg-muted">{t("mail:reproposed")}</p>;
  }

  return (
    <div className="mt-2">
      <button
        type="button"
        onClick={() => mutation.mutate()}
        disabled={mutation.isPending}
        data-testid={`mail-thread-repropose-${action.id}`}
        className="inline-flex min-h-8 items-center rounded-sm border border-line-strong px-2 font-mono text-[11px] tracking-[0.12em] text-fg-muted uppercase transition-colors hover:border-ink-700 hover:text-fg disabled:opacity-50"
      >
        {mutation.isPending
          ? t("mail:reproposing")
          : action.projectName
            ? `${t("mail:repropose")} · ${action.projectName}`
            : t("mail:repropose")}
      </button>
      {mutation.isError && (
        <p className="mt-1 font-mono text-[11px] text-danger">{t("mail:reproposeError")}</p>
      )}
    </div>
  );
}
