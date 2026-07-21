import {
  backlogItemStatusSchema,
  backlogRiskSchema,
  ticketPrioritySchema,
  type BacklogItemStatus,
  type BacklogRisk,
  type TicketPriority,
} from "@stubwise/shared";
import {
  useQueryClient,
  useSuspenseInfiniteQuery,
  useSuspenseQuery,
} from "@tanstack/react-query";
import { getRouteApi, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { z } from "zod";
import {
  BACKLOG_RISK_LABEL_KEYS,
  BACKLOG_STATUS_LABEL_KEYS,
  BacklogEffortBadge,
  BacklogRiskBadge,
  BacklogStatusBadge,
  PRIORITY_LABEL_KEYS,
  PriorityBadge,
} from "../../components/badges";
import { DebouncedSearchField } from "../../components/debounced-search-field";
import { NewBacklogItemDialog } from "../../components/new-backlog-item-dialog";
import { FilterSelect } from "../../components/ticket-filters";
import {
  postBacklogItem,
  type BacklogFilters,
  type BacklogItem,
  type Project,
} from "../../lib/api";
import { formatRelativeTime } from "../../lib/format";
import { backlogInfiniteQueryOptions, backlogKeys, projectsQueryOptions } from "../../lib/queries";

/**
 * Search param della lista backlog: ogni filtro è opzionale e validato contro
 * gli enum di dominio. `.catch(undefined)` scarta i valori malformati di un URL
 * scritto a mano invece di mandare la route in errore. Lo schema coincide con
 * {@link BacklogFilters}: i search param SONO i filtri API (nessuna
 * trasformazione), quindi loader e componente producono la stessa query key.
 *
 * Sullo stato NON c'è il valore sintetico `"all"` dei ticket: il server esclude
 * `converted`/`archived` quando `status` è assente, e li si mostra scegliendoli
 * esplicitamente dal select — l'API non ha un multi-stato equivalente.
 */
export const backlogSearchSchema = z.object({
  projectId: z.uuid().optional().catch(undefined),
  status: backlogItemStatusSchema.optional().catch(undefined),
  urgency: ticketPrioritySchema.optional().catch(undefined),
  risk: backlogRiskSchema.optional().catch(undefined),
  q: z.string().min(1).optional().catch(undefined),
}) satisfies z.ZodType<BacklogFilters>;

export type BacklogSearch = z.infer<typeof backlogSearchSchema>;

// L'id della route include il layout autenticato (id "authed").
const route = getRouteApi("/authed/backlog");

/** Cadenza del polling della lista mentre un intake accodato è in attesa. */
const INTAKE_POLL_INTERVAL_MS = 10_000;
/** Tetto del polling post-202: oltre si smette (intake in stallo o fallito). */
const INTAKE_POLL_MAX_MS = 5 * 60_000;

/** Intake accodato dal 202: quanti item c'erano al POST e quando è partito. */
interface PendingIntake {
  baselineCount: number;
  startedAt: number;
}

/**
 * Lista del backlog di discovery. Come /tickets: i filtri vivono interamente
 * nell'URL, ogni modifica naviga (replace) e il loader della route ha già messo
 * in cache la prima pagina per quei filtri. La creazione manuale non produce
 * subito una voce (il worker la elabora in modo asincrono): il POST 202 mostra
 * un banner "in elaborazione", invalida la lista e attiva un polling che si
 * ferma da solo quando la voce compare (o al tetto di 5 minuti).
 */
export function BacklogPage() {
  const { t } = useTranslation();
  const search = route.useSearch();
  const navigate = route.useNavigate();
  const queryClient = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [pendingIntake, setPendingIntake] = useState<PendingIntake | null>(null);

  const { data: projects } = useSuspenseQuery(projectsQueryOptions);
  const { data, fetchNextPage, hasNextPage, isFetchingNextPage } = useSuspenseInfiniteQuery({
    ...backlogInfiniteQueryOptions(search),
    // Polling post-202 (pattern /activity): mentre un intake è accodato la
    // lista si ricarica ogni 10s così la voce compare senza intervento; il
    // tetto a 5 minuti evita un polling infinito su un intake in stallo.
    // Funzione, non valore: rivalutata a ogni tick, così il tetto scatta anche
    // senza re-render.
    refetchInterval: () =>
      pendingIntake && Date.now() - pendingIntake.startedAt < INTAKE_POLL_MAX_MS
        ? INTAKE_POLL_INTERVAL_MS
        : false,
  });

  const items = data.pages.flatMap((page) => page.items);
  const projectNames = new Map(projects.map((project) => [project.id, project.name]));

  // Auto-dismiss del banner: quando la lista cresce rispetto al momento del
  // POST l'intake è arrivato — banner via e polling spento (refetchInterval
  // torna false). Il confronto è sul conteggio, non sull'identità: l'intake
  // può anche NON creare una voce nuova (dedup su una esistente), nel qual
  // caso resta il dismiss manuale o il tetto del polling.
  const itemCount = items.length;
  useEffect(() => {
    if (pendingIntake && itemCount > pendingIntake.baselineCount) {
      setPendingIntake(null);
    }
  }, [pendingIntake, itemCount]);

  function handleFiltersChange(patch: Partial<BacklogSearch>) {
    void navigate({
      // I filtri non intasano la history: avanti/indietro naviga tra pagine.
      search: (prev) => ({ ...prev, ...patch }),
      replace: true,
    });
  }

  async function handleCreate(input: { projectId: string; title: string; body: string }) {
    await postBacklogItem(input);
    // Il 202 NON crea la voce: il worker fa l'intake (dedup + metadati) in
    // secondi/minuti. Segnaliamo l'attesa (banner + polling), invalidiamo la
    // lista e memorizziamo il conteggio attuale come baseline per l'auto-dismiss.
    setPendingIntake({ baselineCount: itemCount, startedAt: Date.now() });
    void queryClient.invalidateQueries({ queryKey: backlogKeys.lists() });
    setCreating(false);
  }

  return (
    <div className="page">
      <header className="flex flex-wrap items-end justify-between gap-4 border-b border-line pb-4">
        <div>
          <h1 className="text-xl font-semibold">{t("backlog:list.title")}</h1>
          <p className="mt-1 text-sm text-fg-muted">{t("backlog:list.subtitle")}</p>
        </div>
        <button
          type="button"
          onClick={() => setCreating(true)}
          disabled={projects.length === 0}
          title={projects.length === 0 ? t("backlog:list.createProjectFirst") : undefined}
          className="rounded-sm bg-signal px-4 py-2 font-mono text-[12px] font-semibold tracking-[0.08em] text-ink-950 uppercase transition-colors hover:bg-signal-bright active:bg-signal-dim disabled:cursor-not-allowed disabled:bg-signal-dim disabled:opacity-60"
        >
          {t("backlog:list.newItem")}
        </button>
      </header>

      {creating && (
        <NewBacklogItemDialog
          projects={projects}
          onSubmit={handleCreate}
          onClose={() => setCreating(false)}
        />
      )}

      {pendingIntake && (
        <div
          role="status"
          className="mt-4 flex items-center justify-between gap-4 rounded-sm border border-signal-dim/40 bg-ink-900 px-4 py-3"
        >
          <p className="text-sm text-fg-muted">{t("backlog:list.processing")}</p>
          <button
            type="button"
            onClick={() => setPendingIntake(null)}
            className="shrink-0 rounded-sm border border-line-strong px-2 py-1 font-mono text-[11px] tracking-[0.12em] text-fg-muted uppercase transition-colors hover:border-ink-700 hover:text-fg"
          >
            {t("backlog:list.dismiss")}
          </button>
        </div>
      )}

      <div className="mt-6">
        <BacklogFilterBar value={search} projects={projects} onChange={handleFiltersChange} />
      </div>

      {items.length === 0 ? (
        <div className="mt-6 grid place-items-center rounded-sm border border-dashed border-line-strong py-24">
          <p className="font-mono text-[12px] tracking-[0.18em] text-fg-faint uppercase">
            {t("backlog:list.empty")}
          </p>
          <p className="mt-2 text-sm text-fg-muted">{t("backlog:list.emptyHint")}</p>
        </div>
      ) : (
        <div className="mt-6 rounded-sm border border-line bg-ink-900">
          {items.map((item) => (
            <BacklogCard
              key={item.id}
              item={item}
              projectName={projectNames.get(item.projectId) ?? "—"}
            />
          ))}

          {hasNextPage && (
            <div className="grid place-items-center py-4">
              <button
                type="button"
                onClick={() => void fetchNextPage()}
                disabled={isFetchingNextPage}
                className="rounded-sm border border-line-strong px-4 py-1.5 font-mono text-[11px] tracking-[0.12em] text-fg-muted uppercase transition-colors hover:border-signal-dim hover:text-fg disabled:opacity-50"
              >
                {isFetchingNextPage
                  ? t("backlog:list.loadingMore")
                  : t("backlog:list.loadMore")}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

interface BacklogFilterBarProps {
  value: BacklogSearch;
  projects: Project[];
  onChange: (patch: Partial<BacklogSearch>) => void;
}

/**
 * Barra dei filtri del backlog. Componente puro: lo stato vive nell'URL, qui
 * arrivano `value` e si emettono patch via `onChange`. La ricerca è debounced
 * per non riscrivere l'URL a ogni tasto (stesso {@link DebouncedSearchField}
 * condiviso con {@link TicketFilters}).
 */
function BacklogFilterBar({ value, projects, onChange }: BacklogFilterBarProps) {
  const { t } = useTranslation();

  return (
    <div className="flex flex-wrap items-end gap-3">
      <DebouncedSearchField
        id="backlog-filter-q"
        label={t("backlog:filters.search")}
        placeholder={t("backlog:filters.searchPlaceholder")}
        value={value.q}
        onChange={(q) => onChange({ q })}
      />

      <FilterSelect
        id="backlog-filter-project"
        label={t("backlog:filters.project")}
        value={value.projectId}
        options={projects.map((project) => ({ value: project.id, label: project.name }))}
        onChange={(projectId) => onChange({ projectId })}
      />
      {/*
        Stato: l'opzione vuota è "Attivi (default)" (il server nasconde
        converted/archived quando status è assente), poi i singoli stati
        (converted/archived inclusi, da scegliere esplicitamente).
      */}
      <FilterSelect
        id="backlog-filter-status"
        label={t("backlog:filters.status")}
        emptyLabel={t("backlog:filters.statusActive")}
        value={value.status}
        options={backlogItemStatusSchema.options.map((status) => ({
          value: status,
          label: t(BACKLOG_STATUS_LABEL_KEYS[status]),
        }))}
        onChange={(status) => onChange({ status: status as BacklogItemStatus | undefined })}
      />
      <FilterSelect
        id="backlog-filter-urgency"
        label={t("backlog:filters.urgency")}
        emptyLabel={t("backlog:filters.all")}
        value={value.urgency}
        options={ticketPrioritySchema.options.map((urgency) => ({
          value: urgency,
          label: t(PRIORITY_LABEL_KEYS[urgency]),
        }))}
        onChange={(urgency) => onChange({ urgency: urgency as TicketPriority | undefined })}
      />
      <FilterSelect
        id="backlog-filter-risk"
        label={t("backlog:filters.risk")}
        emptyLabel={t("backlog:filters.all")}
        value={value.risk}
        options={backlogRiskSchema.options.map((risk) => ({
          value: risk,
          label: t(BACKLOG_RISK_LABEL_KEYS[risk]),
        }))}
        onChange={(risk) => onChange({ risk: risk as BacklogRisk | undefined })}
      />
    </div>
  );
}

interface BacklogCardProps {
  item: BacklogItem;
  /** Nome del progetto risolto dal chiamante (la lista ha già i progetti). */
  projectName: string;
}

/**
 * Card di una voce del backlog: tutta cliccabile verso il dettaglio
 * `/backlog/$id` con un {@link Link} tipato (nav SPA, prefetch on intent).
 */
function BacklogCard({ item, projectName }: BacklogCardProps) {
  const { t } = useTranslation();

  return (
    <Link
      to="/backlog/$id"
      params={{ id: item.id }}
      className="group grid grid-cols-1 items-center gap-x-4 gap-y-1 border-b border-line px-4 py-3 transition-colors last:border-b-0 hover:bg-ink-850 sm:grid-cols-[minmax(0,1fr)_auto]"
    >
      <span className="min-w-0">
        <span className="block truncate text-sm font-medium text-fg transition-colors group-hover:text-signal">
          {item.title}
        </span>
        <span className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 font-mono text-[11px] text-fg-faint">
          <span className="text-fg-muted">{projectName}</span>
          {item.requestCount > 1 && (
            // Il significato "richiesto N volte" non può vivere solo nel title
            // (span non focusabile, invisibile agli screen reader): aria-label
            // con la stessa stringa i18n.
            <span
              className="text-signal"
              title={t("backlog:card.requestCount", { count: item.requestCount })}
              aria-label={t("backlog:card.requestCount", { count: item.requestCount })}
            >
              ×{item.requestCount}
            </span>
          )}
          {item.ticketCount > 0 && (
            <span
              className="rounded-sm border border-line bg-ink-850 px-1.5 text-fg-muted"
              title={t("backlog:card.ticketCount", { count: item.ticketCount })}
            >
              {t("backlog:card.ticketCount", { count: item.ticketCount })}
            </span>
          )}
          {item.similarTo && (
            // `min-w-0` + `truncate` su una pill dentro un flex-wrap: senza il
            // min-w-0 la pill non si accorcerebbe (contenuto flex intrinsecamente
            // min-content) e traboccherebbe oltre la card su titoli lunghi.
            <span
              className="min-w-0 max-w-[16rem] truncate text-fg-muted"
              title={t("backlog:card.similarTo", { title: item.similarTo.title })}
            >
              {t("backlog:card.similarTo", { title: item.similarTo.title })}
            </span>
          )}
        </span>
      </span>

      <span className="flex flex-wrap items-center gap-3 sm:justify-end">
        {item.effort !== null && <BacklogEffortBadge effort={item.effort} />}
        {item.risk !== null && <BacklogRiskBadge risk={item.risk} />}
        {item.urgency !== null && <PriorityBadge priority={item.urgency} />}
        <BacklogStatusBadge status={item.status} />
        <time
          dateTime={item.updatedAt}
          title={item.updatedAt}
          className="w-16 text-right font-mono text-[11px] text-fg-faint"
        >
          {formatRelativeTime(item.updatedAt)}
        </time>
      </span>
    </Link>
  );
}
