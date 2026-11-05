import { Link, Outlet, useNavigate, useParams } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import { useProject, useProductPage, useProductSpace } from "../../data/queries";
import type { ProductPageView, ProductSpaceView, Project } from "../../data/types";
import { DOCKED_PANEL_QUERY } from "../../layout/useDetailPanel";
import { useMediaQuery } from "../../layout/useMediaQuery";
import { openPalette } from "../../layout/useShortcuts";
import { itemClass } from "../../tasks-ui/Menu";
import { PageError } from "../../tasks-ui/PageStates";
import { useToast } from "../../tasks-ui/Toast";
import { copyText } from "../../tasks-ui/exportFile";
import { MoreIcon } from "../task/parts";
import { MenuButton } from "../tasks/controls";
import { DocTreeSkeleton } from "../docs/DocTree";
import { Resizer, TREE_DEFAULT } from "../docs/DocSpace";
import { DocsForbidden, ReadingSkeleton, isForbidden } from "../docs/parts";
import { ProductTree, type FocusRequest } from "./ProductTree";
import {
  DeletePageDialog,
  ProductNotFound,
  ProductSpaceContext,
  inSpace,
  indexFreshKey,
  markFresh,
  productIndexLink,
  productPageHref,
  productPageLink,
} from "./parts";

// Lo spazio Prodotto (shape product-space.md §3.4): la stessa ossatura dello
// spazio di un repository — una barra sola da 40 px, l'albero a sinistra
// (240, ridimensionabile 200–360; sotto i 1200 px un cassetto di 280 aperto
// da «Pages», ⌘\) e la colonna di lettura. Lo spazio resta montato fra
// indice e pagine: l'albero non si muove, cambia solo la lettura.
//
// Un progetto che chi guarda non vede, uno che non esiste e uno col modulo
// Docs spento rispondono allo stesso modo ([PS 20], R-G5): la pagina non c'è.

const barItem =
  "inline-flex h-7 min-w-0 shrink-0 items-center rounded-md px-2 text-sm font-medium whitespace-nowrap text-ink-muted transition-colors duration-[var(--duration-fast)] ease-out hover:bg-ink/6 hover:text-ink";

export function ProductSpace({ code }: { code: string }) {
  const { t } = useTranslation();
  const project = useProject(code);
  if (project.isError) {
    return (
      <div className="page-header pl-4 [--page-header-pt:16px]">
        <PageError message={t("project.error")} onRetry={() => void project.refetch()} />
      </div>
    );
  }
  if (project.isPending) return <SpaceSkeleton />;
  if (!project.data) return <Standalone code={code} />;
  return <SpaceGate project={project.data} />;
}

/** La pagina che non c'è, fuori dalla shell (nessuno spazio da mostrare). */
function Standalone({ code }: { code: string }) {
  return (
    <div className="page-header pl-8 [--page-header-pr:32px] [--page-header-pt:0px]">
      <ProductNotFound code={code} outside />
    </div>
  );
}

function SpaceSkeleton() {
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

function SpaceGate({ project }: { project: Project }) {
  const { t } = useTranslation();
  const space = useProductSpace(project.id);
  if (space.isError) {
    if (isForbidden(space.error)) return <DocsForbidden />;
    return (
      <div className="page-header pl-4 [--page-header-pt:16px]">
        <PageError
          message={t("productDocs.space.loadError")}
          onRetry={() => void space.refetch()}
        />
      </div>
    );
  }
  if (space.isPending) return <SpaceSkeleton />;
  if (!space.data) return <Standalone code={project.code} />;
  return <SpaceShell project={project} space={space.data} />;
}

function SpaceShell({ project, space }: { project: Project; space: ProductSpaceView }) {
  const { t } = useTranslation();
  const docked = useMediaQuery(DOCKED_PANEL_QUERY);
  const params = useParams({ strict: false }) as { page?: string };
  const pageCode = params.page ?? null;
  const [width, setWidth] = useState(TREE_DEFAULT);
  const [drawer, setDrawer] = useState(false);
  const [expandNonce, setExpandNonce] = useState<{ pageId: string; nonce: number } | null>(null);
  const [focusRequest, setFocusRequest] = useState<FocusRequest | null>(null);
  const pagesButton = useRef<HTMLButtonElement>(null);
  const drawerRef = useRef<HTMLElement>(null);

  const reveal = useCallback(
    (pageId: string) => setExpandNonce((prev) => ({ pageId, nonce: (prev?.nonce ?? 0) + 1 })),
    [],
  );
  const focusNode = useCallback(
    (pageId: string | null) =>
      setFocusRequest((prev) => ({ pageId, nonce: (prev?.nonce ?? 0) + 1 })),
    [],
  );

  const closeDrawer = useCallback((restore: boolean) => {
    setDrawer(false);
    if (restore) pagesButton.current?.focus();
  }, []);

  // ⌘\ apre e chiude il cassetto (solo quando l'albero non è affiancato); Esc
  // lo chiude, ma non se sopra c'è un dialogo o un menu; un clic fuori anche.
  useEffect(() => {
    if (docked) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "\\" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        if (drawer) closeDrawer(true);
        else setDrawer(true);
      } else if (e.key === "Escape" && drawer) {
        if (e.defaultPrevented || document.querySelector('[aria-modal="true"]')) return;
        e.preventDefault();
        closeDrawer(true);
      }
    };
    const onPointer = (e: PointerEvent) => {
      const target = e.target as Element;
      if (drawerRef.current?.contains(target) || pagesButton.current?.contains(target)) return;
      // Un menu o un dialogo aperto dal cassetto vive fuori (portal o sopra): non lo chiude.
      if (target.closest?.('[role="menu"], [role="dialog"]')) return;
      closeDrawer(false);
    };
    window.addEventListener("keydown", onKey);
    if (drawer) document.addEventListener("pointerdown", onPointer);
    return () => {
      window.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onPointer);
    };
  }, [docked, drawer, closeDrawer]);

  // Una pagina che diventa «non trovata» (eliminata da un altro, permesso
  // perso) chiude il cassetto ([PS 20]); il fuoco che c'era dentro va su «Pages».
  const openPage = useProductPage(pageCode ?? "", { enabled: pageCode !== null });
  const gone = pageCode !== null && openPage.data !== undefined && !inSpace(openPage.data, project);
  useEffect(() => {
    if (!gone || !drawer) return;
    closeDrawer(!!drawerRef.current?.contains(document.activeElement));
  }, [gone, drawer, closeDrawer]);

  // Aperto, il fuoco entra nel cassetto.
  useEffect(() => {
    const el = drawerRef.current;
    if (!drawer || !el || el.contains(document.activeElement)) return;
    el.querySelector<HTMLElement>('[role="treeitem"][tabindex="0"], button')?.focus();
  }, [drawer]);

  const tree = (
    <ProductTree
      project={project}
      space={space}
      currentCode={pageCode}
      expandRequest={expandNonce}
      focusRequest={focusRequest}
      onNavigate={docked ? undefined : () => closeDrawer(true)}
    />
  );

  return (
    <ProductSpaceContext.Provider value={{ project, space, reveal }}>
      <div className="relative flex h-full min-h-0 flex-col">
        <SpaceBar
          project={project}
          pageCode={pageCode}
          docked={docked}
          pagesButton={docked ? null : pagesButton}
          drawer={drawer}
          onPages={() => (drawer ? closeDrawer(false) : setDrawer(true))}
          onDeleted={(parentId) => focusNode(parentId)}
        />
        <div className="flex min-h-0 flex-1">
          {docked && (
            <aside
              aria-label={t("productDocs.space.treeLabel", { code: project.code })}
              style={{ width }}
              className="relative flex shrink-0 flex-col border-r border-rule"
            >
              <div className="min-h-0 flex-1 overflow-y-auto">{tree}</div>
              <Resizer width={width} onWidth={setWidth} />
            </aside>
          )}
          <div className="min-w-0 flex-1 overflow-y-auto">
            {/* La colonna di lettura: ≤ 720, centrata nel residuo, 48 px a sinistra per le maniglie dei blocchi. */}
            <div className="mx-auto w-full max-w-[816px] pr-8 pb-16 pl-12">
              <Outlet />
            </div>
          </div>
        </div>
        {!docked && drawer && (
          <aside
            ref={drawerRef}
            aria-label={t("productDocs.space.treeLabel", { code: project.code })}
            className="absolute top-10 bottom-0 left-0 z-30 flex w-[280px] flex-col border-r border-rule-strong bg-surface shadow-[0_12px_32px_-8px_oklch(0_0_0/0.4)]"
          >
            <div className="min-h-0 flex-1 overflow-y-auto">{tree}</div>
          </aside>
        )}
      </div>
    </ProductSpaceContext.Provider>
  );
}

/**
 * La barra dello spazio (40 px, una sola per spazio e pagina, [PS 8]): a
 * sinistra «Pages» (sotto i 1200), «Product» e le briciole della pagina
 * aperta; a destra i gesti della pagina. Nel 11a ci sono quelli che esistono
 * già: il «⋯» (Copy link, Delete page… per chi scrive); stato di
 * salvataggio, presenza, Follow, Comments, History ed Export arrivano coi
 * Task 8, 10, 11 e 12, in quest'ordine prima del «⋯». Sull'indice «Search ⌘K».
 * Una pagina che non c'è perde i gesti e le briciole.
 */
function SpaceBar({
  project,
  pageCode,
  docked,
  pagesButton,
  drawer,
  onPages,
  onDeleted,
}: {
  project: Project;
  pageCode: string | null;
  docked: boolean;
  pagesButton: RefObject<HTMLButtonElement | null> | null;
  drawer: boolean;
  onPages: () => void;
  onDeleted: (parentId: string | null) => void;
}) {
  const { t } = useTranslation();
  // La stessa lettura della pagina aperta (la cache la condivide con la vista).
  const page = useProductPage(pageCode ?? "", { enabled: pageCode !== null });
  const view = pageCode && page.data && inSpace(page.data, project) ? page.data : null;
  return (
    <nav
      aria-label={t("productDocs.space.bar", { code: project.code })}
      className="page-header relative flex min-h-10 shrink-0 items-center gap-1 border-b border-rule pl-3 [--page-header-pr:16px]"
    >
      {pagesButton && (
        <button
          ref={pagesButton}
          type="button"
          aria-expanded={drawer}
          aria-keyshortcuts="Meta+Backslash"
          title={`${t("docs.space.pagesToggle")} · ⌘\\`}
          onClick={onPages}
          className={`${barItem} aria-expanded:bg-ink/10 aria-expanded:text-ink`}
        >
          {t("docs.space.pagesToggle")}
        </button>
      )}
      <Link
        {...productIndexLink(project.code)}
        activeOptions={{ exact: true }}
        className="inline-flex h-7 shrink-0 items-center rounded-md px-2 text-md font-semibold text-ink transition-colors duration-[var(--duration-fast)] ease-out hover:bg-ink/6"
      >
        {t("productDocs.space.title")}
      </Link>
      {view && <Breadcrumbs project={project} page={view} compact={!docked} />}
      <span className="ml-auto flex shrink-0 items-center gap-1">
        {pageCode === null && (
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
        {view && <PageMenu project={project} page={view} docked={docked} onDeleted={onDeleted} />}
      </span>
    </nav>
  );
}

/**
 * Le briciole («Features › Sign-in»), `ink-muted`: ogni antenato porta alla
 * sua pagina; le intermedie si accorciano con l'ellissi (e a 1024 restano
 * solo «…» e l'ultima), il titolo intero nel `title`.
 */
function Breadcrumbs({
  project,
  page,
  compact,
}: {
  project: Project;
  page: ProductPageView;
  compact: boolean;
}) {
  const { t } = useTranslation();
  const ancestors = page.breadcrumbs;
  const separator = (
    <span aria-hidden="true" className="shrink-0 px-0.5 text-ink-faint">
      ›
    </span>
  );
  return (
    <nav aria-label={t("productDocs.space.breadcrumbs")} className="flex min-w-0 items-center">
      <ol className="flex min-w-0 items-center text-sm text-ink-muted">
        {compact && ancestors.length > 0 ? (
          <li className="flex shrink-0 items-center">
            {separator}
            <span title={ancestors.map((a) => a.title).join(" › ")} className="px-1">
              …
            </span>
          </li>
        ) : (
          ancestors.map((a) => (
            <li key={a.id} className="flex min-w-0 items-center">
              {separator}
              <Link
                {...productPageLink(project.code, a.code)}
                title={a.title}
                className="max-w-[160px] min-w-0 truncate rounded-sm px-1 hover:text-ink hover:underline"
              >
                {a.title}
              </Link>
            </li>
          ))
        )}
        <li className="flex min-w-0 items-center">
          {separator}
          <span aria-current="page" title={page.title} className="min-w-0 truncate px-1 text-ink">
            {page.title}
          </span>
        </li>
      </ol>
    </nav>
  );
}

/**
 * Il «⋯» della pagina: Copy link; Delete page… per chi può eliminare, spento
 * con la sua frase (senza «Who?»: è una regola) se ha sottopagine. Chi legge
 * soltanto ha solo Copy link. Dopo un'eliminazione si apre il genitore (o
 * l'indice) e il fuoco va al suo nodo.
 */
function PageMenu({
  project,
  page,
  docked,
  onDeleted,
}: {
  project: Project;
  page: ProductPageView;
  docked: boolean;
  onDeleted: (parentId: string | null) => void;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const navigate = useNavigate();
  const [deleting, setDeleting] = useState(false);
  const parent = page.breadcrumbs.at(-1) ?? null;
  const copyLink = () =>
    copyText(productPageHref(project.code, page.code)).then(
      () => toast.show(t("docs.page.linkCopied", { code: page.code })),
      () => toast.error(t("docs.page.copyFailed")),
    );
  return (
    <>
      <MenuButton
        menuLabel={t("productDocs.space.more")}
        ariaLabel={t("productDocs.space.more")}
        title={t("productDocs.space.more")}
        align="right"
        className="grid size-7 shrink-0 place-items-center rounded-md text-ink-muted transition-colors duration-[var(--duration-fast)] ease-out hover:bg-ink/6 hover:text-ink aria-expanded:bg-ink/10 aria-expanded:text-ink"
        wrapperClassName="inline-flex shrink-0"
        label={<MoreIcon />}
      >
        {(close) => (
          <>
            <button
              type="button"
              role="menuitem"
              className={itemClass}
              onClick={() => {
                close();
                void copyLink();
              }}
            >
              {t("productDocs.space.copyLink")}
            </button>
            {page.permissions.edit &&
              (page.permissions.deleteBlocked ? (
                <button
                  type="button"
                  role="menuitem"
                  aria-disabled="true"
                  className={`${itemClass} cursor-default flex-col items-start gap-0 hover:bg-transparent`}
                >
                  <span className="text-ink-muted">{t("productDocs.space.deletePage")}</span>
                  <span className="text-xs text-ink-muted">{t("productDocs.tree.hasChildren")}</span>
                </button>
              ) : page.permissions.delete ? (
                <button
                  type="button"
                  role="menuitem"
                  className={`${itemClass} text-critical`}
                  onClick={() => {
                    close();
                    setDeleting(true);
                  }}
                >
                  {t("productDocs.space.deletePage")}
                </button>
              ) : null)}
          </>
        )}
      </MenuButton>
      {deleting && (
        <DeletePageDialog
          page={page}
          onClose={() => setDeleting(false)}
          onDeleted={() => {
            setDeleting(false);
            // Il fuoco: col tree affiancato il nodo del genitore; nel cassetto
            // chiuso (sotto i 1200) l'h1 della pagina che si apre, il genitore o l'indice.
            if (docked) onDeleted(parent?.id ?? null);
            else markFresh(parent ? parent.code : indexFreshKey(project.code));
            void navigate({
              ...(parent ? productPageLink(project.code, parent.code) : productIndexLink(project.code)),
              replace: true,
            });
          }}
        />
      )}
    </>
  );
}
