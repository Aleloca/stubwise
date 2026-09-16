import type { MailThreadItem } from "@stubwise/shared";
import { useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { MailReadingPane, MailThreadPane } from "./mail-reading-pane";
import { FilterSelect } from "./ticket-filters";
import { formatRelativeTime } from "../lib/format";
import {
  mailThreadsQueryOptions,
  mailSummaryQueryOptions,
  myGoogleAccountsQueryOptions,
} from "../lib/queries";

/**
 * `MailWorkspace`: la posta a TRE COLONNE — a sinistra le caselle, al centro
 * le CONVERSAZIONI, a destra la lettura. Una pagina sola, non due: `/mail` e
 * `/mail/:source/:id` rendono entrambe questo componente, differendo solo per
 * `selected` — così la lista resta visibile mentre si legge, e l'URL di un
 * singolo messaggio resta condivisibile.
 *
 * ⚠️ **La lista è per THREAD, non per messaggio** («la posta si legge per
 * conversazione» §4): una riga per scambio, e aprendola si leggono tutti i
 * suoi messaggi in ordine. La vista per messaggio è stata TOLTA dal web (14
 * set 2026, decisione del maintainer), e con lei i filtri per stato e per
 * progetto — su una conversazione non vogliono dire niente, perché un thread
 * può toccare più progetti e avere più stati insieme — e la lista fusa col
 * calendario, che ha la sua pagina `/calendar`. Chi li rivuole progetti
 * l'equivalente a livello di THREAD: non si rimette la lista per messaggio.
 *
 * ⚠️ **`GET /api/me/mail` (per messaggio) NON è stata rimossa dal server e
 * non va rimossa**: la legge ogni build dell'app già installata su un
 * telefono, e ci passa il calendario. Il web ha smesso di usarla, il
 * contratto no.
 *
 * ⚠️ **La lista sarà sempre corta** (33 messaggi in produzione): disegnata
 * per venti righe, non per duemila.
 */
export interface MailSelection {
  source: "email" | "email_triage";
  id: string;
}

export function MailWorkspace({
  selected,
  openThreadId,
  highlightMessageId,
}: {
  selected: MailSelection | null;
  /**
   * La conversazione da aprire SUBITO, quando si arriva da `/mail/thread/:id`
   * (un risultato di ricerca, o un link condiviso). ⚠️ Semina lo stato locale
   * `openThread`, quindi chi passa questa prop deve KEYARE il componente su
   * di essa: la rotta lo fa.
   */
  openThreadId?: string;
  /** Il messaggio che ha combaciato con la ricerca, da segnare dentro il thread. */
  highlightMessageId?: string | null;
}) {
  const { t } = useTranslation();
  const [account, setAccount] = useState<string | undefined>(undefined);

  // La conversazione aperta nel pannello di lettura («la posta si legge per
  // conversazione» §4). Convive col `selected` che arriva dalla ROTTA
  // (`/mail/:source/:id`, il link dall'inbox): chi apre un thread dalla
  // lista lo vede vincere, chi arriva da una notifica vede il suo
  // messaggio. Senza questa distinzione il deep link avrebbe sempre la
  // meglio e la lista non si potrebbe più usare.
  const [openThread, setOpenThread] = useState<string | null>(openThreadId ?? null);

  const { data: accounts } = useSuspenseQuery(myGoogleAccountsQueryOptions);
  const { data: summary } = useQuery(mailSummaryQueryOptions);

  const threadsQuery = useQuery(mailThreadsQueryOptions(account));

  return (
    <div className="page mx-auto w-full max-w-6xl">
      <header className="border-b border-line pb-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h1 className="text-xl font-semibold">{t("mail:title")}</h1>
          {summary !== undefined && summary.openProposals > 0 && (
            <span
              data-testid="mail-open-proposals-badge"
              className="rounded-sm border border-signal-dim/50 px-2 py-0.5 font-mono text-[11px] text-signal"
            >
              {t("mail:openProposalsBadge", { count: summary.openProposals })}
            </span>
          )}
        </div>
        <p className="mt-1 text-sm text-fg-muted">{t("mail:subtitle")}</p>
      </header>

      <div className="mt-6 grid grid-cols-1 gap-4 lg:grid-cols-[200px_380px_1fr]">
        {/* Colonna sinistra: le caselle. */}
        <div className="flex flex-col gap-3 lg:border-r lg:border-line lg:pr-4">
          <FilterSelect
            id="mail-filter-account"
            label={t("mail:filters.account")}
            emptyLabel={t("mail:filters.allAccounts")}
            value={account}
            options={accounts.map((a) => ({ value: a.id, label: a.email }))}
            onChange={setAccount}
          />
          {/*
            I filtri per STATO e per PROGETTO non ci sono più: su una
            conversazione non vogliono dire niente — un thread può toccare
            più progetti e avere più stati insieme — e la rotta per thread
            non li accetta. È il costo accettato con la decisione di mostrare
            solo conversazioni; chi li rivuole progetti l'equivalente a
            livello di thread, non rimetta la lista per messaggio.
          */}
        </div>

        {/* Colonna centrale: le conversazioni. */}
        <div className="min-w-0">
          {threadsQuery.isPending ? (
            <MailSkeleton />
          ) : threadsQuery.isError ? (
            <div className="rounded-sm border border-dashed border-line-strong px-4 py-12 text-center">
              <p className="text-sm text-fg-muted">{t("mail:loadError")}</p>
              <button
                type="button"
                onClick={() => void threadsQuery.refetch()}
                className="mt-3 inline-flex min-h-9 items-center rounded-sm border border-line-strong px-3 font-mono text-[11px] tracking-[0.12em] text-fg-muted uppercase transition-colors hover:border-signal-dim hover:text-fg"
              >
                {t("common:retry")}
              </button>
            </div>
          ) : (threadsQuery.data?.items.length ?? 0) === 0 ? (
            <p className="rounded-sm border border-dashed border-line-strong px-4 py-12 text-center font-mono text-[12px] text-fg-faint">
              {t("mail:empty")}
            </p>
          ) : (
            <div className="rounded-sm border border-line bg-ink-900" data-testid="mail-thread-list">
              {threadsQuery.data!.items.map((thread) => (
                <ThreadRow
                  key={`${thread.accountId}-${thread.threadId}`}
                  thread={thread}
                  selected={openThread === thread.threadId}
                  onOpen={() => setOpenThread(thread.threadId)}
                />
              ))}
            </div>
          )}
        </div>

        {/* Colonna destra: la lettura. */}
        <div className="min-w-0 rounded-sm border border-line bg-ink-900 p-4 lg:sticky lg:top-4 lg:self-start">
          {openThread !== null ? (
            // La conversazione vince sul deep link: è stata aperta dopo, ed
            // è quello che si sta guardando.
            <MailThreadPane
              key={openThread}
              threadId={openThread}
              onClose={() => setOpenThread(null)}
              // Solo per la conversazione che arriva dall'URL: aprendone
              // un'altra dalla lista, l'evidenziazione del risultato di
              // ricerca non la segue.
              highlightMessageId={openThread === openThreadId ? (highlightMessageId ?? null) : null}
            />
          ) : selected ? (
            // Fix di review (bloccante, stessa classe del bug trovato in
            // `CalendarDetailPanel`): `/mail` e `/mail/:source/:id`
            // condividono la STESSA istanza di `MailWorkspace` fra un
            // messaggio e l'altro (nessun remount di route), quindi senza
            // `key` lo stato locale di `MailReadingPane` — in particolare la
            // `useMutation` di "Read original on Gmail" — resterebbe quello
            // del messaggio precedente: passando a un messaggio nuovo si
            // vedrebbe ancora il corpo riletto di quello vecchio, col
            // comando "Read original" già "consumato". La `key` forza il
            // remount a ogni cambio di messaggio.
            <MailReadingPane key={`${selected.source}-${selected.id}`} source={selected.source} id={selected.id} />
          ) : (
            <div className="flex h-full min-h-[200px] items-center justify-center rounded-sm border border-dashed border-line-strong px-4 py-12 text-center">
              <p className="font-mono text-[12px] text-fg-faint">{t("mail:detail.selectPrompt")}</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}


function MailSkeleton() {
  return (
    <div aria-hidden="true" className="rounded-sm border border-line bg-ink-900">
      {[0, 1, 2].map((row) => (
        <div key={row} className="space-y-2 border-b border-line px-4 py-3 last:border-b-0">
          <div className="h-3 w-28 rounded-sm bg-ink-800" />
          <div className="h-4 w-2/3 rounded-sm bg-ink-800" />
        </div>
      ))}
    </div>
  );
}


/**
 * UNA conversazione nella lista (design §4): oggetto, ultimo mittente e data
 * dell'ultimo messaggio, quanti messaggi contiene, e — quando ce ne sono —
 * quante proposte aspettano ancora una decisione.
 *
 * Un bottone e non un `Link`: la conversazione si apre nel pannello accanto,
 * senza cambiare rotta. Le rotte `/mail/:source/:id` restano quelle del deep
 * link da una notifica, che porta a UN messaggio.
 */
function ThreadRow({
  thread,
  selected,
  onOpen,
}: {
  thread: MailThreadItem;
  selected: boolean;
  onOpen: () => void;
}) {
  const { t } = useTranslation();
  return (
    <button
      type="button"
      onClick={onOpen}
      data-testid={`mail-thread-row-${thread.threadId}`}
      aria-pressed={selected}
      className={`block w-full border-b border-line px-4 py-3 text-left last:border-b-0 transition-colors ${
        selected ? "bg-ink-850" : "hover:bg-ink-850/60"
      }`}
    >
      <div className="flex items-baseline justify-between gap-2">
        {/* Testo NON FIDATO (lo scrive chi manda l'email): React lo escapa. */}
        <span className="min-w-0 truncate text-sm font-medium text-fg">{thread.lastFrom}</span>
        <span className="shrink-0 font-mono text-[11px] text-fg-faint">
          {formatRelativeTime(thread.lastReceivedAt)}
        </span>
      </div>
      <p className="mt-0.5 truncate text-sm text-fg-muted">
        {thread.subject ?? t("mail:noSubject")}
      </p>
      <div className="mt-1.5 flex flex-wrap items-center gap-2 font-mono text-[11px] text-fg-faint">
        {thread.messageCount > 1 && <span>{t("mail:thread.messages", { count: thread.messageCount })}</span>}
        {thread.openProposals > 0 && (
          <span className="text-signal">{t("mail:thread.open", { count: thread.openProposals })}</span>
        )}
        {thread.projectNames.map((name) => (
          <span key={name} className="truncate">
            {name}
          </span>
        ))}
      </div>
    </button>
  );
}
