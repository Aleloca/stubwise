import { useQuery, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { InboxItemCard, isDecisionItem } from "../components/inbox-item";
import { FilterSelect } from "../components/ticket-filters";
import {
  getInbox,
  postInboxRead,
  type InboxFilters,
  type InboxItem,
  type InboxPage,
  type InboxStatus,
} from "../lib/api";
import { meQueryOptions } from "../lib/auth";
import { inboxKeys, inboxQueryOptions, projectsQueryOptions } from "../lib/queries";

/**
 * Le tre viste dell'inbox, che coincidono con gli stati di una riga. `open` è
 * la home operativa e si divide in due sezioni ("Da decidere" / "Da sapere");
 * `snoozed` e `handled` sono elenchi semplici.
 */
const TABS: { status: InboxStatus; labelKey: string }[] = [
  { status: "open", labelKey: "inbox:tabs.open" },
  // La tab dei rinvii riusa l'etichetta della sezione ("Posticipate"): è la
  // stessa cosa vista da due punti, e due chiavi diverse si sfaserebbero.
  { status: "snoozed", labelKey: "inbox:sections.snoozed" },
  { status: "handled", labelKey: "inbox:tabs.handled" },
];

/**
 * Pagina `/inbox`: quello che aspetta una decisione e quello che va solo saputo.
 *
 * Una sola colonna anche su desktop (`max-w-3xl`): è una lista da smaltire
 * dall'alto verso il basso, non una tabella da confrontare, e la stessa forma
 * regge sul pollice.
 *
 * Tab e filtro progetto vivono nello STATO del componente, non nell'URL (a
 * differenza di /tickets e /backlog): l'inbox è personale ed effimera, non c'è
 * una vista da condividere via link, e il loader della route può così
 * prefetchare l'unica combinazione che conta — quella d'ingresso.
 */
export function InboxPage() {
  const { t } = useTranslation();
  const [status, setStatus] = useState<InboxStatus>("open");
  const [projectId, setProjectId] = useState<string | undefined>(undefined);

  const { data: me } = useSuspenseQuery(meQueryOptions);
  const { data: projects } = useSuspenseQuery(projectsQueryOptions);

  // FORMA CANONICA DEI FILTRI: `status` è SEMPRE esplicito (mai `{}` per dire
  // "le aperte"), così la chiave di cache della pagina coincide con quella
  // prefetchata dal loader e con quella invalidata dopo un'azione. Il filtro
  // progetto invece si omette quando è assente: react-query normalizza la
  // chiave via JSON, dove una proprietà `undefined` sparisce comunque, e
  // ometterla tiene l'intenzione visibile nel codice. Vedi anche il commento
  // su `inboxQueryOptions`.
  const filters: InboxFilters = { status, ...(projectId ? { projectId } : {}) };

  const query = useQuery(inboxQueryOptions(filters));
  const items = query.data?.items ?? [];
  const projectNames = new Map(projects.map((project) => [project.id, project.name]));
  const currentUser = { id: me.user.id, email: me.user.email };

  useMarkVisibleAsRead(items);

  return (
    <div className="page mx-auto w-full max-w-3xl">
      <header className="border-b border-line pb-4">
        <h1 className="text-xl font-semibold">{t("inbox:title")}</h1>
        <p className="mt-1 text-sm text-fg-muted">{t("inbox:subtitle")}</p>
      </header>

      <div className="mt-6 flex flex-wrap items-end justify-between gap-4">
        <div className="flex flex-wrap gap-2" role="tablist" aria-label={t("inbox:title")}>
          {TABS.map((tab) => (
            <button
              key={tab.status}
              type="button"
              role="tab"
              aria-selected={status === tab.status}
              onClick={() => setStatus(tab.status)}
              className={`inline-flex min-h-11 items-center rounded-sm border px-3 font-mono text-[11px] tracking-[0.12em] uppercase transition-colors sm:min-h-9 ${
                status === tab.status
                  ? "border-signal-dim bg-ink-850 text-fg"
                  : "border-line-strong text-fg-muted hover:border-ink-700 hover:text-fg"
              }`}
            >
              {t(tab.labelKey)}
            </button>
          ))}
        </div>

        <FilterSelect
          id="inbox-filter-project"
          label={t("inbox:filters.project")}
          emptyLabel={t("inbox:filters.allProjects")}
          value={projectId}
          options={projects.map((project) => ({ value: project.id, label: project.name }))}
          onChange={setProjectId}
        />
      </div>

      <div className="mt-6">
        {query.isPending ? (
          <InboxSkeleton />
        ) : query.isError ? (
          <div className="rounded-sm border border-dashed border-line-strong px-4 py-12 text-center">
            <p className="text-sm text-fg-muted">{t("inbox:loadError")}</p>
            <button
              type="button"
              onClick={() => void query.refetch()}
              className="mt-3 inline-flex min-h-9 items-center rounded-sm border border-line-strong px-3 font-mono text-[11px] tracking-[0.12em] text-fg-muted uppercase transition-colors hover:border-signal-dim hover:text-fg"
            >
              {t("common:retry")}
            </button>
          </div>
        ) : status === "open" ? (
          <>
            <InboxSection
              title={t("inbox:sections.toDecide")}
              items={items.filter(isDecisionItem)}
              filters={filters}
              projectNames={projectNames}
              currentUser={currentUser}
            />
            <div className="mt-8">
              <InboxSection
                title={t("inbox:sections.toKnow")}
                items={items.filter((item) => !isDecisionItem(item))}
                filters={filters}
                projectNames={projectNames}
                currentUser={currentUser}
              />
            </div>
          </>
        ) : (
          <InboxSection
            title={t(status === "snoozed" ? "inbox:sections.snoozed" : "inbox:tabs.handled")}
            items={items}
            filters={filters}
            projectNames={projectNames}
            currentUser={currentUser}
          />
        )}

        {query.data?.nextCursor != null && <LoadMore filters={filters} />}
      </div>
    </div>
  );
}

interface InboxSectionProps {
  title: string;
  items: InboxItem[];
  filters: InboxFilters;
  projectNames: Map<string, string>;
  currentUser: { id: string; email: string };
}

/** Una sezione con il suo titolo e il suo vuoto: mai una lista senza contesto. */
function InboxSection({ title, items, filters, projectNames, currentUser }: InboxSectionProps) {
  const { t } = useTranslation();

  return (
    // `region` con nome accessibile: le sezioni sono la struttura della pagina,
    // e devono essere navigabili come tali (oltre che interrogabili nei test).
    <section aria-label={title}>
      <h2 className="font-mono text-[11px] tracking-[0.18em] text-fg-faint uppercase">{title}</h2>
      {items.length === 0 ? (
        <p className="mt-2 rounded-sm border border-dashed border-line-strong px-4 py-8 text-center font-mono text-[12px] text-fg-faint">
          {t("inbox:empty")}
        </p>
      ) : (
        <div className="mt-2 rounded-sm border border-line bg-ink-900">
          {items.map((item) => (
            <InboxItemCard
              key={item.id}
              item={item}
              projectName={item.projectId ? projectNames.get(item.projectId) : undefined}
              filters={filters}
              currentUser={currentUser}
            />
          ))}
        </div>
      )}
    </section>
  );
}

/**
 * "Carica altre": PAGINAZIONE A CURSORE senza `useInfiniteQuery`.
 *
 * La pagina successiva viene FUSA nella stessa voce di cache della prima
 * (`inboxKeys.list(filters)`), non tenuta in uno stato locale: così tutte le
 * righe caricate restano un unico oggetto, e gli update ottimistici delle card
 * (che scrivono su quella chiave) funzionano identici sulla riga 3 e sulla 90.
 * Con `useInfiniteQuery` la cache avrebbe una forma diversa da quella
 * prefetchata dal loader, e ogni card dovrebbe sapere in quale pagina vive.
 *
 * Conseguenza accettata: un'invalidazione (dopo un'azione, o al cambio del
 * contatore) riporta la lista alla PRIMA pagina.
 */
function LoadMore({ filters }: { filters: InboxFilters }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [loading, setLoading] = useState(false);

  async function handleClick() {
    const key = inboxKeys.list(filters);
    const current = queryClient.getQueryData<InboxPage>(key);
    if (!current?.nextCursor) return;
    setLoading(true);
    try {
      const next = await getInbox(filters, current.nextCursor);
      queryClient.setQueryData<InboxPage>(key, (page) => {
        if (!page) return next;
        // Dedup per id: fra il click e la risposta un'invalidazione può aver
        // riportato la cache alla PRIMA pagina, e le righe in arrivo
        // potrebbero già esserci. Concatenare senza filtrare darebbe chiavi
        // React duplicate (e righe doppie a schermo).
        const seen = new Set(page.items.map((row) => row.id));
        return {
          items: [...page.items, ...next.items.filter((row) => !seen.has(row.id))],
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
        {loading ? t("inbox:loadingMore") : t("inbox:loadMore")}
      </button>
    </div>
  );
}

/** Scheletro sobrio: tre righe grigie, nessuna animazione appariscente. */
function InboxSkeleton() {
  return (
    <div aria-hidden="true" className="rounded-sm border border-line bg-ink-900">
      {[0, 1, 2].map((row) => (
        <div key={row} className="space-y-2 border-b border-line px-4 py-4 last:border-b-0">
          <div className="h-3 w-28 rounded-sm bg-ink-800" />
          <div className="h-4 w-2/3 rounded-sm bg-ink-800" />
        </div>
      ))}
    </div>
  );
}

/**
 * Segna come lette le righe mostrate che non lo sono ancora.
 *
 * Best-effort e silenzioso: nessuno spinner, nessun errore a schermo — se la
 * chiamata fallisce la riga resta non letta e ci si riprova al prossimo render
 * (l'id esce dal set dei "già tentati"). Il set vive in un ref e non nello
 * stato, così marcare non provoca un re-render che rifarebbe partire l'effetto.
 * Il contatore della campanella si invalida a fine giro, così il numero scende
 * subito invece di aspettare il polling.
 *
 * COSTO ACCETTATO: quel contatore che scende è un CAMBIAMENTO, e
 * `useInboxUnreadWatcher` reagisce ai cambiamenti invalidando le liste — così
 * aprire l'inbox con righe non lette produce un secondo GET della lista entro
 * pochi secondi. Non è un ciclo: il refetch torna con `readAt` valorizzato,
 * l'effetto non marca più nulla, il contatore non cambia più e la cosa si
 * ferma. Si preferisce questo alla campanella che resta accesa su notifiche
 * che l'utente sta guardando.
 */
function useMarkVisibleAsRead(items: InboxItem[]): void {
  const queryClient = useQueryClient();
  const attempted = useRef(new Set<string>());

  useEffect(() => {
    const unread = items.filter((item) => item.readAt === null && !attempted.current.has(item.id));
    if (unread.length === 0) return;
    for (const item of unread) attempted.current.add(item.id);
    void Promise.all(
      unread.map((item) =>
        postInboxRead(item.id).catch(() => {
          attempted.current.delete(item.id);
        }),
      ),
    ).then(() => queryClient.invalidateQueries({ queryKey: inboxKeys.unread() }));
  }, [items, queryClient]);
}
