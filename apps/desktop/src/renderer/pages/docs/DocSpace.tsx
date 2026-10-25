import { Link, Outlet, useParams } from "@tanstack/react-router";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { useTranslation } from "react-i18next";
import { useDocSpaces, useDocTree, useStartGeneration } from "../../data/queries";
import type { DocKind, DocSpaceView, Project } from "../../data/types";
import { DOCKED_PANEL_QUERY } from "../../layout/useDetailPanel";
import { useMediaQuery } from "../../layout/useMediaQuery";
import { formatDate } from "../../notifications/time";
import { PageError } from "../../tasks-ui/PageStates";
import { useToast } from "../../tasks-ui/Toast";
import { PlusIcon } from "../task/parts";
import { primaryButton, secondaryButton } from "../tasks/controls";
import { DocTree, DocTreeSkeleton, ancestorKeys, categoryKey, folderKeys } from "./DocTree";
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

  // ⌘\ apre e chiude il cassetto (solo quando l'albero non è affiancato); Esc lo chiude.
  useEffect(() => {
    if (docked) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "\\" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setDrawer((open) => !open);
      } else if (e.key === "Escape" && drawer) {
        e.preventDefault();
        setDrawer(false);
        pagesButton.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [docked, drawer]);

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
      onCollapseAll={() => setCollapsed(new Set(folderKeys(categories)))}
      focusCategory={focusCategory}
      onNavigate={docked ? undefined : () => setDrawer(false)}
    />
  );

  return (
    <SpaceContext.Provider value={{ project, space, revealCategory }}>
      <div className="relative flex h-full min-h-0 flex-col">
        <nav
          aria-label={t("docs.space.bar", { name: space.name })}
          className="page-header flex min-h-10 shrink-0 items-center gap-1 border-b border-rule pl-3 [--page-header-pr:16px]"
        >
          {!docked && (
            <button
              ref={pagesButton}
              type="button"
              aria-expanded={drawer}
              aria-keyshortcuts="Meta+Backslash"
              title={`${t("docs.space.pagesToggle")} · ⌘\\`}
              onClick={() => setDrawer((open) => !open)}
              className="inline-flex h-7 items-center rounded-md px-2 text-sm font-medium text-ink-muted transition-colors duration-[var(--duration-fast)] ease-out hover:bg-ink/6 hover:text-ink aria-expanded:bg-ink/10 aria-expanded:text-ink"
            >
              {t("docs.space.pagesToggle")}
            </button>
          )}
          <span
            title={space.name}
            className="max-w-[240px] truncate px-2 text-md font-semibold text-ink"
          >
            {space.name}
          </span>
          <Link
            to="/p/$code/docs/$repo"
            params={{ code: project.code, repo: space.name }}
            activeOptions={{ exact: true }}
            className="inline-flex h-7 items-center rounded-md px-2 text-sm font-medium text-ink-muted transition-colors duration-[var(--duration-fast)] ease-out hover:bg-ink/6 hover:text-ink aria-[current=page]:bg-ink/10 aria-[current=page]:text-ink"
          >
            {t("docs.space.index")}
          </Link>
          {/* Task 3: Brief · Releases N · Graph, e a destra «Search ⌘K» e «Chat». */}
        </nav>
        <div className="flex min-h-0 flex-1">
          {docked && (
            <aside
              aria-label={t("docs.space.treeLabel", { name: space.name })}
              style={{ width }}
              className="relative flex shrink-0 flex-col border-r border-rule"
            >
              <div className="min-h-0 flex-1 overflow-y-auto">{treeBody}</div>
              {/* Task 3: il pannello di generazione, in fondo all'albero dietro un filetto. */}
              <Resizer width={width} onWidth={setWidth} />
            </aside>
          )}
          <div className="min-w-0 flex-1 overflow-y-auto">
            <div className="w-full max-w-[784px] pr-8 pb-16 pl-8">
              <Outlet />
            </div>
          </div>
        </div>
        {!docked && drawer && (
          <aside
            aria-label={t("docs.space.treeLabel", { name: space.name })}
            className="absolute top-10 bottom-0 left-0 z-30 flex w-[280px] flex-col border-r border-rule-strong bg-surface shadow-[0_12px_32px_-8px_oklch(0_0_0/0.4)]"
          >
            <div className="min-h-0 flex-1 overflow-y-auto">{treeBody}</div>
          </aside>
        )}
      </div>
    </SpaceContext.Provider>
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

  return (
    <article className="event-enter flex flex-col">
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
        <p className="mt-4 line-clamp-3 max-w-[72ch] text-md text-ink">{space.brief.identity}</p>
      )}
      {/* Task 3: «Read the brief» porta al brief del repository. */}

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
            <ul aria-label={t("docs.groups.categories")} className="border-t border-rule">
              {(tree.data ?? []).map((c) => {
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
