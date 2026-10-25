import { useRouter, useRouterState } from "@tanstack/react-router";
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import {
  useChatChannels,
  useChatSearch,
  useDocSearch,
  useDocSpaces,
  usePeople,
  useProjects,
  useReachChatMessage,
  useSavedFilters,
  useSearch,
} from "../data/queries";
import { rowLabel } from "../pages/chat/ChatPage";
import { Highlighted } from "../pages/chat/ChatSearch";
import { fold, MIN_QUERY, plainText, searchWords } from "../pages/chat/search";
import { formatDate } from "../notifications/time";
import { useToast } from "../tasks-ui/Toast";
import type { SearchResult } from "../data/types";
import { VIEW_AS_PERSONAS, useViewer } from "../data/viewer";
import { DeptLegend, DeptStrip, useDepartmentName } from "../layout/DeptStrip";
import { SearchIcon } from "../layout/icons";
import { useRestoreFocus } from "../layout/useRestoreFocus";
import { PALETTE_EVENT, type PaletteEventDetail } from "../layout/useShortcuts";
import { shortcutLabel } from "../platform/platform";
import { useTheme } from "../theme/ThemeProvider";
import { matchCommands, type Command, type CommandContext } from "./commands";

/** Quanti risultati per gruppo: la palette si scorre a colpo d'occhio, non si sfoglia. */
export const GROUP_LIMIT = 5;
/** Attesa dopo l'ultimo tasto prima di cercare. */
export const SEARCH_DEBOUNCE_MS = 120;

type Step = "root" | "viewAs" | "filters" | "channels";
type GroupId =
  | "projects"
  | "tasks"
  | "requests"
  | "pages"
  | "people"
  | "actions"
  | "viewAs"
  | "filters"
  | "channels"
  | "messages"
  | "more";

interface Item {
  key: string;
  code?: string;
  label: string;
  /** Reparto, solo per le task: la striscia a sinistra della riga. */
  departmentId?: string;
  /** Testo secondario, in tono minore accanto all'etichetta. */
  detail?: string;
  shortcut?: string;
  current?: boolean;
  /** Riga di ricerca (progetto, task, persona): può essere di una query vecchia. */
  fromSearch?: boolean;
  /** «Ask Claude: “…”»: c'è per ogni testo, quindi non conta come risultato trovato. */
  fallback?: boolean;
  /** Un messaggio della Chat: chi, dove e quando sopra, il testo con le parole trovate sotto. */
  message?: { meta: string; text: string; words: string[] };
  /** Una pagina dei Docs: codice · titolo · progetto sopra, il passaggio trovato sotto. */
  page?: { code: string; title: string; project: string | null; passage: string; words: string[] };
  select(): void;
}

interface Group {
  id: GroupId;
  items: Item[];
}

const KIND_GROUP: Record<SearchResult["kind"], GroupId> = {
  project: "projects",
  task: "tasks",
  request: "requests",
  person: "people",
};

function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const id = window.setTimeout(() => setDebounced(value), ms);
    return () => window.clearTimeout(id);
  }, [value, ms]);
  return debounced;
}

const EnterIcon = () => (
  <svg
    viewBox="0 0 16 16"
    width={14}
    height={14}
    fill="none"
    stroke="currentColor"
    strokeWidth={1.4}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
    focusable="false"
    className="shrink-0"
  >
    <path d="M12.5 3.5v4.5a1.5 1.5 0 0 1-1.5 1.5H3.5" />
    <path d="m6 7-2.5 2.5L6 12" />
  </svg>
);

function Kbd({ children }: { children: string }) {
  return (
    <kbd className="num min-w-6 rounded border border-rule-strong px-2 text-center font-sans text-xs text-ink-muted">
      {children}
    </kbd>
  );
}

/**
 * La palette ⌘K: cerca progetti, task e persone, salta a una route, esegue
 * un'azione. Si apre con l'evento `stubwise:palette` (bottone del binario e
 * scorciatoia, già in `useShortcuts`): qui nessun secondo listener del tasto.
 * È un dialog modale con combobox + listbox (`aria-activedescendant`): il
 * fuoco resta sempre nel campo, e alla chiusura torna dov'era.
 */
export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const remember = useRestoreFocus(open);

  useEffect(() => {
    function onPalette(e: Event) {
      // `detail.mode === "open"` (menu dell'app) apre sempre; senza, alterna.
      const explicitOpen =
        (e as CustomEvent<PaletteEventDetail | undefined>).detail?.mode === "open";
      setOpen((wasOpen) => {
        if (!wasOpen) remember();
        return explicitOpen ? true : !wasOpen;
      });
    }
    window.addEventListener(PALETTE_EVENT, onPalette);
    return () => window.removeEventListener(PALETTE_EVENT, onPalette);
  }, [remember]);

  const close = useCallback(() => {
    setOpen(false);
  }, []);

  if (!open) return null;
  return createPortal(<PaletteDialog onClose={close} />, document.body);
}

function PaletteDialog({ onClose }: { onClose: () => void }) {
  const { t, i18n } = useTranslation();
  const router = useRouter();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const { viewer, setPersona } = useViewer();
  // Anche per caricare i reparti subito, prima dei risultati con le strisce.
  const departmentName = useDepartmentName();
  const { setPreference } = useTheme();
  const [step, setStep] = useState<Step>("root");
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const debounced = useDebounced(query, SEARCH_DEBOUNCE_MS);
  const searching = step === "root" && debounced.trim().length > 0;
  const search = useSearch(step === "root" ? debounced : "");
  // I messaggi della Chat (da 2 caratteri): la stessa ricerca della pagina dei risultati.
  const chatQuery = step === "root" ? debounced.trim() : "";
  const chatSearching = chatQuery.length >= MIN_QUERY;
  const chatSearch = useChatSearch(chatQuery);
  const reachMessage = useReachChatMessage();
  const toast = useToast();
  const savedFilters = useSavedFilters();
  // I canali si leggono per «Go to channel…» e, da 2 caratteri, per il gruppo «Channels».
  const channels = useChatChannels(
    { scope: "all" },
    { enabled: step === "channels" || chatSearching },
  );
  const projectList = useProjects().data;
  const people = usePeople().data;
  const input = useRef<HTMLInputElement>(null);
  const baseId = useId();
  const listboxId = `${baseId}-listbox`;
  const optionId = (key: string) => `${baseId}-opt-${key}`;

  useEffect(() => {
    input.current?.focus();
  }, []);

  const projectCode = /^\/p\/([^/]+)/.exec(pathname)?.[1]?.toUpperCase();

  // Dentro uno spazio dei Docs (`/p/<CODE>/docs/<repo>/…`) la ricerca parte
  // con l'ambito «In <repo> docs»: solo le pagine di quello spazio. Tab
  // allarga a «Everywhere» (le pagine stanno con gli altri oggetti) e torna.
  const docsRepo = /^\/p\/[^/]+\/docs\/([^/]+)/.exec(pathname)?.[1];
  const scopeRepo = docsRepo ? decodeURIComponent(docsRepo) : null;
  const scopeProject = projectList?.find((p) => p.code === projectCode);
  const scopeSpaces = useDocSpaces(scopeProject?.id ?? "", {
    enabled: !!scopeRepo && !!scopeProject,
  });
  const scopeSpace = scopeSpaces.data?.find((s) => s.name === scopeRepo) ?? null;
  const [widened, setWidened] = useState(false);
  const scoped = step === "root" && !!scopeRepo && !widened;
  // Con l'ambito si cerca da un carattere; senza, le pagine arrivano da due (come i messaggi).
  const trimmed = step === "root" ? debounced.trim() : "";
  const pagesQuery = scoped || trimmed.length >= MIN_QUERY ? trimmed : "";
  const pageSearch = useDocSearch(
    pagesQuery,
    scoped ? (scopeSpace?.repositoryId ?? "__none__") : null,
    !scoped || !!scopeSpace,
  );

  const groups = useMemo<Group[]>(() => {
    if (step === "viewAs") {
      const needle = query.trim().toLowerCase();
      const items = VIEW_AS_PERSONAS.filter((p) =>
        `${p.name} ${t(p.descriptionKey)}`.toLowerCase().includes(needle),
      ).map((p): Item => {
        return {
          key: `persona-${p.personId}`,
          label: p.name,
          detail: t(p.descriptionKey),
          current: p.personId === viewer.personId,
          select: () => {
            setPersona(p.personId);
            onClose();
          },
        };
      });
      return [{ id: "viewAs", items }];
    }

    if (step === "filters") {
      const needle = query.trim().toLowerCase();
      const items = (savedFilters.data ?? [])
        .filter((f) => f.name.toLowerCase().includes(needle))
        .map(
          (f): Item => ({
            key: `filter-${f.id}`,
            label: f.name,
            select: () => {
              router.history.push(`/filters/${f.id}`);
              onClose();
            },
          }),
        );
      return [{ id: "filters", items }];
    }

    if (step === "channels") {
      const needle = query.trim().toLowerCase();
      // I canali in cui si è (non archiviati) e i messaggi diretti, come nella colonna.
      const items = (channels.data ?? [])
        .filter((c) => c.isMember && !c.archived)
        .map((c) => ({ c, name: rowLabel(c, viewer.personId, projectList, people) }))
        .filter(({ name }) => name.label.toLowerCase().includes(needle))
        .sort(
          (a, b) =>
            Number(a.c.kind === "dm") - Number(b.c.kind === "dm") ||
            a.name.label.localeCompare(b.name.label),
        )
        .slice(0, 50)
        .map(
          ({ c, name }): Item => ({
            key: `channel-${c.id}`,
            ...(c.kind === "project" && name.code ? { code: name.code } : {}),
            label: c.kind === "project" ? c.name : name.label,
            ...(c.mentions > 0
              ? { detail: t("chat.column.mentions", { count: c.mentions }) }
              : {}),
            select: () => {
              router.history.push(`/chat/${c.id}`);
              onClose();
            },
          }),
        );
      return [{ id: "channels", items }];
    }

    const ctx: CommandContext = {
      navigate: (path) => router.history.push(path),
      setTheme: setPreference,
      setPersona,
      projectCode,
      pathname,
      openViewAs: () => {
        setStep("viewAs");
        setQuery("");
        setActive(0);
      },
      openFilters: () => {
        setStep("filters");
        setQuery("");
        setActive(0);
      },
      openChannels: () => {
        setStep("channels");
        setQuery("");
        setActive(0);
      },
    };
    // Il testo arriva al comando solo quando l'etichetta lo cita: «ask
    // claude» scritto per trovare il comando non è la domanda.
    const run = (cmd: Command, quoted?: string) => () => {
      cmd.run(quoted === undefined ? ctx : { ...ctx, query: quoted });
      if (!cmd.keepsOpen) onClose();
    };

    const byGroup: Record<GroupId, Item[]> = {
      projects: [],
      tasks: [],
      requests: [],
      pages: [],
      people: [],
      actions: [],
      viewAs: [],
      filters: [],
      channels: [],
      messages: [],
      more: [],
    };
    // Le pagine dei Docs: codice · titolo (· progetto, senza ambito) e il passaggio.
    if (pagesQuery) {
      const words = searchWords(pagesQuery);
      byGroup.pages = (pageSearch.data ?? []).slice(0, GROUP_LIMIT).map(
        (hit): Item => ({
          key: `page-${hit.page.id}`,
          code: hit.page.code,
          label: `${hit.page.code} ${hit.page.title}`,
          page: {
            code: hit.page.code,
            title: hit.page.title,
            project: scoped ? null : hit.projectCode,
            passage: hit.passage,
            words,
          },
          fromSearch: true,
          select: () => {
            router.history.push(
              `/p/${hit.projectCode}/docs/${hit.repositoryName}/${hit.page.slug}`,
            );
            onClose();
          },
        }),
      );
    }
    if (scoped) return byGroup.pages.length > 0 ? [{ id: "pages", items: byGroup.pages }] : [];
    if (searching) {
      for (const r of search.data ?? []) {
        const list = byGroup[KIND_GROUP[r.kind]];
        if (list.length >= GROUP_LIMIT) continue;
        list.push({
          key: `${r.kind}-${r.id}`,
          code: r.code,
          label: r.label,
          departmentId: r.departmentId,
          fromSearch: true,
          select: () => {
            router.history.push(r.route.replace(/^#/, ""));
            onClose();
          },
        });
      }
    }
    // Dopo gli oggetti, la Chat: i canali leggibili il cui nome corrisponde,
    // poi i messaggi (al più 5) e «Search all messages for “…”».
    if (chatSearching) {
      const needle = fold(chatQuery);
      byGroup.channels = (channels.data ?? [])
        .filter((c) => c.canRead && c.kind !== "dm")
        .map((c) => ({ c, name: rowLabel(c, viewer.personId, projectList, people) }))
        .filter(({ name }) => fold(name.label).includes(needle))
        .sort((a, b) => Number(a.c.archived) - Number(b.c.archived) || a.name.label.localeCompare(b.name.label))
        .slice(0, GROUP_LIMIT)
        .map(({ c, name }): Item => ({
          key: `chat-channel-${c.id}`,
          ...(name.code ? { code: name.code } : {}),
          label: c.kind === "project" ? c.name : name.name,
          detail: c.archived ? t("chat.search.archived") : t("palette.goToChannel"),
          fromSearch: true,
          select: () => {
            router.history.push(`/chat/${c.id}`);
            onClose();
          },
        }));
      const words = searchWords(chatQuery);
      const rows = channels.data;
      byGroup.messages = (chatSearch.data ?? []).slice(0, GROUP_LIMIT).map((hit): Item => {
        const m = hit.message;
        const row = rows?.find((r) => r.id === hit.channelId);
        const channel = row ? rowLabel(row, viewer.personId, projectList, people).label : "";
        const author = m.authorId
          ? (people?.find((p) => p.id === m.authorId)?.name ?? "")
          : t("chat.views.system");
        const meta = t("palette.messageMeta", {
          name: author,
          channel,
          date: formatDate(m.createdAt, i18n.language),
        });
        const text = plainText(m.text);
        return {
          key: `message-${m.id}`,
          label: `${meta}: ${text}`,
          message: { meta, text, words },
          fromSearch: true,
          select: () => {
            onClose();
            void reachMessage(m.id).then((found) => {
              if (!found) return toast.error(t("chat.search.unavailable"));
              const at = found.message;
              router.history.push(
                at.threadOf
                  ? `/chat/${found.channelId}?thread=${at.threadOf}&message=${at.id}`
                  : `/chat/${found.channelId}?message=${at.id}`,
              );
            });
          },
        };
      });
      byGroup.more.push({
        key: "messages-all",
        label: t("palette.searchAllMessages", { query: chatQuery }),
        fallback: true,
        select: () => {
          router.history.push(`/chat?view=search&q=${encodeURIComponent(chatQuery)}`);
          onClose();
        },
      });
    }
    // Un comando che cita il testo («Ask Claude: “…”») va in fondo quando
    // il testo non è il suo nome: prima ciò che il testo ha davvero trovato.
    const needle = query.trim().toLowerCase();
    const matched = matchCommands(query, viewer, (cmd) => t(cmd.labelKey));
    const quoting = (cmd: Command) =>
      !!needle && !!cmd.queryLabelKey && !t(cmd.labelKey).toLowerCase().includes(needle);
    // Le azioni il cui nome corrisponde vengono subito dopo gli oggetti (Enter
    // su «new task» esegue il comando); le righe che citano il testo («Search
    // all messages for “…”», «Ask Claude: “…”») ci sono per ogni testo e
    // vanno in fondo, sotto Channels e Messages.
    const toItem = (cmd: Command): Item => ({
        key: `cmd-${cmd.id}`,
        fallback: quoting(cmd),
        label: quoting(cmd)
          ? t(cmd.queryLabelKey!, { query: query.trim() })
          : t(cmd.labelKey),
        shortcut: cmd.shortcut && shortcutLabel(cmd.shortcut),
        select: run(cmd, quoting(cmd) ? query.trim() : undefined),
      });
    byGroup.actions = matched
      .filter((cmd) => !quoting(cmd))
      .slice(0, needle ? GROUP_LIMIT : undefined)
      .map(toItem);
    byGroup.more.push(...matched.filter(quoting).map(toItem));
    return (
      [
        "projects",
        "tasks",
        "requests",
        "pages",
        "people",
        "actions",
        "channels",
        "messages",
        "more",
      ] as const
    )
      .map((id) => ({ id, items: byGroup[id] }))
      .filter((g) => g.items.length > 0);
  }, [
    step,
    query,
    searching,
    search.data,
    chatQuery,
    chatSearching,
    chatSearch.data,
    reachMessage,
    toast,
    i18n.language,
    viewer,
    setPersona,
    setPreference,
    router,
    projectCode,
    pathname,
    savedFilters.data,
    channels.data,
    projectList,
    people,
    onClose,
    t,
    pagesQuery,
    pageSearch.data,
    scoped,
  ]);

  const items = useMemo(() => groups.flatMap((g) => g.items), [groups]);
  const activeIndex = items.length === 0 ? -1 : Math.min(active, items.length - 1);
  const activeItem = activeIndex >= 0 ? items[activeIndex] : undefined;

  // Il risultato selezionato resta visibile quando la lista scorre.
  const activeOptionId = activeItem ? optionId(activeItem.key) : undefined;
  useEffect(() => {
    if (!activeOptionId) return;
    document.getElementById(activeOptionId)?.scrollIntoView?.({ block: "nearest" });
  }, [activeOptionId]);

  const chatSettled =
    !chatSearching ||
    (chatSearch.isSuccess && !chatSearch.isPlaceholderData && !chatSearch.isFetching);
  const pagesSettled =
    !pagesQuery ||
    (pageSearch.isSuccess && !pageSearch.isPlaceholderData && !pageSearch.isFetching);
  const settled = scoped
    ? query === debounced && pagesSettled
    : query === debounced &&
      search.isSuccess &&
      !search.isPlaceholderData &&
      !search.isFetching &&
      chatSettled &&
      pagesSettled;
  const showEmpty =
    step === "root" &&
    (scoped ? !!pagesQuery : searching) &&
    settled &&
    items.every((item) => item.fallback);
  const showEmptySecond = step !== "root" && items.length === 0;

  // Finché la query digitata non è quella cercata, o i dati sono quelli della
  // ricerca precedente, le righe di ricerca sono vecchie: si vedono (niente
  // sfarfallio) ma non si scelgono. Le azioni sono sempre valide.
  const stale =
    step === "root" &&
    (searching || scoped) &&
    (query !== debounced ||
      search.isPlaceholderData ||
      chatSearch.isPlaceholderData ||
      pageSearch.isPlaceholderData);
  const choose = (item: Item | undefined) => {
    if (!item || (stale && item.fromSearch)) return;
    item.select();
  };

  function back() {
    setStep("root");
    setQuery("");
    setActive(0);
  }

  function onKeyDown(e: ReactKeyboardEvent) {
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        if (items.length) setActive((activeIndex + 1) % items.length);
        break;
      case "ArrowUp":
        e.preventDefault();
        if (items.length) setActive((activeIndex - 1 + items.length) % items.length);
        break;
      case "Home":
        if (!query) {
          e.preventDefault();
          setActive(0);
        }
        break;
      case "End":
        if (!query) {
          e.preventDefault();
          setActive(items.length - 1);
        }
        break;
      case "Enter":
        e.preventDefault();
        choose(activeItem);
        break;
      case "Escape":
        e.preventDefault();
        e.stopPropagation();
        if (step !== "root") back();
        else onClose();
        break;
      case "Backspace":
        if (step !== "root" && query === "") {
          e.preventDefault();
          back();
        }
        break;
      case "Tab":
        // Il solo elemento a fuoco è il campo: il fuoco non esce dal dialog.
        // Dentro uno spazio dei Docs, Tab alterna l'ambito (spazio ↔ ovunque).
        e.preventDefault();
        if (step === "root" && scopeRepo) {
          setWidened((w) => !w);
          setActive(0);
        }
        break;
    }
  }

  return (
    <div
      className="palette-backdrop fixed inset-0 z-40 bg-[var(--scrim)]"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t("palette.label")}
        onKeyDown={onKeyDown}
        className="palette-enter mx-auto mt-[12vh] flex max-h-[min(560px,76vh)] w-[640px] max-w-[calc(100vw-32px)] flex-col overflow-hidden rounded-xl border border-rule-strong bg-surface text-ink shadow-[0_24px_48px_-16px_oklch(0_0_0/0.45)]"
      >
        <div className="flex h-13 shrink-0 items-center gap-3 border-b border-rule px-4">
          <span className="text-ink-muted">
            <SearchIcon />
          </span>
          {step !== "root" && (
            <span className="shrink-0 rounded-md border border-rule-strong px-2 py-0.5 text-xs font-semibold text-ink">
              {t(`palette.groups.${step}`)}
            </span>
          )}
          {step === "root" && scopeRepo && (
            <span
              aria-live="polite"
              className="max-w-[200px] shrink-0 truncate rounded-md border border-rule-strong px-2 py-0.5 text-xs font-semibold text-ink"
            >
              {scoped ? t("palette.scope.space", { repo: scopeRepo }) : t("palette.scope.everywhere")}
            </span>
          )}
          <input
            ref={input}
            type="text"
            role="combobox"
            aria-expanded="true"
            aria-controls={listboxId}
            aria-autocomplete="list"
            aria-activedescendant={activeOptionId}
            aria-label={t("palette.label")}
            placeholder={
              step === "viewAs"
                ? t("palette.viewAsPlaceholder")
                : step === "filters"
                  ? t("palette.filterPlaceholder")
                  : step === "channels"
                    ? t("palette.channelPlaceholder")
                    : scoped
                      ? t("palette.scope.placeholder", { repo: scopeRepo })
                      : t("palette.placeholder")
            }
            spellCheck={false}
            autoComplete="off"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(0);
            }}
            className="h-full min-w-0 flex-1 bg-transparent text-lg text-ink outline-none placeholder:text-ink-faint focus-visible:outline-none"
          />
        </div>

        <div
          id={listboxId}
          role="listbox"
          aria-label={t("palette.label")}
          aria-busy={stale}
          className="min-h-0 flex-1 overflow-y-auto py-1.5 [scrollbar-gutter:stable] empty:hidden"
        >
          {groups.map((group) => {
            const headingId = `${baseId}-group-${group.id}`;
            return (
              <div key={group.id} role="group" aria-labelledby={headingId} className="pb-1">
                <div id={headingId} className="heading-group px-4 pt-2.5 pb-1.5">
                  {t(`palette.groups.${group.id}`)}
                </div>
                {group.items.map((item) => {
                  const selected = item === activeItem;
                  const dimmed = stale && item.fromSearch;
                  if (item.page) {
                    // Una pagina dei Docs: 52px, codice · titolo · progetto sopra, il passaggio sotto.
                    const page = item.page;
                    return (
                      <div
                        key={item.key}
                        id={optionId(item.key)}
                        role="option"
                        aria-selected={selected}
                        aria-label={`${page.code} ${page.title}`}
                        data-palette-page
                        onMouseMove={() => {
                          if (!selected) setActive(items.indexOf(item));
                        }}
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={() => choose(item)}
                        className={`relative mx-1.5 flex h-13 cursor-pointer items-center gap-3 rounded-md px-2.5 text-ink transition-opacity duration-[var(--duration-fast)] aria-selected:bg-ink/8 ${
                          dimmed ? "opacity-50" : ""
                        }`}
                      >
                        <span className="num w-16 shrink-0 self-start pt-[9px] text-sm font-semibold text-ink-muted">
                          {page.code}
                        </span>
                        <span className="flex min-w-0 flex-1 flex-col">
                          <span className="flex min-w-0 items-baseline gap-2">
                            <span className={`truncate text-md ${selected ? "font-medium" : ""}`}>
                              {page.title}
                            </span>
                            {page.project && (
                              <span className="num shrink-0 text-xs text-ink-muted">
                                {page.project}
                              </span>
                            )}
                          </span>
                          <span className="truncate text-xs text-ink-muted">
                            <Highlighted text={page.passage} words={page.words} />
                          </span>
                        </span>
                        <span
                          className={`shrink-0 text-ink-muted ${selected ? "visible" : "invisible"}`}
                        >
                          <EnterIcon />
                        </span>
                      </div>
                    );
                  }
                  if (item.message) {
                    // Un messaggio: 52px, chi/dove/quando sopra, il testo con le parole trovate sotto.
                    return (
                      <div
                        key={item.key}
                        id={optionId(item.key)}
                        role="option"
                        aria-selected={selected}
                        aria-label={item.label}
                        data-palette-message
                        onMouseMove={() => {
                          if (!selected) setActive(items.indexOf(item));
                        }}
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={() => choose(item)}
                        className={`relative mx-1.5 flex h-13 cursor-pointer items-center gap-3 rounded-md px-2.5 text-ink transition-opacity duration-[var(--duration-fast)] aria-selected:bg-ink/8 ${
                          dimmed ? "opacity-50" : ""
                        }`}
                      >
                        <span className="flex min-w-0 flex-1 flex-col">
                          <span className="truncate text-xs text-ink-muted">{item.message.meta}</span>
                          <span className="truncate text-md">
                            <Highlighted text={item.message.text} words={item.message.words} />
                          </span>
                        </span>
                        <span
                          className={`shrink-0 text-ink-muted ${selected ? "visible" : "invisible"}`}
                        >
                          <EnterIcon />
                        </span>
                      </div>
                    );
                  }
                  return (
                    <div
                      key={item.key}
                      id={optionId(item.key)}
                      role="option"
                      aria-selected={selected}
                      onMouseMove={() => {
                        if (!selected) setActive(items.indexOf(item));
                      }}
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => choose(item)}
                      title={
                        departmentName(item.departmentId)
                          ? t("common.department", { name: departmentName(item.departmentId) })
                          : undefined
                      }
                      className={`relative mx-1.5 flex h-9 cursor-pointer items-center gap-3 rounded-md px-2.5 text-md text-ink transition-opacity duration-[var(--duration-fast)] aria-selected:bg-ink/8 ${
                        dimmed ? "opacity-50" : ""
                      }`}
                    >
                      {group.id !== "actions" &&
                        group.id !== "messages" &&
                        group.id !== "more" &&
                        group.id !== "viewAs" &&
                        group.id !== "filters" &&
                        (group.id !== "channels" || item.code) && (
                        <span className="num w-16 shrink-0 text-sm font-semibold text-ink-muted">
                          {item.code}
                        </span>
                      )}
                      <span className="min-w-0 flex-1 truncate">
                        <span className={selected ? "font-medium" : undefined}>{item.label}</span>
                        {item.detail && (
                          <span className="ml-2 text-sm text-ink-muted">{item.detail}</span>
                        )}
                      </span>
                      {item.current && (
                        <span className="shrink-0 text-xs text-ink-muted">
                          {t("palette.current")}
                        </span>
                      )}
                      {item.shortcut && (
                        <kbd className="num shrink-0 font-sans text-xs text-ink-muted">
                          {item.shortcut}
                        </kbd>
                      )}
                      <span
                        className={`shrink-0 text-ink-muted ${selected ? "visible" : "invisible"}`}
                      >
                        <EnterIcon />
                      </span>
                      {group.id === "tasks" && <DeptStrip departmentId={item.departmentId} />}
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>

        <div role="status" aria-live="polite">
          {showEmpty && (
            <div className="px-6 pt-6 pb-8 text-center">
              <p className="text-md text-ink">
                {t("palette.noResults", { query: debounced.trim() })}
              </p>
              <p className="mt-1 text-sm text-ink-muted">
                {t("palette.noResultsHint", {
                  example: projectCode ? `${projectCode}-1` : "AUD-1",
                })}
              </p>
            </div>
          )}
          {showEmptySecond && (
            <p className="px-6 pt-6 pb-8 text-center text-md text-ink">
              {t("palette.noResults", { query: query.trim() })}
            </p>
          )}
        </div>

        <div className="flex shrink-0 flex-col gap-2 border-t border-rule px-4 py-2">
          {/* Legenda dei reparti delle task mostrate: una riga, sopra i suggerimenti. */}
          <DeptLegend departmentIds={items.map((i) => i.departmentId)} />
          <div className="flex items-center gap-4 text-xs text-ink-muted">
            <span className="flex items-center gap-1.5">
              <Kbd>↑</Kbd>
              <Kbd>↓</Kbd>
              {t("palette.hints.move")}
            </span>
            <span className="flex items-center gap-1.5">
              <Kbd>↵</Kbd>
              {t("palette.hints.open")}
            </span>
            <span className="flex items-center gap-1.5">
              <Kbd>Esc</Kbd>
              {step !== "root" ? t("palette.hints.back") : t("palette.hints.close")}
            </span>
            {step === "root" && scopeRepo && (
              <span className="ml-auto min-w-0 truncate">
                {scoped ? t("palette.scope.widen") : t("palette.scope.narrow", { repo: scopeRepo })}
              </span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
