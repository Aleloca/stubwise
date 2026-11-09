import { Link, useNavigate, useRouter, useRouterState, useSearch } from "@tanstack/react-router";
import {
  Fragment,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
  type Ref,
} from "react";
import { useTranslation } from "react-i18next";
import {
  useChatChannels,
  useChatSearch,
  useCitations,
  usePeople,
  useProjects,
  useReachChatMessage,
  useSessionPersonId,
} from "../../data/queries";
import type {
  ChannelRow,
  ChatMessageHit,
  ChatMessageView,
  CitationRef,
  Person,
  Project,
} from "../../data/types";
import { formatDate, formatDateTime } from "../../notifications/time";
import { hasModKey, shortcutLabel } from "../../platform/platform";
import { Chip, Cross } from "../../tasks-ui/FilterBar";
import { CheckItem, MenuGroup, MenuNote, RadioItem } from "../../tasks-ui/Menu";
import { PageEmpty, PageError } from "../../tasks-ui/PageStates";
import { useToast } from "../../tasks-ui/Toast";
import {
  CitationProvider,
  HiddenCode,
  indexCitations,
  refKey,
  useCitationIndex,
  withRecordedCode,
} from "../claude/conversation/citations";
import { FileGlyph } from "../claude/conversation/parts";
import { rowLabel } from "./ChatPage";
import { clearRecentSearches, lastChannelOf, recentSearchesOf, rememberSearch } from "./column";
import { ChatAvatar } from "./MessageItem";
import {
  DATE_RANGES,
  MIN_QUERY,
  SEARCH_PARAM_KEYS,
  dateRangeOf,
  filtersOf,
  groupByChannel,
  hasFilters,
  highlightParts,
  plainText,
  rememberResults,
  resultsFor,
  searchWords,
  takeSelectedResult,
  type ChatSearchParams,
  type DateRange,
} from "./search";

// La ricerca della Chat (shape chat-search.md): una pagina di risultati
// nell'area di lavoro, con la colonna intatta. In testa il campo grande al
// posto dell'h1 e la barra dei filtri (In, From, Date, tre interruttori);
// sotto i risultati per canale, frammenti del flusso con la riga di
// contesto sbiadita sopra e le parole trovate evidenziate in inchiostro. Il
// clic porta al messaggio evidenziato (nel thread, se è una risposta).
// Cosa si cerca lo decide solo `searchChat`: qui niente filtra per
// visibilità, e un filtro «In» su un canale che non si legge risponde come
// un canale che non esiste (R-G5).

/** Quanti risultati per canale prima di «Show N more». */
const PER_GROUP = 3;
/** Quanti canali alla volta. */
const GROUPS_PAGE = 20;
/** Attesa dopo l'ultimo tasto prima di aggiornare la ricerca. */
const TYPE_DEBOUNCE_MS = 200;

type SearchState = ChatSearchParams & { view?: string };

/** I parametri della ricerca, presi dall'indirizzo. */
function useSearchParams(): ChatSearchParams {
  const raw = useSearch({ strict: false }) as SearchState;
  return useMemo(() => {
    const out: ChatSearchParams = {};
    for (const key of SEARCH_PARAM_KEYS) {
      const value = raw[key];
      if (typeof value === "string") (out as Record<string, string>)[key] = value;
    }
    return out;
    // Le chiavi una per una: l'oggetto della ricerca cambia a ogni navigazione.
  }, [raw.q, raw.in, raw.by, raw.when, raw.since, raw.until, raw.att, raw.cit, raw.ppl]);
}

/** Va alla ricerca con questi parametri (sostituendo la voce di cronologia mentre si scrive). */
function useGoSearch() {
  const navigate = useNavigate();
  return (params: ChatSearchParams, replace = false) =>
    void navigate({
      to: "/chat",
      search: { view: "search", ...clean(params) },
      replace,
    } as never);
}

const clean = (p: ChatSearchParams): ChatSearchParams =>
  Object.fromEntries(
    Object.entries(p).filter(([, v]) => v !== undefined && v !== ""),
  ) as ChatSearchParams;

// --- la pagina ------------------------------------------------------------------

/**
 * Cambiare persona svuota la pagina, query compresa, e cancella le ricerche
 * recenti di chi guardava (restano solo sul dispositivo, di una persona).
 */
export function ChatSearch() {
  const me = useSessionPersonId();
  const goSearch = useGoSearch();
  const params = useSearchParams();
  // Dal cambio di persona finché l'indirizzo non è svuotato: la pagina
  // della persona nuova parte vuota, senza cercare la query di prima.
  const [viewer, setViewer] = useState(me);
  const [resetting, setResetting] = useState(false);
  if (viewer !== me) {
    setViewer(me);
    setResetting(true);
  }
  useEffect(() => {
    if (!resetting) return;
    clearRecentSearches();
    goSearch({}, true);
  }, [resetting]);
  const empty = !params.q && !hasFilters(params);
  useEffect(() => {
    if (resetting && empty) setResetting(false);
  }, [resetting, empty]);
  return <SearchPage key={me} params={resetting ? NO_PARAMS : params} />;
}

const NO_PARAMS: ChatSearchParams = {};

function SearchPage({ params }: { params: ChatSearchParams }) {
  const { t } = useTranslation();
  const me = useSessionPersonId();
  const goSearch = useGoSearch();
  const navigate = useNavigate();
  const href = useRouterState({ select: (s) => s.location.href });
  const q = (params.q ?? "").trim();
  const filters = useMemo(() => filtersOf(params), [params]);
  const search = useChatSearch(q, filters);
  const rows = useChatChannels().data;
  const projects = useProjects().data;
  const people = usePeople().data;
  const reach = useReachChatMessage();
  const toast = useToast();

  // Il campo: scrive l'indirizzo poco dopo l'ultimo tasto; un `q` arrivato da
  // fuori (colonna, ricerca recente, ritorno) lo riallinea.
  const [draft, setDraft] = useState(params.q ?? "");
  const committed = useRef(params.q ?? "");
  useEffect(() => {
    const incoming = params.q ?? "";
    if (incoming !== committed.current) {
      committed.current = incoming;
      setDraft(incoming);
    }
  }, [params.q]);
  useEffect(() => {
    if (draft === committed.current) return;
    const id = window.setTimeout(() => {
      committed.current = draft;
      goSearch({ ...params, q: draft || undefined }, true);
    }, TYPE_DEBOUNCE_MS);
    return () => window.clearTimeout(id);
  }, [draft]);

  const words = useMemo(() => searchWords(q), [q]);
  const hits = q.length >= MIN_QUERY ? search.data : undefined;
  const groups = useMemo(() => groupByChannel(hits ?? []), [hits]);
  const [shownGroups, setShownGroups] = useState(GROUPS_PAGE);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const visibleGroups = groups.slice(0, shownGroups);
  const order = useMemo(
    () =>
      visibleGroups.flatMap((g) =>
        expanded.has(g.channelId) ? g.hits : g.hits.slice(0, PER_GROUP),
      ),
    [visibleGroups, expanded],
  );

  // Il risultato selezionato: il primo, o quello da cui si era partiti tornando.
  const [selected, setSelected] = useState<string | null>(() => takeSelectedResult(me, href));
  const restoring = useRef(selected !== null);
  const current = order.find((h) => h.message.id === selected) ?? order[0];
  const list = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!restoring.current || !current || current.message.id !== selected) return;
    restoring.current = false;
    focusResult(current.message.id);
  }, [current, selected]);

  // Le citazioni dei risultati, lette una volta per chi guarda (R-E9).
  const refs = useMemo(() => {
    const seen = new Map<string, CitationRef>();
    for (const h of order) for (const ref of h.message.citations) seen.set(refKey(ref), ref);
    return [...seen.values()];
  }, [order]);
  const citations = useCitations(refs);
  const index = useMemo(() => indexCitations(citations.data), [citations.data]);

  function focusResult(id: string) {
    list.current
      ?.querySelector<HTMLElement>(`[data-result="${CSS.escape(id)}"]`)
      ?.focus({ preventScroll: false });
  }

  async function open(hit: ChatMessageHit) {
    const found = await reach(hit.message.id);
    if (!found) {
      toast.error(t("chat.search.unavailable"));
      return;
    }
    rememberSearch(me, q);
    rememberResults({ personId: me, messageId: hit.message.id, href, selected: hit.message.id });
    const m = found.message;
    void navigate({
      to: "/chat/$channelId",
      params: { channelId: found.channelId },
      search: m.threadOf ? { thread: m.threadOf, message: m.id } : { message: m.id },
    } as never);
  }

  function move(step: number) {
    if (order.length === 0) return;
    const at = current ? order.indexOf(current) : -1;
    const next = order[Math.min(order.length - 1, Math.max(0, at + step))]!;
    setSelected(next.message.id);
    focusResult(next.message.id);
  }

  const onResultsKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.altKey || hasModKey(e)) return;
    if (e.key === "j" || e.key === "ArrowDown") {
      e.preventDefault();
      move(1);
    } else if (e.key === "k" || e.key === "ArrowUp") {
      e.preventDefault();
      if (current === order[0]) field.current?.focus();
      else move(-1);
    } else if (e.key === "/") {
      e.preventDefault();
      field.current?.focus();
    }
  };

  const onFieldKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown" && current) {
      e.preventDefault();
      setSelected(current.message.id);
      focusResult(current.message.id);
    } else if (e.key === "Enter") {
      e.preventDefault();
      // I risultati sono di questa query: Enter apre il selezionato; se no la cerca adesso.
      if (draft.trim() === q && current && !search.isPlaceholderData) void open(current);
      else {
        committed.current = draft;
        goSearch({ ...params, q: draft || undefined }, true);
        rememberSearch(me, draft);
      }
    } else if (e.key === "Escape" && draft === "") {
      e.preventDefault();
      const last = lastChannelOf(me);
      void navigate(
        (last ? { to: "/chat/$channelId", params: { channelId: last } } : { to: "/chat" }) as never,
      );
    }
  };

  const total = hits?.length ?? 0;
  const label = (row: ChannelRow | undefined) => (row ? rowLabel(row, me, projects, people) : null);
  const signature = `${q}|${JSON.stringify(filters)}`;

  return (
    <section className="@container flex min-h-full flex-col" aria-labelledby="chat-search-title">
      <header className="page-header border-b border-rule pb-3 pl-8 [--page-header-pr:32px] [--page-header-pt:24px] @max-[620px]:pl-4">
        {/* Larga quanto i risultati: campo, filtri e gruppi finiscono sulla stessa linea. */}
        <div className="flex max-w-[812px] flex-col gap-3">
          <h1 id="chat-search-title" className="sr-only">
            {t("chat.search.title")}
          </h1>
          <SearchField
            ref={field}
            value={draft}
            onChange={setDraft}
            onKeyDown={onFieldKey}
            onClear={() => {
              setDraft("");
              committed.current = "";
              goSearch({ ...params, q: undefined }, true);
              field.current?.focus();
            }}
          />
          <FilterRow params={params} rows={rows} projects={projects} people={people} />
          <p className="num min-h-[18px] text-sm text-ink-muted" aria-live="polite">
            {hits && total > 0
              ? t("chat.search.summary", {
                  messages: t("chat.search.messages", { count: total }),
                  channels: t("chat.search.channels", { count: groups.length }),
                })
              : ""}
          </p>
        </div>
      </header>

      <div className="max-w-[860px] px-4 pb-10">
        {q.length === 0 ? (
          <RecentSearches onPick={(text) => goSearch({ ...params, q: text })} />
        ) : q.length < MIN_QUERY ? (
          <p className="px-4 py-10 text-md text-ink-muted">{t("chat.search.minChars")}</p>
        ) : search.isError ? (
          <PageError message={t("chat.search.error")} onRetry={() => void search.refetch()} />
        ) : !hits ? (
          <ResultsSkeleton />
        ) : hits.length === 0 ? (
          <PageEmpty
            title={t("chat.search.noResults", { query: q })}
            body={
              hasFilters(params)
                ? t("chat.search.noResultsFiltered")
                : t("chat.search.noResultsHint")
            }
            action={
              hasFilters(params) ? (
                <button
                  type="button"
                  onClick={() => goSearch({ q: params.q })}
                  className="inline-flex h-8 items-center rounded-md border border-rule-strong px-3 text-sm font-medium text-ink transition-colors duration-[var(--duration-fast)] ease-out hover:bg-ink/6"
                >
                  {t("chat.search.clearFilters")}
                </button>
              ) : undefined
            }
          />
        ) : (
          <CitationProvider value={index}>
            <div
              key={signature}
              ref={list}
              role="region"
              aria-label={t("chat.search.results")}
              aria-busy={search.isPlaceholderData}
              onKeyDown={onResultsKey}
              data-search-results
              className={`event-enter flex flex-col gap-4 pt-3 transition-opacity duration-[var(--duration-fast)] ${search.isPlaceholderData ? "opacity-60" : ""}`}
            >
              {visibleGroups.map((group) => {
                const row = rows?.find((r) => r.id === group.channelId);
                const name = label(row) ?? {
                  code: null,
                  name: t("chat.search.unknownChannel"),
                  label: t("chat.search.unknownChannel"),
                };
                const open_ = expanded.has(group.channelId);
                const shown = open_ ? group.hits : group.hits.slice(0, PER_GROUP);
                const more = group.hits.length - shown.length;
                return (
                  <section
                    key={group.channelId}
                    aria-label={name?.label}
                    data-result-group={group.channelId}
                  >
                    <h2 className="flex h-7 min-w-0 items-center gap-2 border-b border-rule px-4 text-sm">
                      <span className="min-w-0 truncate" title={name?.label}>
                        {name?.code && (
                          <span className="num font-semibold text-ink">
                            {name.prefix}
                          </span>
                        )}
                        <span className="text-ink-muted">{name?.name}</span>
                      </span>
                      {row?.archived && (
                        <span className="shrink-0 text-xs text-ink-faint">
                          {t("chat.search.archived")}
                        </span>
                      )}
                      <span className="num ml-auto shrink-0 text-xs text-ink-faint">
                        {group.hits.length}
                      </span>
                    </h2>
                    <ul className="flex flex-col pt-1">
                      {shown.map((hit) => (
                        <li key={hit.message.id}>
                          <Result
                            hit={hit}
                            words={words}
                            people={people}
                            channelLabel={name?.label ?? ""}
                            selected={hit === current}
                            onSelect={() => setSelected(hit.message.id)}
                            onOpen={() => void open(hit)}
                          />
                        </li>
                      ))}
                    </ul>
                    {more > 0 && (
                      <button
                        type="button"
                        onClick={() => setExpanded((prev) => new Set(prev).add(group.channelId))}
                        className="mt-0.5 ml-[44px] inline-flex h-7 items-center rounded-md px-2 text-sm text-ink-muted transition-colors duration-[var(--duration-fast)] ease-out hover:bg-ink/6 hover:text-ink"
                      >
                        {t("chat.search.showMore", { count: more, name: name?.label ?? "" })}
                      </button>
                    )}
                  </section>
                );
              })}
              {groups.length > shownGroups && (
                <MoreGroups onMore={() => setShownGroups((n) => n + GROUPS_PAGE)} />
              )}
            </div>
          </CitationProvider>
        )}
      </div>
    </section>
  );
}

/** Altri canali: da soli quando la coda entra in vista, o col bottone. */
function MoreGroups({ onMore }: { onMore: () => void }) {
  const { t } = useTranslation();
  const ref = useRef<HTMLButtonElement>(null);
  const latest = useRef(onMore);
  latest.current = onMore;
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) latest.current();
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return (
    <button
      ref={ref}
      type="button"
      onClick={onMore}
      className="self-start rounded-md px-4 py-2 text-sm text-ink-muted hover:bg-ink/6 hover:text-ink"
    >
      {t("chat.search.moreChannels")}
    </button>
  );
}

function ResultsSkeleton() {
  const { t } = useTranslation();
  return (
    <div aria-busy="true" className="skeleton-breathe flex flex-col gap-6 px-4 pt-4">
      <span role="status" className="sr-only">
        {t("chat.search.loading")}
      </span>
      {[0, 1, 2].map((g) => (
        <span key={g} className="flex flex-col gap-3">
          <span className="h-3.5 w-40 rounded bg-ink/8" />
          {[0, 1].map((r) => (
            <span key={r} className="flex gap-3">
              <span className="size-6 shrink-0 rounded-full bg-ink/8" />
              <span className="flex flex-1 flex-col gap-2">
                <span className="h-3 w-48 rounded bg-ink/8" />
                <span
                  className="h-3 rounded bg-ink/6"
                  style={{ width: `${50 + (((g * 3 + r) * 13) % 40)}%` }}
                />
              </span>
            </span>
          ))}
        </span>
      ))}
    </div>
  );
}

/** Le ultime ricerche di chi guarda (solo su questo dispositivo), con «Clear». */
function RecentSearches({ onPick }: { onPick: (q: string) => void }) {
  const { t } = useTranslation();
  const me = useSessionPersonId();
  const [items, setItems] = useState(() => recentSearchesOf(me));
  if (items.length === 0) {
    return <PageEmpty title={t("chat.search.emptyTitle")} body={t("chat.search.emptyBody")} />;
  }
  return (
    <section aria-labelledby="chat-recent" className="flex max-w-[560px] flex-col pt-4">
      <div className="flex items-center justify-between px-4 pb-1.5">
        <h2 id="chat-recent" className="heading-group">
          {t("chat.search.recent")}
        </h2>
        <button
          type="button"
          onClick={() => {
            clearRecentSearches();
            setItems([]);
          }}
          className="rounded-md px-2 py-0.5 text-sm text-ink-muted hover:bg-ink/6 hover:text-ink"
        >
          {t("chat.search.clearRecent")}
        </button>
      </div>
      <ul className="flex flex-col">
        {items.map((q) => (
          <li key={q}>
            <button
              type="button"
              onClick={() => onPick(q)}
              data-recent-search={q}
              className="flex h-8 w-full min-w-0 items-center gap-2.5 rounded-md px-4 text-left text-md text-ink transition-colors duration-[var(--duration-fast)] ease-out hover:bg-ink/6"
            >
              <span className="text-ink-faint">
                <SearchGlyph />
              </span>
              <span className="min-w-0 truncate">{q}</span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

// --- il campo ---------------------------------------------------------------------

export function SearchGlyph({ size = 14 }: { size?: number }) {
  return (
    <svg
      viewBox="0 0 16 16"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      aria-hidden="true"
      focusable="false"
      className="shrink-0"
    >
      <circle cx="7" cy="7" r="4.25" />
      <path d="m10.25 10.25 3 3" />
    </svg>
  );
}

function SearchField({
  ref,
  value,
  onChange,
  onKeyDown,
  onClear,
}: {
  ref: Ref<HTMLInputElement>;
  value: string;
  onChange: (v: string) => void;
  onKeyDown: (e: KeyboardEvent<HTMLInputElement>) => void;
  onClear: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="relative flex h-10 min-w-0 items-center rounded-lg border border-rule-strong bg-surface focus-within:border-ink/40">
      <span className="pointer-events-none pl-3 text-ink-muted">
        <SearchGlyph size={16} />
      </span>
      <input
        ref={ref}
        type="search"
        // La pagina apre col fuoco nel campo (⌘F lo riporta qui).
        autoFocus
        data-chat-search="page"
        aria-label={t("chat.search.title")}
        placeholder={t("chat.search.placeholder")}
        spellCheck={false}
        autoComplete="off"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKeyDown}
        className="h-full min-w-0 flex-1 bg-transparent px-2.5 text-lg text-ink outline-none placeholder:text-ink-faint focus-visible:outline-none [&::-webkit-search-cancel-button]:hidden"
      />
      {value && (
        <button
          type="button"
          onClick={onClear}
          aria-label={t("chat.search.clear")}
          title={t("chat.search.clear")}
          className="mr-1.5 grid size-7 place-items-center rounded-md text-ink-muted hover:bg-ink/6 hover:text-ink"
        >
          <Cross />
        </button>
      )}
    </div>
  );
}

// --- i filtri ---------------------------------------------------------------------

type Open = "in" | "from" | "date" | "more" | null;

function FilterRow({
  params,
  rows,
  projects,
  people,
}: {
  params: ChatSearchParams;
  rows: ChannelRow[] | undefined;
  projects: Project[] | undefined;
  people: Person[] | undefined;
}) {
  const { t, i18n } = useTranslation();
  const me = useSessionPersonId();
  const goSearch = useGoSearch();
  const [open, setOpen] = useState<Open>(null);
  const set = (patch: ChatSearchParams) => goSearch({ ...params, ...patch }, true);
  const toggle = (key: "att" | "cit" | "ppl") => set({ [key]: params[key] ? undefined : "1" });

  // «In»: solo un canale che si legge ha un nome; uno che non si legge e uno
  // che non esiste si dicono allo stesso modo (R-G5).
  const inRow = rows?.find((r) => r.id === params.in && r.canRead);
  const inName = params.in
    ? inRow
      ? rowLabel(inRow, me, projects, people).label
      : t("chat.search.unknownChannel")
    : null;
  const byPerson = people?.find((p) => p.id === params.by);
  const byName = params.by ? (byPerson?.name ?? t("chat.search.unknownPerson")) : null;
  const range = dateRangeOf(params);
  const dateName = params.when
    ? params.when === "custom"
      ? t("chat.search.customRange", {
          from: range.from ? formatDate(range.from, i18n.language) : t("chat.search.anyDay"),
          to: range.to ? formatDate(range.to, i18n.language) : t("chat.search.anyDay"),
        })
      : t(`chat.search.${DATE_LABEL[params.when]}`)
    : null;
  const toggles = [
    { key: "att" as const, label: t("chat.search.withAttachments") },
    { key: "cit" as const, label: t("chat.search.withCitations") },
    { key: "ppl" as const, label: t("chat.search.peopleOnly") },
  ];
  const moreCount = toggles.filter((x) => params[x.key]).length;

  return (
    <div
      role="group"
      aria-label={t("chat.search.filters")}
      className="flex min-w-0 flex-wrap items-center gap-2"
    >
      <Chip
        name={t("chat.search.in")}
        summary={inName}
        open={open === "in"}
        onOpenChange={(o) => setOpen(o ? "in" : null)}
        onRemove={() => set({ in: undefined })}
      >
        <ChannelMenu
          rows={rows}
          projects={projects}
          people={people}
          value={params.in}
          onPick={(id) => {
            set({ in: id });
            setOpen(null);
          }}
        />
      </Chip>
      <Chip
        name={t("chat.search.from")}
        summary={byName}
        open={open === "from"}
        onOpenChange={(o) => setOpen(o ? "from" : null)}
        onRemove={() => set({ by: undefined })}
      >
        <PersonMenu
          people={people}
          value={params.by}
          onPick={(id) => {
            set({ by: id });
            setOpen(null);
          }}
        />
      </Chip>
      <Chip
        name={t("chat.search.date")}
        summary={dateName}
        open={open === "date"}
        onOpenChange={(o) => setOpen(o ? "date" : null)}
        onRemove={() => set({ when: undefined, since: undefined, until: undefined })}
      >
        <MenuGroup>
          <RadioItem
            checked={!params.when}
            onSelect={() => {
              set({ when: undefined, since: undefined, until: undefined });
              setOpen(null);
            }}
          >
            {t("chat.search.anyTime")}
          </RadioItem>
          {DATE_RANGES.map((r) => (
            <RadioItem
              key={r}
              checked={params.when === r}
              onSelect={() => {
                set(r === "custom" ? { when: r } : { when: r, since: undefined, until: undefined });
                setOpen(null);
              }}
            >
              {t(`chat.search.${DATE_LABEL[r]}`)}
            </RadioItem>
          ))}
        </MenuGroup>
      </Chip>
      {params.when === "custom" && (
        <span className="flex items-center gap-1.5 text-sm text-ink-muted">
          <label className="flex items-center gap-1.5">
            {t("chat.search.since")}
            <input
              type="date"
              value={params.since ?? ""}
              max={params.until}
              onChange={(e) => set({ since: e.target.value || undefined })}
              className="h-7 rounded-md border border-rule px-1.5 text-sm text-ink [color-scheme:light_dark]"
            />
          </label>
          <label className="flex items-center gap-1.5">
            {t("chat.search.until")}
            <input
              type="date"
              value={params.until ?? ""}
              min={params.since}
              onChange={(e) => set({ until: e.target.value || undefined })}
              className="h-7 rounded-md border border-rule px-1.5 text-sm text-ink [color-scheme:light_dark]"
            />
          </label>
        </span>
      )}
      {/* Largo: tre interruttori; stretto (1024px): in «More filters». */}
      <span className="flex items-center gap-2 @max-[760px]:hidden">
        {toggles.map((x) => (
          <Toggle key={x.key} pressed={!!params[x.key]} onToggle={() => toggle(x.key)}>
            {x.label}
          </Toggle>
        ))}
      </span>
      <span className="hidden @max-[760px]:block">
        <Chip
          name={t("chat.search.moreFilters")}
          summary={moreCount > 0 ? String(moreCount) : null}
          open={open === "more"}
          onOpenChange={(o) => setOpen(o ? "more" : null)}
        >
          <MenuGroup>
            {toggles.map((x) => (
              <CheckItem key={x.key} checked={!!params[x.key]} onToggle={() => toggle(x.key)}>
                {x.label}
              </CheckItem>
            ))}
          </MenuGroup>
        </Chip>
      </span>
      {hasFilters(params) && (
        <button
          type="button"
          onClick={() => goSearch({ q: params.q }, true)}
          className="ml-auto h-7 rounded-md px-2 text-sm text-ink-muted transition-colors duration-[var(--duration-fast)] ease-out hover:bg-ink/6 hover:text-ink"
        >
          {t("chat.search.clearFilters")}
        </button>
      )}
    </div>
  );
}

const DATE_LABEL: Record<DateRange, string> = {
  today: "today",
  "7d": "last7",
  "30d": "last30",
  custom: "custom",
};

/** Un interruttore della barra: contorno tenue, acceso = contorno forte e inchiostro al 6%. */
function Toggle({
  pressed,
  onToggle,
  children,
}: {
  pressed: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      onClick={onToggle}
      className={`flex h-7 items-center gap-1.5 rounded-md border px-2.5 text-sm whitespace-nowrap transition-colors duration-[var(--duration-fast)] ease-out ${
        pressed
          ? "border-rule-strong bg-ink/6 text-ink"
          : "border-rule text-ink-muted hover:border-rule-strong hover:text-ink"
      }`}
    >
      <span
        aria-hidden="true"
        className={`size-2 shrink-0 rounded-full border ${pressed ? "border-ink bg-ink" : "border-ink-faint"}`}
      />
      {children}
    </button>
  );
}

/** Il campo di ricerca in testa a un menu (fuoco a lui, ↓ scende agli elementi). */
function MenuFind({
  value,
  onChange,
  label,
}: {
  value: string;
  onChange: (v: string) => void;
  label: string;
}) {
  const ref = useRef<HTMLInputElement>(null);
  // Dopo il menu, che mette il fuoco sul primo elemento.
  useEffect(() => ref.current?.focus(), []);
  return (
    <div className="px-0.5 pb-1">
      <input
        ref={ref}
        type="text"
        aria-label={label}
        placeholder={label}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        spellCheck={false}
        autoComplete="off"
        className="h-8 w-full rounded-md border border-rule bg-transparent px-2 text-sm text-ink outline-none placeholder:text-ink-faint focus-visible:border-ink/40"
      />
    </div>
  );
}

/** «In»: i canali che si leggono, raggruppati come la colonna (progetti, azienda, diretti). */
function ChannelMenu({
  rows,
  projects,
  people,
  value,
  onPick,
}: {
  rows: ChannelRow[] | undefined;
  projects: Project[] | undefined;
  people: Person[] | undefined;
  value: string | undefined;
  onPick: (id: string | undefined) => void;
}) {
  const { t } = useTranslation();
  const me = useSessionPersonId();
  const [find, setFind] = useState("");
  const needle = find.trim().toLowerCase();
  const readable = (rows ?? [])
    .filter((r) => r.canRead)
    .map((r) => ({ r, name: rowLabel(r, me, projects, people) }))
    .filter(({ name }) => name.label.toLowerCase().includes(needle));
  const sections = [
    {
      key: "projects",
      label: t("chat.column.channels"),
      items: readable
        .filter(({ r }) => r.kind === "project")
        .sort((a, b) => a.name.label.localeCompare(b.name.label)),
    },
    {
      key: "company",
      label: t("chat.column.company"),
      items: readable
        .filter(({ r }) => r.kind === "general")
        .sort((a, b) => a.name.label.localeCompare(b.name.label)),
    },
    {
      key: "dms",
      label: t("chat.column.direct"),
      items: readable
        .filter(({ r }) => r.kind === "dm")
        .sort((a, b) => a.name.label.localeCompare(b.name.label)),
    },
  ].filter((s) => s.items.length > 0);
  return (
    <div className="flex w-[280px] max-w-full flex-col">
      <MenuFind value={find} onChange={setFind} label={t("chat.search.findChannel")} />
      {!needle && (
        <MenuGroup>
          <RadioItem checked={!value} onSelect={() => onPick(undefined)}>
            {t("chat.search.anyChannel")}
          </RadioItem>
        </MenuGroup>
      )}
      {sections.map((s) => (
        <MenuGroup key={s.key} label={s.label}>
          {s.items.slice(0, 50).map(({ r, name }) => (
            <RadioItem key={r.id} checked={value === r.id} onSelect={() => onPick(r.id)}>
              <span className="min-w-0 truncate" title={name.label}>
                {name.code && (
                  <span className="num font-semibold">
                    {name.prefix}
                  </span>
                )}
                {name.name}
              </span>
              {r.archived && (
                <span className="ml-auto shrink-0 text-xs text-ink-faint">
                  {t("chat.search.archived")}
                </span>
              )}
            </RadioItem>
          ))}
        </MenuGroup>
      ))}
      {sections.length === 0 && (
        <MenuGroup>
          <MenuNote>{t("chat.search.noMatch")}</MenuNote>
        </MenuGroup>
      )}
    </div>
  );
}

/** «From»: chi guarda per primo, poi per nome, Claude in fondo. */
function PersonMenu({
  people,
  value,
  onPick,
}: {
  people: Person[] | undefined;
  value: string | undefined;
  onPick: (id: string | undefined) => void;
}) {
  const { t } = useTranslation();
  const me = useSessionPersonId();
  const [find, setFind] = useState("");
  const needle = find.trim().toLowerCase();
  const rank = (p: Person) => (p.id === me ? 0 : p.isClaude ? 2 : 1);
  const list = (people ?? [])
    .filter((p) => p.name.toLowerCase().includes(needle))
    .sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
  return (
    <div className="flex w-[280px] max-w-full flex-col">
      <MenuFind value={find} onChange={setFind} label={t("chat.search.findPerson")} />
      <MenuGroup>
        {!needle && (
          <RadioItem checked={!value} onSelect={() => onPick(undefined)}>
            {t("chat.search.anyone")}
          </RadioItem>
        )}
        {list.slice(0, 50).map((p) => (
          <RadioItem key={p.id} checked={value === p.id} onSelect={() => onPick(p.id)}>
            <ChatAvatar person={p} size={20} />
            <span className="min-w-0 truncate">{p.name}</span>
          </RadioItem>
        ))}
        {list.length === 0 && <MenuNote>{t("chat.search.noMatch")}</MenuNote>}
      </MenuGroup>
    </div>
  );
}

// --- un risultato -------------------------------------------------------------------

/**
 * Il testo con le parole trovate in `<mark>`: fondo d'inchiostro al 14% e
 * peso 600, mai un colore. Nessun margine orizzontale: una parola trovata a
 * metà («release» in «releases») resta una parola sola, non «release s».
 */
export function Highlighted({ text, words }: { text: string; words: readonly string[] }) {
  return (
    <>
      {highlightParts(text, words).map((part, i) =>
        part.hit ? (
          <mark key={i} data-hit className="rounded-[2px] bg-ink/14 font-semibold text-ink">
            {part.text}
          </mark>
        ) : (
          <Fragment key={i}>{part.text}</Fragment>
        ),
      )}
    </>
  );
}

/**
 * Un oggetto citato, come gettone (codice + nome) che non si apre da qui;
 * R-E9 per chi non lo vede (un file del Drive: il codice registrato, R-H5).
 */
function CitationToken({ refItem }: { refItem: CitationRef }) {
  const index = useCitationIndex();
  const found = index.byRef.get(refKey(refItem));
  const view = found && withRecordedCode(found, refItem);
  if (!view || view.kind === "person") return null;
  if (!view.visible) return view.code ? <HiddenCode code={view.code} /> : null;
  return (
    <span className="inline-flex max-w-[260px] min-w-0 items-baseline gap-1 text-ink-muted">
      {view.code && (
        <span className="num shrink-0 font-semibold tracking-[0.02em] text-ink">{view.code}</span>
      )}
      {view.name && <span className="min-w-0 truncate">{view.name}</span>}
    </span>
  );
}

function authorName(m: ChatMessageView, people: Person[] | undefined, system: string): string {
  return m.authorId ? (people?.find((p) => p.id === m.authorId)?.name ?? "") : system;
}

function Result({
  hit,
  words,
  people,
  channelLabel,
  selected,
  onSelect,
  onOpen,
}: {
  hit: ChatMessageHit;
  words: readonly string[];
  people: Person[] | undefined;
  channelLabel: string;
  selected: boolean;
  onSelect: () => void;
  onOpen: () => void;
}) {
  const { t, i18n } = useTranslation();
  const m = hit.message;
  const system = t("chat.views.system");
  const author = people?.find((p) => p.id === m.authorId);
  const name = authorName(m, people, system);
  const text = plainText(m.text);
  const when = formatDateTime(m.createdAt, i18n.language);
  const context = hit.context;
  const root = m.threadOf ? hit.root : null;
  const citations = m.citations.filter((ref) => ref.kind !== "person");
  const id = useId();
  // Un link, non un bottone: i figli di un bottone sono presentazionali, e
  // il `<mark>` delle parole trovate non arriverebbe ai lettori di schermo.
  // Il nome è «chi, in quale canale, quando: testo»; il contesto lo descrive.
  return (
    <Link
      to="/chat/$channelId"
      params={{ channelId: hit.channelId }}
      search={(m.threadOf ? { thread: m.threadOf, message: m.id } : { message: m.id }) as never}
      data-result={m.id}
      data-selected={selected || undefined}
      tabIndex={selected ? 0 : -1}
      onFocus={onSelect}
      onClick={(e) => {
        // Prima si rilegge il messaggio: può non esserci più (toast, si resta qui).
        e.preventDefault();
        onOpen();
      }}
      aria-labelledby={`${id}-who ${id}-where${text ? ` ${id}-text` : ""}`}
      aria-describedby={context ? `${id}-ctx` : undefined}
      className={`flex min-h-14 w-full min-w-0 flex-col gap-1 rounded-md px-4 py-2 text-left transition-colors duration-[var(--duration-fast)] ease-out ${
        selected ? "bg-ink/8" : "hover:bg-ink/4"
      }`}
    >
      {context && (
        <span
          id={`${id}-ctx`}
          className="block truncate pl-9 text-xs text-ink-faint"
          data-result-context
        >
          <span className="sr-only">{t("chat.search.before")} </span>
          {authorName(context, people, system)}: {plainText(context.text)}
        </span>
      )}
      <span className="flex min-w-0 gap-3">
        <span className="pt-px">
          <ChatAvatar person={author} size={24} />
        </span>
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex min-w-0 items-baseline gap-1.5 text-sm">
            <span id={`${id}-who`} className="shrink-0 font-semibold text-ink">
              {name}
            </span>
            <span id={`${id}-where`} className="sr-only">
              {t("chat.search.resultWhere", {
                channel: channelLabel,
                date: formatDate(m.createdAt, i18n.language),
              })}
            </span>
            <span className="num shrink-0 text-xs text-ink-muted">· {when}</span>
            {m.threadOf && (
              <span className="min-w-0 truncate text-xs text-ink-muted">
                · {t("chat.search.inThread")}{" "}
                {root && root.deletedAt === null ? plainText(root.text) : t("chat.search.deleted")}
              </span>
            )}
          </span>
          {text && (
            <span
              id={`${id}-text`}
              className="line-clamp-3 text-md text-ink [overflow-wrap:anywhere]"
            >
              <Highlighted text={text} words={words} />
            </span>
          )}
          {(citations.length > 0 || m.attachments.length > 0) && (
            <span className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 pt-0.5 text-sm">
              {citations.map((ref) => (
                <CitationToken key={refKey(ref)} refItem={ref} />
              ))}
              {m.attachments.map((a) => (
                <span
                  key={a.id}
                  className="inline-flex h-6 max-w-[240px] min-w-0 items-center gap-1.5 rounded-md border border-rule px-1.5 text-xs text-ink"
                >
                  <span className="shrink-0 text-ink-muted [&_svg]:size-3.5">
                    <FileGlyph />
                  </span>
                  <span className="min-w-0 truncate">
                    <Highlighted text={a.name} words={words} />
                  </span>
                </span>
              ))}
            </span>
          )}
        </span>
      </span>
    </Link>
  );
}

// --- dal canale: «Back to results» ------------------------------------------------

/**
 * Nel canale raggiunto da un risultato: la pillola «Back to results» (e
 * ⌘[) torna alla pagina con query, filtri e il risultato selezionato.
 */
export function BackToResults({ messageId }: { messageId: string | undefined }) {
  const { t } = useTranslation();
  const me = useSessionPersonId();
  const router = useRouter();
  const mark = resultsFor(me, messageId);
  const href = mark?.href;
  useEffect(() => {
    if (!href) return;
    function onKeyDown(e: globalThis.KeyboardEvent) {
      if (e.defaultPrevented || !hasModKey(e) || e.altKey || e.shiftKey || e.key !== "[") return;
      if (document.querySelector('[role="dialog"][aria-modal="true"]')) return;
      e.preventDefault();
      router.history.push(href!);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [href, router]);
  if (!href) return null;
  return (
    <div className="flex shrink-0 px-8 pt-2 pb-1 @max-[620px]:px-4">
      <button
        type="button"
        onClick={() => router.history.push(href)}
        data-back-to-results
        className="inline-flex h-7 items-center gap-2 rounded-full border border-rule-strong px-3 text-sm text-ink transition-colors duration-[var(--duration-fast)] ease-out hover:bg-ink/6"
      >
        <span aria-hidden="true">←</span>
        {t("chat.search.back")}
        <kbd className="num font-sans text-xs text-ink-faint">{shortcutLabel(["mod", "["])}</kbd>
      </button>
    </div>
  );
}

// --- nella colonna: il campo «Search messages ⌘F» ------------------------------------

/**
 * Il campo in testa alla colonna della Chat: Enter apre la pagina dei
 * risultati (con i filtri già scelti, se ci si è); sulla pagina resta
 * allineato alla query. ⌘F, dentro la Chat, mette il fuoco qui — o nel
 * campo della pagina, se è aperta.
 */
export function ColumnSearchField() {
  const { t } = useTranslation();
  const goSearch = useGoSearch();
  const onPage = useRouterState({
    select: (s) =>
      s.location.pathname === "/chat" && (s.location.search as { view?: string }).view === "search",
  });
  const params = useSearchParams();
  const [value, setValue] = useState(onPage ? (params.q ?? "") : "");
  useEffect(() => {
    if (onPage) setValue(params.q ?? "");
  }, [onPage, params.q]);
  const id = useId();

  useEffect(() => {
    function onKeyDown(e: globalThis.KeyboardEvent) {
      if (e.defaultPrevented || !hasModKey(e) || e.altKey || e.shiftKey) return;
      if (e.key.toLowerCase() !== "f") return;
      if (document.querySelector('[role="dialog"][aria-modal="true"]')) return;
      const target =
        document.querySelector<HTMLInputElement>('[data-chat-search="page"]') ??
        document.querySelector<HTMLInputElement>('[data-chat-search="column"]');
      if (!target) return;
      e.preventDefault();
      target.focus();
      target.select();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  return (
    <div className="relative mt-2 flex h-8 shrink-0 items-center rounded-md border border-rule bg-transparent text-ink-muted transition-colors duration-[var(--duration-fast)] ease-out focus-within:border-ink/40 hover:border-rule-strong">
      <label htmlFor={id} className="pl-2.5 text-ink-faint">
        <span className="sr-only">{t("chat.column.search")}</span>
        <SearchGlyph />
      </label>
      <input
        id={id}
        type="search"
        data-chat-search="column"
        placeholder={t("chat.column.search")}
        spellCheck={false}
        autoComplete="off"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            const q = value.trim();
            goSearch(onPage ? { ...params, q: q || undefined } : q ? { q } : {});
          } else if (e.key === "Escape" && value) {
            e.preventDefault();
            setValue("");
          }
        }}
        className="h-full min-w-0 flex-1 bg-transparent px-2 text-md text-ink outline-none placeholder:text-ink-muted focus-visible:outline-none [&::-webkit-search-cancel-button]:hidden"
      />
      <kbd className="num pointer-events-none shrink-0 pr-2.5 font-sans text-xs text-ink-faint">
        {shortcutLabel(["mod", "F"])}
      </kbd>
    </div>
  );
}
