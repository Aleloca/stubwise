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
import { useSearch } from "../data/queries";
import type { SearchResult } from "../data/types";
import { VIEW_AS_PERSONAS, useViewer } from "../data/viewer";
import { DeptLegend, DeptStrip, departmentName } from "../layout/DeptStrip";
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

type Step = "root" | "viewAs";
type GroupId = "projects" | "tasks" | "people" | "actions" | "viewAs";

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
  select(): void;
}

interface Group {
  id: GroupId;
  items: Item[];
}

const KIND_GROUP: Record<SearchResult["kind"], GroupId> = {
  project: "projects",
  task: "tasks",
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
  const { t } = useTranslation();
  const router = useRouter();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const { viewer, setPersona } = useViewer();
  const { setPreference } = useTheme();
  const [step, setStep] = useState<Step>("root");
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const debounced = useDebounced(query, SEARCH_DEBOUNCE_MS);
  const searching = step === "root" && debounced.trim().length > 0;
  const search = useSearch(step === "root" ? debounced : "");
  const input = useRef<HTMLInputElement>(null);
  const baseId = useId();
  const listboxId = `${baseId}-listbox`;
  const optionId = (key: string) => `${baseId}-opt-${key}`;

  useEffect(() => {
    input.current?.focus();
  }, []);

  const projectCode = /^\/p\/([^/]+)/.exec(pathname)?.[1]?.toUpperCase();

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

    const ctx: CommandContext = {
      navigate: (path) => router.history.push(path),
      setTheme: setPreference,
      setPersona,
      projectCode,
      openViewAs: () => {
        setStep("viewAs");
        setQuery("");
        setActive(0);
      },
    };
    const run = (cmd: Command) => () => {
      cmd.run(ctx);
      if (!cmd.keepsOpen) onClose();
    };

    const byGroup: Record<GroupId, Item[]> = {
      projects: [],
      tasks: [],
      people: [],
      actions: [],
      viewAs: [],
    };
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
    byGroup.actions = matchCommands(query, viewer, (cmd) => t(cmd.labelKey))
      .slice(0, query.trim() ? GROUP_LIMIT : undefined)
      .map((cmd) => ({
        key: `cmd-${cmd.id}`,
        label: t(cmd.labelKey),
        shortcut: cmd.shortcut && shortcutLabel(cmd.shortcut),
        select: run(cmd),
      }));
    return (["projects", "tasks", "people", "actions"] as const)
      .map((id) => ({ id, items: byGroup[id] }))
      .filter((g) => g.items.length > 0);
  }, [
    step,
    query,
    searching,
    search.data,
    viewer,
    setPersona,
    setPreference,
    router,
    projectCode,
    onClose,
    t,
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

  const settled =
    query === debounced && search.isSuccess && !search.isPlaceholderData && !search.isFetching;
  const showEmpty = step === "root" && searching && settled && items.length === 0;
  const showEmptyPersonas = step === "viewAs" && items.length === 0;

  // Finché la query digitata non è quella cercata, o i dati sono quelli della
  // ricerca precedente, le righe di ricerca sono vecchie: si vedono (niente
  // sfarfallio) ma non si scelgono. Le azioni sono sempre valide.
  const stale = step === "root" && searching && (query !== debounced || search.isPlaceholderData);
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
        if (step === "viewAs") back();
        else onClose();
        break;
      case "Backspace":
        if (step === "viewAs" && query === "") {
          e.preventDefault();
          back();
        }
        break;
      case "Tab":
        // Il solo elemento a fuoco è il campo: il fuoco non esce dal dialog.
        e.preventDefault();
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
          {step === "viewAs" && (
            <span className="shrink-0 rounded-md border border-rule-strong px-2 py-0.5 text-xs font-semibold text-ink">
              {t("palette.groups.viewAs")}
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
              step === "viewAs" ? t("palette.viewAsPlaceholder") : t("palette.placeholder")
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
                        item.departmentId
                          ? t("common.department", { name: departmentName(item.departmentId) })
                          : undefined
                      }
                      className={`relative mx-1.5 flex h-9 cursor-pointer items-center gap-3 rounded-md px-2.5 text-md text-ink transition-opacity duration-[var(--duration-fast)] aria-selected:bg-ink/8 ${
                        dimmed ? "opacity-50" : ""
                      }`}
                    >
                      {group.id !== "actions" && group.id !== "viewAs" && (
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
          {showEmptyPersonas && (
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
              {step === "viewAs" ? t("palette.hints.back") : t("palette.hints.close")}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
