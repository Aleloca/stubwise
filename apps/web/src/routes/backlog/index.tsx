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
import { getRouteApi } from "@tanstack/react-router";
import { useEffect, useRef, useState, type FormEvent } from "react";
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
import { FormError, SelectField, TextField } from "../../components/field";
import { MarkdownEditor } from "../../components/markdown-editor";
import { FilterSelect, labelClass } from "../../components/ticket-filters";
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

/**
 * Lista del backlog di discovery. Come /tickets: i filtri vivono interamente
 * nell'URL, ogni modifica naviga (replace) e il loader della route ha già messo
 * in cache la prima pagina per quei filtri. La creazione manuale non produce
 * subito una voce (il worker la elabora in modo asincrono): il POST 202 mostra
 * un banner "in elaborazione" e invalida la lista.
 */
export function BacklogPage() {
  const { t } = useTranslation();
  const search = route.useSearch();
  const navigate = route.useNavigate();
  const queryClient = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [queued, setQueued] = useState(false);

  const { data: projects } = useSuspenseQuery(projectsQueryOptions);
  const { data, fetchNextPage, hasNextPage, isFetchingNextPage } = useSuspenseInfiniteQuery(
    backlogInfiniteQueryOptions(search),
  );

  const items = data.pages.flatMap((page) => page.items);
  const projectNames = new Map(projects.map((project) => [project.id, project.name]));

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
    // secondi/minuti. Segnaliamo l'attesa e invalidiamo la lista così, quando
    // la voce comparirà, un rientro/refetch la mostrerà.
    setQueued(true);
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

      {queued && (
        <div
          role="status"
          className="mt-4 flex items-center justify-between gap-4 rounded-sm border border-signal-dim/40 bg-ink-900 px-4 py-3"
        >
          <p className="text-sm text-fg-muted">{t("backlog:list.processing")}</p>
          <button
            type="button"
            onClick={() => setQueued(false)}
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

const SEARCH_DEBOUNCE_MS = 300;

interface BacklogFilterBarProps {
  value: BacklogSearch;
  projects: Project[];
  onChange: (patch: Partial<BacklogSearch>) => void;
}

/**
 * Barra dei filtri del backlog. Componente puro: lo stato vive nell'URL, qui
 * arrivano `value` e si emettono patch via `onChange`. La ricerca è debounced
 * per non riscrivere l'URL a ogni tasto (stesso pattern di {@link TicketFilters}).
 */
function BacklogFilterBar({ value, projects, onChange }: BacklogFilterBarProps) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState(value.q ?? "");
  const timerRef = useRef<ReturnType<typeof setTimeout>>();

  // Se q cambia da fuori (back/forward, link condiviso) il campo si allinea.
  useEffect(() => {
    setDraft(value.q ?? "");
  }, [value.q]);

  useEffect(() => () => clearTimeout(timerRef.current), []);

  function handleSearch(next: string) {
    setDraft(next);
    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      onChange({ q: next.trim() || undefined });
    }, SEARCH_DEBOUNCE_MS);
  }

  return (
    <div className="flex flex-wrap items-end gap-3">
      <div className="flex min-w-56 flex-1 flex-col gap-1">
        <label htmlFor="backlog-filter-q" className={labelClass}>
          {t("backlog:filters.search")}
        </label>
        <input
          id="backlog-filter-q"
          type="search"
          value={draft}
          onChange={(event) => handleSearch(event.target.value)}
          placeholder={t("backlog:filters.searchPlaceholder")}
          className="rounded-sm border border-line-strong bg-ink-950/70 px-3 py-1.5 text-sm text-fg placeholder:text-fg-faint transition-colors hover:border-ink-700 focus-visible:border-signal-dim"
        />
      </div>

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
 * `/backlog/$id`. Quella route non esiste ancora (arriva nel Task 20): si usa
 * un'ancora `<a href>` col path letterale — typecheck-safe senza la route
 * registrata; il Task 20 la convertirà in un `<Link>` tipato per la nav SPA.
 */
function BacklogCard({ item, projectName }: BacklogCardProps) {
  const { t } = useTranslation();

  return (
    <a
      href={`/backlog/${item.id}`}
      className="group grid grid-cols-1 items-center gap-x-4 gap-y-1 border-b border-line px-4 py-3 transition-colors last:border-b-0 hover:bg-ink-850 sm:grid-cols-[minmax(0,1fr)_auto]"
    >
      <span className="min-w-0">
        <span className="block truncate text-sm font-medium text-fg transition-colors group-hover:text-signal">
          {item.title}
        </span>
        <span className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 font-mono text-[11px] text-fg-faint">
          <span className="text-fg-muted">{projectName}</span>
          {item.requestCount > 1 && (
            <span
              className="text-signal"
              title={t("backlog:card.requestCount", { count: item.requestCount })}
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
            <span
              className="truncate text-fg-muted"
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
    </a>
  );
}

interface NewBacklogItemDialogProps {
  /** Progetti (gruppi) disponibili: il primo è preselezionato. */
  projects: Project[];
  /** Accoda la voce; il rigetto mostra l'errore e lascia il dialog aperto. */
  onSubmit: (input: { projectId: string; title: string; body: string }) => Promise<void>;
  onClose: () => void;
}

/**
 * Dialog di creazione manuale di una voce del backlog (pattern
 * {@link NewTicketDialog}). Titolo e descrizione sono entrambi obbligatori: il
 * server accoda un job `intake` che dedup-a e suggerisce i metadati, quindi
 * serve un corpo da elaborare. Escape o Annulla per chiudere.
 */
function NewBacklogItemDialog({ projects, onSubmit, onClose }: NewBacklogItemDialogProps) {
  const { t } = useTranslation();
  const [projectId, setProjectId] = useState(projects[0]?.id ?? "");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const canSubmit = title.trim() !== "" && body.trim() !== "" && projectId !== "";

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (!canSubmit) return;
    setError(null);
    setPending(true);
    try {
      await onSubmit({ projectId, title: title.trim(), body: body.trim() });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("common:unexpectedError"));
    } finally {
      setPending(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center overflow-y-auto bg-ink-950/80 p-3 backdrop-blur-[2px] sm:p-6"
      onKeyDown={(event) => {
        if (event.key === "Escape") onClose();
      }}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="new-backlog-title"
        className="w-full max-w-lg border border-line bg-ink-900 shadow-[0_24px_60px_-24px_rgba(0,0,0,0.9)]"
      >
        <header className="flex items-baseline justify-between border-b border-line px-5 py-4">
          <h2 id="new-backlog-title" className="text-lg font-semibold">
            {t("backlog:newDialog.title")}
          </h2>
          <span className="font-mono text-[10px] tracking-[0.18em] text-fg-faint uppercase">
            {t("backlog:newDialog.badge")}
          </span>
        </header>

        <form
          onSubmit={(event) => void handleSubmit(event)}
          className="flex flex-col gap-4 px-5 py-5"
          noValidate
        >
          <TextField
            id="backlog-title"
            label={t("backlog:newDialog.itemTitle")}
            required
            autoFocus
            placeholder={t("backlog:newDialog.titlePlaceholder")}
            value={title}
            onChange={(event) => setTitle(event.target.value)}
          />

          <SelectField
            id="backlog-project"
            label={t("backlog:newDialog.project")}
            required
            value={projectId}
            onChange={(event) => setProjectId(event.target.value)}
            options={projects.map((project) => ({ value: project.id, label: project.name }))}
          />

          <div className="flex flex-col gap-1.5">
            <label
              htmlFor="backlog-body"
              className="font-mono text-[11px] font-medium tracking-[0.14em] text-fg-muted uppercase"
            >
              {t("backlog:newDialog.description")}
            </label>
            <MarkdownEditor
              id="backlog-body"
              value={body}
              onChange={setBody}
              placeholder={t("backlog:newDialog.descriptionPlaceholder")}
            />
          </div>

          <FormError message={error} />

          <div className="mt-1 flex items-center justify-end gap-3">
            <button
              type="button"
              onClick={onClose}
              className="rounded-sm border border-line-strong px-3 py-2 font-mono text-[12px] tracking-[0.08em] text-fg-muted uppercase transition-colors hover:border-ink-700 hover:text-fg"
            >
              {t("backlog:newDialog.cancel")}
            </button>
            <button
              type="submit"
              disabled={pending || !canSubmit}
              className="rounded-sm bg-signal px-4 py-2 font-mono text-[12px] font-semibold tracking-[0.08em] text-ink-950 uppercase transition-colors hover:bg-signal-bright active:bg-signal-dim disabled:cursor-not-allowed disabled:bg-signal-dim disabled:opacity-60"
            >
              {pending ? t("backlog:newDialog.submitPending") : t("backlog:newDialog.submit")}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
