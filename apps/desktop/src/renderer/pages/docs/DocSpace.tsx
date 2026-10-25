import { Link, Outlet, useNavigate, useParams } from "@tanstack/react-router";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { useTranslation } from "react-i18next";
import {
  useDocSpaces,
  useDocTree,
  useSessionPersonId,
  useStartGeneration,
} from "../../data/queries";
import type { DocKind, DocSpaceView, Project } from "../../data/types";
import { DOCKED_PANEL_QUERY } from "../../layout/useDetailPanel";
import { useMediaQuery } from "../../layout/useMediaQuery";
import { openPalette } from "../../layout/useShortcuts";
import { formatDate } from "../../notifications/time";
import { PageError } from "../../tasks-ui/PageStates";
import { useToast } from "../../tasks-ui/Toast";
import { overflowingBarItems } from "../../domain/docs";
import { itemClass } from "../../tasks-ui/Menu";
import { MoreIcon, PlusIcon, smallSecondary } from "../task/parts";
import { MenuButton, primaryButton, secondaryButton } from "../tasks/controls";
import { DocsChatPanel, useDocsChat } from "./DocsChat";
import { DocTree, DocTreeSkeleton, ancestorKeys, categoryKey, folderKeys } from "./DocTree";
import { GenerationPanel } from "./GenerationPanel";
import {
  DocNotFound,
  DocsForbidden,
  DocsGroup,
  GenerationLine,
  MinorMark,
  PageRefRow,
  ReadingSkeleton,
  SpaceContext,
  backLinkClass,
  isForbidden,
  productPages,
  releaseFirstLine,
  rowLinkClass,
  useSpace,
} from "./parts";

// Lo spazio di un repository (shape docs.md §3, §6): barra secondaria, albero
// a sinistra (240 px, ridimensionabile 200–360 dal bordo) e colonna di
// lettura (≤ 720 px). Sotto i 1200 px l'albero è un cassetto sovrapposto di
// 280 px aperto da «Pages» (⌘\). Lo spazio resta montato fra le sue viste
// (indice, pagina, form): l'albero non si muove, cambia solo la lettura.

const TREE_MIN = 200;
const TREE_MAX = 360;
const TREE_DEFAULT = 240;

/** Una voce della barra secondaria: testo, tinta al passaggio, corrente in tinta piena. */
const barItem =
  "inline-flex h-7 min-w-0 shrink-0 items-center rounded-md px-2 text-sm font-medium whitespace-nowrap text-ink-muted transition-colors duration-[var(--duration-fast)] ease-out hover:bg-ink/6 hover:text-ink aria-[current=page]:bg-ink/10 aria-[current=page]:text-ink";

/** La chat del repository aperta o chiusa, per persona (solo una comodità: può mancare). */
const chatKey = (personId: string) => `stubwise.docs.repoChat.${personId}`;

function readChatOpen(personId: string): boolean {
  try {
    return window.localStorage.getItem(chatKey(personId)) === "open";
  } catch {
    return false;
  }
}

function writeChatOpen(personId: string, open: boolean): void {
  try {
    window.localStorage.setItem(chatKey(personId), open ? "open" : "closed");
  } catch {
    // Senza memoria locale la chat torna chiusa alla prossima visita: va bene così.
  }
}

/**
 * Sotto i 1200 px la chat del repository si sovrappone a destra (400 px), col
 * fuoco dentro; Esc la chiude (non se sopra c'è un dialogo).
 */
function ChatOverlay({ onClose, children }: { onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // La casella, se c'è (chat disponibile); altrimenti il primo bottone.
    const root = ref.current;
    (
      root?.querySelector<HTMLElement>("textarea") ?? root?.querySelector<HTMLElement>("button")
    )?.focus();
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      if (document.querySelector('[aria-modal="true"]')) return;
      e.preventDefault();
      onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div
      ref={ref}
      data-docs-chat-overlay
      className="absolute top-10 right-0 bottom-0 z-30 flex w-[400px] max-w-full border-l border-rule-strong bg-surface shadow-[0_12px_32px_-8px_oklch(0_0_0/0.4)]"
    >
      {children}
    </div>
  );
}

/** Lo spazio `repo` (nome del repository) del progetto; non trovato = come invisibile. */
export function DocSpace({ project, repo }: { project: Project; repo: string }) {
  const { t } = useTranslation();
  const spaces = useDocSpaces(project.id);
  if (spaces.isError) {
    if (isForbidden(spaces.error)) return <DocsForbidden />;
    return (
      <div className="page-header pl-4 [--page-header-pt:16px]">
        <PageError message={t("docs.loadError")} onRetry={() => void spaces.refetch()} />
      </div>
    );
  }
  if (spaces.isPending) {
    return (
      <div className="flex h-full min-h-0">
        <div className="w-[240px] shrink-0 border-r border-rule">
          <DocTreeSkeleton />
        </div>
        <div className="min-w-0 flex-1 px-8">
          <ReadingSkeleton />
        </div>
      </div>
    );
  }
  const space = spaces.data.find((s) => s.name === repo);
  if (!space) {
    return (
      <div className="page-header pl-8 [--page-header-pr:32px] [--page-header-pt:0px]">
        <DocNotFound
          back={
            <Link to="/p/$code/docs" params={{ code: project.code }} className={backLinkClass}>
              {t("docs.page.backToIndex")}
            </Link>
          }
        />
      </div>
    );
  }
  return <SpaceShell project={project} space={space} />;
}

function SpaceShell({ project, space }: { project: Project; space: DocSpaceView }) {
  const { t } = useTranslation();
  const docked = useMediaQuery(DOCKED_PANEL_QUERY);
  const tree = useDocTree(space.repositoryId);
  const params = useParams({ strict: false }) as { slug?: string };
  const slug = params.slug ?? null;

  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  const [focusCategory, setFocusCategory] = useState<{ kind: DocKind; nonce: number } | null>(null);
  const [width, setWidth] = useState(TREE_DEFAULT);
  const [drawer, setDrawer] = useState(false);
  const pagesButton = useRef<HTMLButtonElement>(null);

  const toggle = useCallback((key: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  }, []);

  // La pagina aperta si vede sempre nell'albero: il suo gruppo e le sue cartelle si aprono.
  const categories = tree.data;
  useEffect(() => {
    if (!slug || !categories) return;
    const keys = ancestorKeys(categories, slug);
    setCollapsed((prev) =>
      keys.some((k) => prev.has(k)) ? new Set([...prev].filter((k) => !keys.includes(k))) : prev,
    );
  }, [slug, categories]);

  const revealCategory = useCallback(
    (kind: DocKind) => {
      setCollapsed((prev) => new Set([...prev].filter((k) => k !== categoryKey(kind))));
      if (!docked) setDrawer(true);
      setFocusCategory((prev) => ({ kind, nonce: (prev?.nonce ?? 0) + 1 }));
    },
    [docked],
  );

  // La chat del repository: chiusa di default, ricordata aperta o chiusa per
  // persona (A 3); ⌘⇧C la apre e la chiude. La conversazione resta mentre si
  // passa da una pagina all'altra (la shell non si smonta).
  const me = useSessionPersonId();
  const [chatOpen, setChatOpen] = useState(() => readChatOpen(me));
  const chatButton = useRef<HTMLButtonElement>(null);
  const chat = useDocsChat({ projectId: project.id, repositoryId: space.repositoryId });
  const setChat = useCallback(
    (open: boolean) => {
      setChatOpen(open);
      writeChatOpen(me, open);
    },
    [me],
  );
  const closeChat = useCallback(
    (restore: boolean) => {
      setChat(false);
      if (restore) chatButton.current?.focus();
    },
    [setChat],
  );
  const toggleChat = useCallback(() => {
    if (chatOpen) closeChat(false);
    else setChat(true);
  }, [chatOpen, closeChat, setChat]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.altKey) return;
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === "c") {
        if (document.querySelector('[aria-modal="true"]')) return;
        e.preventDefault();
        toggleChat();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggleChat]);
  const chatProps = {
    chat,
    available: space.chatAvailable,
    suggestions: space.chatSuggestions,
    scope: space.name,
    placeholder: t("docs.chat.placeholderRepo", { name: space.name }),
  };

  const drawerRef = useRef<HTMLElement>(null);
  /** Chiude il cassetto; con `restore` il fuoco torna su «Pages». */
  const closeDrawer = useCallback((restore: boolean) => {
    setDrawer(false);
    if (restore) pagesButton.current?.focus();
  }, []);

  // ⌘\ apre e chiude il cassetto (solo quando l'albero non è affiancato); Esc lo
  // chiude, ma non se sopra c'è un dialogo (l'Esc è suo); un clic fuori anche.
  useEffect(() => {
    if (docked) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "\\" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        if (drawer) closeDrawer(true);
        else setDrawer(true);
      } else if (e.key === "Escape" && drawer) {
        // Un Esc chiude solo lo strato in cima: la chat sovrapposta prima del cassetto.
        if (document.querySelector("[data-docs-chat-overlay]")) return;
        if (e.defaultPrevented || document.querySelector('[aria-modal="true"]')) return;
        e.preventDefault();
        closeDrawer(true);
      }
    };
    const onPointer = (e: PointerEvent) => {
      const target = e.target as Node;
      if (drawerRef.current?.contains(target) || pagesButton.current?.contains(target)) return;
      closeDrawer(false);
    };
    window.addEventListener("keydown", onKey);
    if (drawer) document.addEventListener("pointerdown", onPointer);
    return () => {
      window.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onPointer);
    };
  }, [docked, drawer, closeDrawer]);

  // Aperto, il fuoco entra nel cassetto (salvo che ci sia già: «Show in the tree»).
  useEffect(() => {
    const el = drawerRef.current;
    if (!drawer || !el || el.contains(document.activeElement)) return;
    el.querySelector<HTMLElement>('[role="treeitem"][tabindex="0"], button')?.focus();
  }, [drawer, tree.data]);

  const treeBody = tree.isError ? (
    <PageError message={t("docs.tree.error")} onRetry={() => void tree.refetch()} />
  ) : !categories ? (
    <DocTreeSkeleton />
  ) : (
    <DocTree
      categories={categories}
      projectCode={project.code}
      repo={space.name}
      collapsed={collapsed}
      onToggle={toggle}
      onExpandAll={() => setCollapsed(new Set())}
      onCollapseAll={() =>
        setCollapsed(
          new Set([...categories.map((c) => categoryKey(c.kind)), ...folderKeys(categories)]),
        )
      }
      focusCategory={focusCategory}
      onNavigate={docked ? undefined : () => closeDrawer(true)}
    />
  );

  return (
    <SpaceContext.Provider value={{ project, space, revealCategory }}>
      <div className="relative flex h-full min-h-0 flex-col">
        <SpaceBar
          project={project}
          space={space}
          pagesButton={docked ? null : pagesButton}
          drawer={drawer}
          onPages={() => (drawer ? closeDrawer(false) : setDrawer(true))}
          chatButton={chatButton}
          chatOpen={chatOpen}
          onChat={toggleChat}
        />
        <div className="flex min-h-0 flex-1">
          {docked && (
            <aside
              aria-label={t("docs.space.treeLabel", { name: space.name })}
              style={{ width }}
              className="relative flex shrink-0 flex-col border-r border-rule"
            >
              <div className="min-h-0 flex-1 overflow-y-auto">{treeBody}</div>
              <GenerationPanel project={project} space={space} />
              <Resizer width={width} onWidth={setWidth} />
            </aside>
          )}
          <div className="min-w-0 flex-1 overflow-y-auto">
            <div className="w-full max-w-[784px] pr-8 pb-16 pl-8">
              <Outlet />
            </div>
          </div>
          {docked && chatOpen && (
            <DocsChatPanel
              {...chatProps}
              onClose={() => closeChat(true)}
              className="w-[360px] shrink-0 border-l border-rule"
            />
          )}
        </div>
        {!docked && drawer && (
          <aside
            ref={drawerRef}
            aria-label={t("docs.space.treeLabel", { name: space.name })}
            className="absolute top-10 bottom-0 left-0 z-30 flex w-[280px] flex-col border-r border-rule-strong bg-surface shadow-[0_12px_32px_-8px_oklch(0_0_0/0.4)]"
          >
            <div className="min-h-0 flex-1 overflow-y-auto">{treeBody}</div>
            <GenerationPanel project={project} space={space} />
          </aside>
        )}
        {!docked && chatOpen && (
          <ChatOverlay onClose={() => closeChat(true)}>
            <DocsChatPanel
              {...chatProps}
              onClose={() => closeChat(true)}
              className="h-full w-full"
            />
          </ChatOverlay>
        )}
      </div>
    </SpaceContext.Provider>
  );
}

/** Le voci della barra che possono finire in «More», dalla più importante. */
const OPTIONAL_BAR = ["brief", "graph", "search"] as const;
type OptionalBarItem = (typeof OPTIONAL_BAR)[number];

/**
 * La barra secondaria dello spazio (shape §3, §6): nome del repository ·
 * Index · Brief · Releases N · Graph, a destra «Search ⌘K» e «Chat». Le voci
 * non vanno mai a capo: quando la barra è stretta (1024, italiano, nome
 * lungo) Search, Graph e Brief passano, in quest'ordine, nel menu «More».
 * Index, Releases e Chat restano sempre. Le larghezze si misurano su una
 * copia invisibile della barra intera.
 */
function SpaceBar({
  project,
  space,
  pagesButton,
  drawer,
  onPages,
  chatButton,
  chatOpen,
  onChat,
}: {
  project: Project;
  space: DocSpaceView;
  /** C'è solo quando l'albero è un cassetto (sotto i 1200 px). */
  pagesButton: RefObject<HTMLButtonElement | null> | null;
  drawer: boolean;
  onPages: () => void;
  chatButton: RefObject<HTMLButtonElement | null>;
  chatOpen: boolean;
  onChat: () => void;
}) {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const nav = useRef<HTMLElement>(null);
  const measure = useRef<HTMLDivElement>(null);
  const [hidden, setHidden] = useState<readonly string[]>([]);

  const fit = useCallback(() => {
    const bar = nav.current;
    const copy = measure.current;
    // Una barra non ancora impaginata (larghezza 0) non decide nulla.
    if (!bar || !copy || bar.clientWidth === 0) return;
    const width = (id: string) =>
      copy.querySelector<HTMLElement>(`[data-bar="${id}"]`)?.offsetWidth ?? 0;
    const style = getComputedStyle(bar);
    const available =
      bar.clientWidth -
      (parseFloat(style.paddingLeft) || 0) -
      (parseFloat(style.paddingRight) || 0);
    const fixed = ["pages", "name", "index", "releases", "chat"].reduce(
      (sum, id) => sum + width(id) + 4,
      0,
    );
    const next = overflowingBarItems(
      available,
      fixed,
      OPTIONAL_BAR.map((id) => ({ id, width: width(id) })),
      width("more"),
    );
    setHidden((prev) => (prev.join() === next.join() ? prev : next));
  }, []);

  useLayoutEffect(fit, [fit, i18n.language, space.name, space.releases.length, pagesButton]);
  useEffect(() => {
    const bar = nav.current;
    if (!bar || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => fit());
    observer.observe(bar);
    return () => observer.disconnect();
  }, [fit]);

  const shows = (id: OptionalBarItem) => !hidden.includes(id);
  const viewLink = (view: "brief" | "releases" | "graph") => (
    <Link
      key={view}
      to={`/p/$code/docs/$repo/${view}`}
      params={{ code: project.code, repo: space.name }}
      className={barItem}
    >
      {t(`docs.space.${view}`)}
      {view === "releases" && space.releases.length > 0 && (
        <span className="num ml-1.5 text-xs text-ink-faint">{space.releases.length}</span>
      )}
    </Link>
  );
  const nameClass = "max-w-[240px] truncate px-2 text-md font-semibold text-ink";

  return (
    <nav
      ref={nav}
      aria-label={t("docs.space.bar", { name: space.name })}
      className="page-header relative flex min-h-10 shrink-0 items-center gap-1 border-b border-rule pl-3 [--page-header-pr:16px]"
    >
      {/* La copia da misurare: tutte le voci, invisibile, fuori dal flusso e
          dentro una scatola di 0 px (non allarga la pagina). */}
      <div aria-hidden="true" className="absolute top-0 left-0 h-0 w-0 overflow-hidden">
        <div
          ref={measure}
          inert
          className="pointer-events-none invisible flex w-max items-center gap-1 whitespace-nowrap"
        >
          {pagesButton && (
            <span data-bar="pages" className={barItem}>
              {t("docs.space.pagesToggle")}
            </span>
          )}
          <span data-bar="name" className={nameClass}>
            {space.name}
          </span>
          <span data-bar="index" className={barItem}>
            {t("docs.space.index")}
          </span>
          <span data-bar="brief" className={barItem}>
            {t("docs.space.brief")}
          </span>
          <span data-bar="releases" className={barItem}>
            {t("docs.space.releases")}
            <span className="num ml-1.5 text-xs">{space.releases.length}</span>
          </span>
          <span data-bar="graph" className={barItem}>
            {t("docs.space.graph")}
          </span>
          <span data-bar="more" className={barItem}>
            {t("docs.space.more")}
            <MoreIcon />
          </span>
          <span data-bar="search" className={barItem}>
            {t("docs.space.search")}
            <kbd className="num ml-1.5 font-sans text-xs">⌘K</kbd>
          </span>
          <span data-bar="chat" className={barItem}>
            {t("docs.space.chat")}
          </span>
        </div>
      </div>

      {pagesButton && (
        <button
          ref={pagesButton}
          type="button"
          aria-expanded={drawer}
          aria-keyshortcuts="Meta+Backslash"
          title={`${t("docs.space.pagesToggle")} · ⌘\\`}
          onClick={onPages}
          className="inline-flex h-7 shrink-0 items-center rounded-md px-2 text-sm font-medium text-ink-muted transition-colors duration-[var(--duration-fast)] ease-out hover:bg-ink/6 hover:text-ink aria-expanded:bg-ink/10 aria-expanded:text-ink"
        >
          {t("docs.space.pagesToggle")}
        </button>
      )}
      <span title={space.name} className={`min-w-0 ${nameClass}`}>
        {space.name}
      </span>
      <Link
        to="/p/$code/docs/$repo"
        params={{ code: project.code, repo: space.name }}
        activeOptions={{ exact: true }}
        className={barItem}
      >
        {t("docs.space.index")}
      </Link>
      {shows("brief") && viewLink("brief")}
      {viewLink("releases")}
      {shows("graph") && viewLink("graph")}
      {hidden.length > 0 && (
        <MenuButton
          menuLabel={t("docs.space.more")}
          align="right"
          className={`${barItem} gap-1 aria-expanded:bg-ink/10 aria-expanded:text-ink`}
          wrapperClassName="inline-flex shrink-0"
          label={
            <>
              {t("docs.space.more")}
              <MoreIcon />
            </>
          }
        >
          {(close) =>
            hidden.map((id) => (
              <button
                key={id}
                type="button"
                role="menuitem"
                className={itemClass}
                onClick={() => {
                  close();
                  if (id === "search") openPalette("open");
                  else
                    void navigate({
                      to: `/p/$code/docs/$repo/${id as "brief" | "graph"}`,
                      params: { code: project.code, repo: space.name },
                    });
                }}
              >
                {t(`docs.space.${id}`)}
                {id === "search" && (
                  <kbd className="num ml-auto pl-4 font-sans text-xs text-ink-faint">⌘K</kbd>
                )}
              </button>
            ))
          }
        </MenuButton>
      )}
      <span className="ml-auto flex shrink-0 items-center gap-1">
        {shows("search") && (
          <button
            type="button"
            onClick={() => openPalette("open")}
            aria-keyshortcuts="Meta+K"
            className={barItem}
          >
            {t("docs.space.search")}
            <kbd className="num ml-1.5 font-sans text-xs text-ink-faint">⌘K</kbd>
          </button>
        )}
        <button
          ref={chatButton}
          type="button"
          aria-pressed={chatOpen}
          aria-keyshortcuts="Meta+Shift+C"
          title={`${t("docs.space.chat")} · ⌘⇧C`}
          onClick={onChat}
          className={`${barItem} aria-pressed:bg-ink/10 aria-pressed:text-ink`}
        >
          {t("docs.space.chat")}
        </button>
      </span>
    </nav>
  );
}

/** Il bordo destro dell'albero: si trascina (o ←/→ col fuoco) fra 200 e 360 px. */
function Resizer({ width, onWidth }: { width: number; onWidth: (w: number) => void }) {
  const { t } = useTranslation();
  const clamp = (w: number) => Math.max(TREE_MIN, Math.min(TREE_MAX, Math.round(w)));
  const start = (e: ReactPointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const from = e.clientX;
    const base = width;
    const move = (ev: PointerEvent) => onWidth(clamp(base + ev.clientX - from));
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  const onKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      e.preventDefault();
      onWidth(clamp(width + (e.key === "ArrowRight" ? 16 : -16)));
    }
  };
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={t("docs.space.resize")}
      aria-valuemin={TREE_MIN}
      aria-valuemax={TREE_MAX}
      aria-valuenow={width}
      tabIndex={0}
      onPointerDown={start}
      onKeyDown={onKey}
      className="absolute top-0 -right-[3px] bottom-0 z-10 w-[6px] cursor-col-resize outline-none after:absolute after:inset-y-0 after:left-[2px] after:w-[2px] after:transition-colors after:duration-[var(--duration-fast)] hover:after:bg-ink/20 focus-visible:after:bg-focus"
    />
  );
}

/** Un campo in cui si scrive: lì J e K sono lettere. */
const isTyping = (el: Element | null) =>
  el instanceof HTMLElement &&
  (el.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName));

/**
 * J/K nell'indice (A 11): la riga successiva o precedente fra tutte quelle
 * degli elenchi (pagine e categorie), nell'ordine in cui si leggono; Enter
 * la apre. Non con un modificatore, non in un campo, non sotto un dialogo.
 */
function useIndexKeys(root: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented) return;
      const key = e.key.toLowerCase();
      if (key !== "j" && key !== "k") return;
      if (isTyping(document.activeElement) || document.querySelector('[aria-modal="true"]')) return;
      const rows = [
        ...(root.current?.querySelectorAll<HTMLElement>("ul > li > :is(a, button)") ?? []),
      ];
      if (rows.length === 0) return;
      e.preventDefault();
      const at = rows.indexOf(document.activeElement as HTMLElement);
      const next = at < 0 ? (key === "j" ? 0 : rows.length - 1) : at + (key === "j" ? 1 : -1);
      rows[Math.max(0, Math.min(rows.length - 1, next))]?.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [root]);
}

/**
 * L'indice del repository (shape §3): h1 = nome, lo stato della
 * generazione in parole, il riassunto del brief, «Start here», le
 * categorie, le novità, le aggiornate di recente e le più lette.
 */
export function RepoIndex() {
  const { t, i18n } = useTranslation();
  const { project, space, revealCategory } = useSpace();
  const tree = useDocTree(space.repositoryId);
  const product = productPages(tree.data ?? []);
  const releases = [...space.releases].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 3);
  const article = useRef<HTMLElement>(null);
  useIndexKeys(article);

  return (
    <article ref={article} className="event-enter flex flex-col">
      <header className="flex items-start gap-4 pt-8">
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <h1 className="truncate text-2xl font-semibold text-ink" title={space.name}>
            {space.name}
          </h1>
          <GenerationLine space={space} live className="text-sm text-ink-muted" />
        </div>
        {space.permissions.edit && (
          <Link
            to="/p/$code/docs/$repo/new"
            params={{ code: project.code, repo: space.name }}
            className={secondaryButton}
          >
            <PlusIcon />
            {t("docs.index.newPage")}
          </Link>
        )}
      </header>
      {space.brief && (
        <>
          <p className="mt-4 line-clamp-3 max-w-[72ch] text-md text-ink">{space.brief.identity}</p>
          <Link
            to="/p/$code/docs/$repo/brief"
            params={{ code: project.code, repo: space.name }}
            className="mt-2 self-start rounded-sm text-sm font-medium text-ink underline decoration-ink/30 underline-offset-4 hover:decoration-ink"
          >
            {t("docs.brief.read")}
          </Link>
        </>
      )}

      {space.pageCount === 0 ? (
        <NotGenerated space={space} />
      ) : (
        <>
          {product.length > 0 && (
            <DocsGroup title={t("docs.groups.startHere")}>
              <ul aria-label={t("docs.groups.startHere")} className="border-t border-rule">
                {product.map((page) => (
                  <PageRefRow
                    key={page.id}
                    page={page}
                    projectCode={project.code}
                    repo={space.name}
                  />
                ))}
              </ul>
            </DocsGroup>
          )}

          <DocsGroup title={t("docs.groups.categories")}>
            {tree.isError ? (
              <div role="alert" className="flex items-center gap-3 border-t border-rule py-3 pl-2">
                <p className="text-md text-ink">{t("docs.tree.error")}</p>
                <button
                  type="button"
                  className={smallSecondary}
                  onClick={() => void tree.refetch()}
                >
                  {t("taskUi.states.retry")}
                </button>
              </div>
            ) : !tree.data ? (
              <div aria-busy="true" className="skeleton-breathe border-t border-rule">
                <span role="status" className="sr-only">
                  {t("taskUi.states.loading")}
                </span>
                {[0, 1, 2, 3].map((i) => (
                  <div key={i} className="flex h-11 items-center border-b border-rule px-2">
                    <span className="h-2.5 w-28 rounded-sm bg-ink/8" />
                  </div>
                ))}
              </div>
            ) : (
              <ul aria-label={t("docs.groups.categories")} className="border-t border-rule">
                {tree.data.map((c) => {
                  const label = t(`docs.kinds.${c.kind}`);
                  return (
                    <li key={c.kind}>
                      <button
                        type="button"
                        onClick={() => revealCategory(c.kind)}
                        aria-label={t("docs.index.showInTree", { name: label })}
                        title={t("docs.index.showInTree", { name: label })}
                        className={`${rowLinkClass} w-full`}
                      >
                        <span className="min-w-0 flex-1 truncate text-md text-ink">{label}</span>
                        <span className="num shrink-0 text-sm text-ink-faint">
                          {t("docs.space.pages", { count: c.count })}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </DocsGroup>

          {releases.length > 0 && (
            <DocsGroup title={t("docs.groups.whatsNew")}>
              <ul aria-label={t("docs.groups.whatsNew")} className="border-t border-rule">
                {releases.map((r) => (
                  <li
                    key={r.id}
                    className="flex min-h-11 min-w-0 items-center gap-3 border-b border-rule px-2 py-2"
                  >
                    <span className="num w-[60px] shrink-0 text-md font-semibold text-ink">
                      {r.version}
                    </span>
                    <span className="num w-14 shrink-0 text-xs text-ink-muted">
                      {formatDate(r.date, i18n.language)}
                    </span>
                    <span
                      className="min-w-0 flex-1 truncate text-md text-ink"
                      title={releaseFirstLine(r)}
                    >
                      {releaseFirstLine(r)}
                    </span>
                    {r.minor && <MinorMark />}
                  </li>
                ))}
              </ul>
            </DocsGroup>
          )}

          <DocsGroup title={t("docs.groups.recent")}>
            <ul aria-label={t("docs.groups.recent")} className="border-t border-rule">
              {space.recent.map((page) => (
                <PageRefRow
                  key={page.id}
                  page={page}
                  projectCode={project.code}
                  repo={space.name}
                  trailing={
                    <span className="num shrink-0 text-xs text-ink-faint">
                      {formatDate(page.updatedAt, i18n.language)}
                    </span>
                  }
                />
              ))}
            </ul>
          </DocsGroup>

          {space.mostRead.length > 0 && (
            <DocsGroup title={t("docs.groups.mostRead")}>
              <ul aria-label={t("docs.groups.mostRead")} className="border-t border-rule">
                {space.mostRead.map((page) => (
                  <PageRefRow
                    key={page.id}
                    page={page}
                    projectCode={project.code}
                    repo={space.name}
                    trailing={
                      <span className="num shrink-0 text-xs text-ink-faint">
                        {t("docs.index.views", { count: page.views })}
                      </span>
                    }
                  />
                ))}
              </ul>
            </DocsGroup>
          )}
        </>
      )}
    </article>
  );
}

/** Uno spazio senza pagine: chi può genera, gli altri sanno a chi chiedere. */
function NotGenerated({ space }: { space: DocSpaceView }) {
  const { t } = useTranslation();
  const toast = useToast();
  const start = useStartGeneration();
  const live = space.generation.status === "queued" || space.generation.status === "running";
  return (
    <div className="flex flex-col items-start gap-2 pt-8">
      <h2 className="text-lg font-semibold text-ink">{t("docs.index.notGenerated")}</h2>
      {space.permissions.generate ? (
        <button
          type="button"
          disabled={live || start.isPending}
          onClick={() =>
            start.mutate(space.repositoryId, {
              onError: () => toast.error(t("docs.index.generateFailed")),
            })
          }
          className={`${primaryButton} mt-2`}
        >
          {t("docs.index.generate")}
        </button>
      ) : (
        <p className="max-w-[60ch] text-md text-ink-muted">{t("docs.index.askGenerate")}</p>
      )}
    </div>
  );
}
