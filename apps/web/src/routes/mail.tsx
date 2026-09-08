import type { MailItem, MailItemStatus, MailSource } from "@stubwise/shared";
import { useMutation, useQuery, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { SignalBadge } from "../components/badges";
import { FilterSelect } from "../components/ticket-filters";
import { getMail, postMailRepropose, type MailFilters, type MailPage } from "../lib/api";
import { formatRelativeTime } from "../lib/format";
import {
  mailKeys,
  mailQueryOptions,
  mailSummaryQueryOptions,
  myGoogleAccountsQueryOptions,
  projectsQueryOptions,
} from "../lib/queries";

/**
 * Pagina `/mail`: messaggi Gmail ed eventi di calendario TRATTATI dal poller,
 * per l'utente autenticato — casella, progetto, segnale, stato, esito, data.
 * Filtri per casella/stato/progetto (stato del componente, come `/inbox`:
 * personale ed effimera, nessuna vista da condividere via link). «Riproponi»
 * su `failed`/`ignored` resetta lo stato: il PROSSIMO tick del poller genera
 * una proposta NUOVA (non ripubblica da qui — vedi `postMailRepropose`).
 *
 * Fase 6b: una riga email è ormai una PROPOSTA (`email_proposals`), non un
 * messaggio — un messaggio con più proposte produce più righe consecutive con
 * lo stesso mittente e lo stesso oggetto, distinte dal BADGE di progetto
 * (`MailRow`) e da stato/esito propri. `item.id` è quello della proposta:
 * «Riproponi» agisce sempre e solo sulla riga cliccata, mai sulle sorelle
 * dello stesso messaggio. Nessun cambiamento per il calendario, ancora uno a
 * uno.
 *
 * Fase 6c (fix di review, Task 3): una TERZA specie di riga, `item.kind ===
 * "triage"` — un messaggio «da smistare» (`classify.ts`,
 * `EmailTriageClassification`): NESSUN progetto risolto (`projectId`/
 * `projectName` sempre `null`), quindi `MailRow` non mostra il badge di
 * progetto ma un'etichetta «da smistare», e se l'esito è
 * `outcome.type === "triage_dismissed"` («nessuno di questi») lo rende
 * leggibile invece del generico stato "Ignored". `item.source` resta
 * `"email"` (la riga viene comunque da Gmail, il badge sorgente e il link al
 * thread non cambiano): è `kind`, non `source`, a distinguerla. La rotta di
 * repropose la disambigua invece nel PATH — `"email_triage"`, un terzo
 * valore che SOLO quella rotta accetta (vedi `postMailRepropose` e il
 * docblock di `mailItemSchema` in `@stubwise/shared`): l'`id` di una riga
 * `triage` è `email_messages.id` (il PADRE), non `email_proposals.id` come
 * per una proposta normale — un `source` sbagliato nel path la cercherebbe
 * nella tabella sbagliata.
 */
const STATUS_OPTIONS: MailItemStatus[] = [
  "new",
  "classified",
  "proposed",
  "actioned",
  "ignored",
  "failed",
  "cancelled",
];

/** Colore-stato, come `STATUS_DOT` in `badges.tsx`: solo il colore distingue. */
const STATUS_CLASS: Record<MailItemStatus, string> = {
  new: "text-fg-muted",
  classified: "text-sky-400",
  proposed: "text-signal",
  actioned: "text-ok",
  ignored: "text-fg-faint",
  failed: "text-danger",
  cancelled: "text-fg-faint",
};

export function MailPage() {
  const { t } = useTranslation();
  const [account, setAccount] = useState<string | undefined>(undefined);
  const [status, setStatus] = useState<MailItemStatus | undefined>(undefined);
  const [projectId, setProjectId] = useState<string | undefined>(undefined);

  const { data: accounts } = useSuspenseQuery(myGoogleAccountsQueryOptions);
  const { data: projects } = useSuspenseQuery(projectsQueryOptions);
  const { data: summary } = useQuery(mailSummaryQueryOptions);

  const filters: MailFilters = {
    ...(account ? { account } : {}),
    ...(status ? { status } : {}),
    ...(projectId ? { project: projectId } : {}),
  };
  const query = useQuery(mailQueryOptions(filters));
  const items = query.data?.items ?? [];
  const projectNames = new Map(projects.map((project) => [project.id, project.name]));

  return (
    <div className="page mx-auto w-full max-w-4xl">
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

      <div className="mt-6 flex flex-wrap gap-4">
        <FilterSelect
          id="mail-filter-account"
          label={t("mail:filters.account")}
          emptyLabel={t("mail:filters.allAccounts")}
          value={account}
          options={accounts.map((a) => ({ value: a.id, label: a.email }))}
          onChange={setAccount}
        />
        <FilterSelect
          id="mail-filter-status"
          label={t("mail:filters.status")}
          emptyLabel={t("mail:filters.allStatuses")}
          value={status}
          options={STATUS_OPTIONS.map((s) => ({ value: s, label: t(`mail:status.${s}`) }))}
          onChange={(value) => setStatus(value as MailItemStatus | undefined)}
        />
        <FilterSelect
          id="mail-filter-project"
          label={t("mail:filters.project")}
          emptyLabel={t("mail:filters.allProjects")}
          value={projectId}
          options={projects.map((project) => ({ value: project.id, label: project.name }))}
          onChange={setProjectId}
        />
      </div>

      <div className="mt-6">
        {query.isPending ? (
          <MailSkeleton />
        ) : query.isError ? (
          <div className="rounded-sm border border-dashed border-line-strong px-4 py-12 text-center">
            <p className="text-sm text-fg-muted">{t("mail:loadError")}</p>
            <button
              type="button"
              onClick={() => void query.refetch()}
              className="mt-3 inline-flex min-h-9 items-center rounded-sm border border-line-strong px-3 font-mono text-[11px] tracking-[0.12em] text-fg-muted uppercase transition-colors hover:border-signal-dim hover:text-fg"
            >
              {t("common:retry")}
            </button>
          </div>
        ) : items.length === 0 ? (
          <p className="rounded-sm border border-dashed border-line-strong px-4 py-12 text-center font-mono text-[12px] text-fg-faint">
            {t("mail:empty")}
          </p>
        ) : (
          <div className="rounded-sm border border-line bg-ink-900">
            {items.map((item) => (
              <MailRow
                key={`${item.source}-${item.id}`}
                item={item}
                projectName={item.projectId ? projectNames.get(item.projectId) : undefined}
                filters={filters}
              />
            ))}
          </div>
        )}

        {query.data?.nextCursor != null && <LoadMore filters={filters} />}
      </div>
    </div>
  );
}

interface MailRowProps {
  item: MailItem;
  projectName?: string;
  filters: MailFilters;
}

/**
 * Fase 6c (fix di review, Task 3): «nessuno di questi» — l'esito che
 * `google-proposal.ts` scrive SOLO per uno smistamento chiuso senza scelta
 * (`outcome: { type: "triage_dismissed" }`), distinto da un `ignored`
 * generico (`outcome: null`, nessun segnale). `item.outcome` è un
 * `Record<string, unknown> | null` non tipizzato più a fondo dallo schema
 * (è testo NON FIDATO scritto dal server, ma la FORMA del campo `type` è
 * quella che il server stesso garantisce per questo esito): il controllo
 * qui è la lettura TOLLERANTE gemella di quella lato server.
 */
function isTriageDismissed(outcome: MailItem["outcome"]): boolean {
  return (
    typeof outcome === "object" &&
    outcome !== null &&
    (outcome as Record<string, unknown>).type === "triage_dismissed"
  );
}

function MailRow({ item, projectName, filters }: MailRowProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const listKey = mailKeys.list(filters);
  const isTriage = item.kind === "triage";

  const repropose = useMutation({
    // Fase 6c: una riga `triage` vive su `email_messages` (il PADRE), non su
    // `email_proposals` — la rotta la disambigua con un TERZO valore di
    // `source` nel path, solo per questa mutazione (vedi il docblock del
    // modulo). `item.source` resta `"email"`: il cast riflette che
    // `postMailRepropose` conosce solo i due valori "fisici" storici, non
    // il terzo che esiste solo lato rotta di repropose.
    mutationFn: () =>
      postMailRepropose(isTriage ? ("email_triage" as MailSource) : item.source, item.id),
    onMutate: () => setError(null),
    onSuccess: () => {
      // La riga esce dalla lista (torna `new`, non più `failed`/`ignored`
      // finché il poller non la riclassifica): tolta subito in ottimistico,
      // niente doppio click su "Riproponi" nella finestra fino al refetch.
      queryClient.setQueryData<MailPage>(listKey, (page) =>
        page ? { ...page, items: page.items.filter((row) => row.id !== item.id) } : page,
      );
      void queryClient.invalidateQueries({ queryKey: mailKeys.lists() });
      void queryClient.invalidateQueries({ queryKey: mailKeys.summary() });
    },
    onError: () => setError(t("mail:reproposeError")),
  });

  return (
    <article className="border-b border-line px-4 py-3 last:border-b-0">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[11px] text-fg-faint">
        <span className="rounded-sm border border-line bg-ink-850 px-1.5 py-0.5 text-fg-muted">
          {t(`mail:source.${item.source}`)}
        </span>
        {/*
         * Fase 6c: uno smistamento non ha MAI un progetto — mostra
         * un'etichetta «da smistare» al posto del badge di progetto, non
         * nessun badge: senza progetto risolto, "questa riga chiede di
         * scegliere" è l'informazione che manca a chi scorre la lista.
         */}
        {isTriage ? (
          <span
            data-testid="mail-triage-badge"
            className="rounded-sm border border-line bg-ink-850 px-1.5 py-0.5 text-fg-muted"
          >
            {t("mail:triage.badge", "To sort")}
          </span>
        ) : (
          /*
           * Fase 6b: il badge di progetto è ciò che distingue righe
           * altrimenti identiche (stesso mittente, stesso oggetto) quando
           * lo stesso messaggio genera più proposte — bordato come il
           * badge `source` qui sopra, non più un semplice testo, perché
           * ora è lui a rispondere alla domanda «di quale progetto è
           * questa riga?».
           */
          projectName !== undefined && (
            <span className="rounded-sm border border-signal-dim/50 bg-ink-850 px-1.5 py-0.5 text-signal">
              {projectName}
            </span>
          )
        )}
        {item.signal !== null && <SignalBadge signal={item.signal} />}
        <span className={STATUS_CLASS[item.status]}>{t(`mail:status.${item.status}`)}</span>
        <time dateTime={item.date} title={item.date}>
          {formatRelativeTime(item.date)}
        </time>
      </div>

      <p className="mt-1.5 text-sm text-fg">
        <span className="text-fg-muted">{item.from || t("inbox:google.unknownSender")}</span>
        {item.title !== null && item.title !== "" && <span> — {item.title}</span>}
        {(item.title === null || item.title === "") && (
          <span className="text-fg-faint"> {t("mail:noSubject")}</span>
        )}
      </p>

      {/*
       * Fase 6c: «nessuno di questi» leggibile invece del generico stato
       * "Ignored" — distingue uno smistamento CHIUSO senza scelta da un
       * `ignored` per assenza di segnale (`outcome: null`), che non mostra
       * questa riga.
       */}
      {isTriage && isTriageDismissed(item.outcome) && (
        <p className="mt-1 font-mono text-[11px] text-fg-faint">
          {t("mail:triage.dismissedOutcome", "Sorted — none of the suggested projects matched")}
        </p>
      )}

      {item.error !== null && (
        <p className="mt-1 font-mono text-[11px] text-danger">{item.error}</p>
      )}

      {error !== null && (
        <p role="alert" className="mt-1 font-mono text-[11px] text-danger">
          {error}
        </p>
      )}

      <div className="mt-2 flex flex-wrap items-center gap-2">
        {item.url !== null && (
          <a
            href={item.url}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex min-h-9 items-center rounded-sm border border-line-strong px-3 font-mono text-[11px] tracking-[0.12em] text-fg-muted uppercase transition-colors hover:border-ink-700 hover:text-fg"
          >
            {t("mail:open")}
          </a>
        )}
        {item.reproposable && (
          <button
            type="button"
            disabled={repropose.isPending}
            onClick={() => repropose.mutate()}
            className="inline-flex min-h-9 items-center rounded-sm bg-signal px-3 font-mono text-[11px] tracking-[0.12em] text-ink-950 uppercase transition-colors hover:bg-signal-bright active:bg-signal-dim disabled:cursor-not-allowed disabled:opacity-50"
          >
            {repropose.isPending ? t("mail:reproposing") : t("mail:repropose")}
          </button>
        )}
        {repropose.isSuccess && (
          <span role="status" className="font-mono text-[11px] text-ok">
            {t("mail:reproposed")}
          </span>
        )}
      </div>
    </article>
  );
}

/** "Carica altre": stesso schema a cursore di `/inbox` (vedi `LoadMore` lì). */
function LoadMore({ filters }: { filters: MailFilters }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [loading, setLoading] = useState(false);

  async function handleClick() {
    const key = mailKeys.list(filters);
    const current = queryClient.getQueryData<MailPage>(key);
    if (!current?.nextCursor) return;
    setLoading(true);
    try {
      const next = await getMail(filters, current.nextCursor);
      queryClient.setQueryData<MailPage>(key, (page) => {
        if (!page) return next;
        const seen = new Set(page.items.map((row) => `${row.source}-${row.id}`));
        return {
          items: [
            ...page.items,
            ...next.items.filter((row) => !seen.has(`${row.source}-${row.id}`)),
          ],
          nextCursor: next.nextCursor,
        };
      });
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="mt-6 grid place-items-center">
      <button
        type="button"
        disabled={loading}
        onClick={() => void handleClick()}
        className="inline-flex min-h-11 items-center rounded-sm border border-line-strong px-4 font-mono text-[11px] tracking-[0.12em] text-fg-muted uppercase transition-colors hover:border-signal-dim hover:text-fg disabled:opacity-50 sm:min-h-9"
      >
        {loading ? t("mail:loadingMore") : t("mail:loadMore")}
      </button>
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
