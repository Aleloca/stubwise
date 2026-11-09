import { Link, Outlet, useNavigate, useParams, useSearch } from "@tanstack/react-router";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { flushSync } from "react-dom";
import {
  useProject,
  useProductComments,
  useProductMarks,
  useProductPage,
  useProductPresence,
  useProductSpace,
  useSessionPersonId,
} from "../../data/queries";
import type { ProductMarkView, ProductPageView, ProductSpaceView, Project } from "../../data/types";
import { DOCKED_PANEL_QUERY } from "../../layout/useDetailPanel";
import { useMediaQuery } from "../../layout/useMediaQuery";
import { openPalette } from "../../layout/useShortcuts";
import { Chevron, itemClass, Menu, MenuGroup } from "../../tasks-ui/Menu";
import { PageError } from "../../tasks-ui/PageStates";
import { useToast } from "../../tasks-ui/Toast";
import { copyText } from "../../tasks-ui/exportFile";
import { MoreIcon } from "../task/parts";
import { DocTreeSkeleton } from "../docs/DocTree";
import { Resizer, TREE_DEFAULT } from "../docs/DocSpace";
import { DocsForbidden, ReadingSkeleton, isForbidden } from "../docs/parts";
import { ProductTree, type FocusRequest } from "./ProductTree";
import { SaveStatus } from "./SaveStatus";
import { PresenceAvatars } from "./live/PresenceAvatars";
import { FollowButton, pageBarButton } from "./FollowButton";
import { SideColumnFrame, useSideColumn, type SideColumn } from "./SideColumn";
import { CommentsColumn } from "./comments/CommentsColumn";
import { ClaudeWaitingLine } from "./claude/ClaudeWaitingLine";
import { FirstVersionUndoDialog } from "./claude/FirstVersionBanner";
import { PageClaudeGroup } from "./claude/ClaudePageGestures";
import type { BlockEditorHandle } from "./editor/BlockEditor";
import { HistoryPanel } from "./history/HistoryPanel";
import { ExportGroups, ExportMenu } from "./export/ExportMenu";
import { useProductExport } from "./export/exportProduct";
import { PrintView } from "./export/PrintView";
import { overflowingBarItems } from "../../domain/docs";
import { Spinner } from "../drive/glyphs";
import {
  type CommentsBridge,
  DeletePageDialog,
  type EditorStatus,
  type MarksBridge,
  ProductNotFound,
  ProductSpaceContext,
  useProductSpaceContext,
  firstVersionWayFreshKey,
  inSpace,
  isFresh,
  takeFresh,
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

/** Quanto la conferma di «Undo the first version» aspetta l'indice vuoto, prima di chiudersi da sola. */
const UNDO_HANDOFF_MS = 1500;

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

/**
 * Il pannello della task ha del testo che si perderebbe chiudendolo: un
 * campo con del testo (il commento nuovo, la sua risposta) o in modifica (un
 * commento, la descrizione). Si legge dal DOM del pannello: le bozze sono
 * stato dei suoi componenti, e questa è la sola domanda che lo spazio gli fa.
 */
function taskPanelHasText(): boolean {
  const panel = document.querySelector("[data-detail-panel]");
  if (!panel) return false;
  return [...panel.querySelectorAll<HTMLTextAreaElement | HTMLElement>("textarea, [contenteditable=true]")].some(
    (el) => (el instanceof HTMLTextAreaElement ? el.value : (el.textContent ?? "")).trim() !== "",
  );
}

function SpaceShell({ project, space }: { project: Project; space: ProductSpaceView }) {
  const { t } = useTranslation();
  const me = useSessionPersonId();
  const docked = useMediaQuery(DOCKED_PANEL_QUERY);
  const params = useParams({ strict: false }) as { page?: string };
  const search = useSearch({ strict: false }) as { comment?: string; task?: string; mark?: string; history?: string };
  const pageCode = params.page ?? null;
  const [width, setWidth] = useState(TREE_DEFAULT);
  const [drawer, setDrawer] = useState(false);
  const [expandNonce, setExpandNonce] = useState<{ pageId: string; nonce: number } | null>(null);
  const [focusRequest, setFocusRequest] = useState<FocusRequest | null>(null);
  const [editorStatus, setEditorStatus] = useState<EditorStatus | null>(null);
  const pagesButton = useRef<HTMLButtonElement>(null);
  const commentsButton = useRef<HTMLButtonElement>(null);
  const historyButton = useRef<HTMLButtonElement>(null);
  const moreButton = useRef<HTMLButtonElement>(null);
  const drawerRef = useRef<HTMLElement>(null);
  const root = useRef<HTMLDivElement>(null);
  /** L'editor della pagina aperta: «Draw this screen» del «⋯» (11b, Task 12). */
  const editorRef = useRef<BlockEditorHandle | null>(null);

  // La pagina aperta (la stessa lettura della vista: la cache la condivide).
  const openPage = useProductPage(pageCode ?? "", { enabled: pageCode !== null });
  const gone = pageCode !== null && openPage.data !== undefined && !inSpace(openPage.data, project);
  const view = pageCode && openPage.data && inSpace(openPage.data, project) ? openPage.data : null;

  // La colonna a destra (commenti o cronologia, [PE 19]) e il ponte col testo.
  const side = useSideColumn({
    personId: me,
    page: view,
    commentParam: search.comment,
    historyParam: search.history,
    taskOpen: !!search.task,
    docked,
  });
  // Agganciata, un gesto dei commenti (o «History») vince sul pannello della
  // task, che ne occupa il posto: una colonna sola ([PE 19]), l'ultima aperta.
  // Sovrapposta il pannello resta montato dietro ([PE 22]).
  const navigate = useNavigate();
  const raisedSeen = useRef(0);
  // Il pannello si chiude con un passo nuovo nella cronologia (Indietro lo
  // riporta). Se ha del testo non salvato (un commento a metà, uno in
  // modifica, la descrizione aperta) NON si chiude: resta, la colonna aspetta
  // dietro di lui (si apre alla sua chiusura) e un avviso lo dice. Scelta del
  // fix round 2: perdere in silenzio un testo scritto altrove è peggio di un
  // gesto che chiede un passo in più.
  const toast = useToast();
  useEffect(() => {
    if (side.raised === raisedSeen.current) return;
    raisedSeen.current = side.raised;
    if (!docked || !search.task) return;
    if (taskPanelHasText()) {
      toast.show(t("productDocs.comments.behindTask", { code: search.task }));
      return;
    }
    void navigate({
      to: ".",
      search: (prev: Record<string, unknown>) => ({ ...prev, task: undefined }),
    } as never);
  }, [side.raised, docked, search.task, navigate, toast, t]);
  const comments = useProductComments(view?.id ?? "", { enabled: view !== null });
  const bridge = ((): CommentsBridge | null => {
    if (!view) return null;
    const open = comments.data?.open ?? [];
    const counts = new Map<string, number>();
    for (const th of open) if (!th.anchorGone) counts.set(th.root.anchorId, (counts.get(th.root.anchorId) ?? 0) + 1);
    const activeThread = side.active ? open.find((th) => th.root.id === side.active && !th.anchorGone) : undefined;
    return {
      counts,
      activeAnchor: side.side === "comments" ? (side.draft?.anchorId ?? activeThread?.root.anchorId ?? null) : null,
      canComment: view.permissions.edit,
      start: side.start,
      openAnchor: (ids) => {
        const th = open.find((x) => !x.anchorGone && ids.includes(x.root.anchorId));
        if (th) side.focusThread(th.root.id);
      },
    };
  })();
  // I segni di Claude della pagina aperta (11b, Task 9): la nota aperta è
  // una per pagina e per persona; `?mark=<ancora>` la apre (una volta) col
  // fuoco sulla sua prima riga. L'annuncio vive qui: dopo «Looks good» il
  // segno se ne va, e l'annuncio con lui no.
  const marksQuery = useProductMarks(view?.id ?? "", { enabled: view !== null });
  const marksKey = view ? `${me}:${view.id}` : null;
  const [openMark, setOpenMark] = useState<{ key: string | null; blockId: string; n: number } | null>(null);
  const markSeq = useRef(0);
  const markParamSeen = useRef<string | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const client = useQueryClient();
  // Lo stesso annuncio due volte di fila si rilegge: la regione si svuota, poi
  // al frame dopo riceve il testo (Fix round 1).
  const announceTimer = useRef<number | null>(null);
  const announce = useCallback((text: string) => {
    // Lo svuotamento si scrive subito nel DOM (non insieme al testo nuovo).
    flushSync(() => setAnnouncement(""));
    if (announceTimer.current !== null) cancelAnimationFrame(announceTimer.current);
    announceTimer.current = requestAnimationFrame(() => {
      announceTimer.current = null;
      setAnnouncement(text);
    });
  }, []);
  useEffect(
    () => () => {
      if (announceTimer.current !== null) cancelAnimationFrame(announceTimer.current);
    },
    [],
  );
  useEffect(() => {
    if (!marksKey || !search.mark || !marksQuery.data) return;
    const seen = `${marksKey}:${search.mark}`;
    if (markParamSeen.current === seen) return;
    markParamSeen.current = seen;
    const found = marksQuery.data.find((m) => m.anchorId === search.mark || m.blockId === search.mark);
    if (found) setOpenMark({ key: marksKey, blockId: found.blockId, n: ++markSeq.current });
  }, [marksKey, search.mark, marksQuery.data]);
  const marksBridge = ((): MarksBridge | null => {
    if (!view) return null;
    const byBlock = new Map<string, ProductMarkView[]>();
    for (const m of marksQuery.data ?? []) byBlock.set(m.blockId, [...(byBlock.get(m.blockId) ?? []), m]);
    const open = openMark && openMark.key === marksKey && byBlock.has(openMark.blockId) ? openMark : null;
    return {
      pageId: view.id,
      byBlock,
      failed: marksQuery.isError,
      retry: () => void marksQuery.refetch(),
      open: open ? { blockId: open.blockId, n: open.n } : null,
      setOpen: (blockId) =>
        setOpenMark(blockId ? { key: marksKey, blockId, n: ++markSeq.current } : null),
      hasBlock: (blockId) => {
        const fresh = client.getQueryData<ProductPageView | null>(["as", me, "productDocs", "page", view.code]);
        return (fresh ?? view).blocks.some((b) => b.id === blockId);
      },
      announce,
      seeHistory: (revisionId) => side.openHistory(revisionId),
    };
  })();
  // «Undo the first version?» (11b, Task 11): la conferma vive qui, non
  // nella pagina, perché confermata le pagine se ne vanno. Annullata, lo
  // spazio torna all'indice e la conferma resta aperta (col fuoco) finché
  // l'indice non ha messo il fuoco sulla prima strada e preso il segno: la
  // lettura dello spazio può arrivare un giro dopo l'indirizzo. Gli effetti
  // di layout dei figli vengono prima: il fuoco non passa mai dal body.
  // Se la strada non arriva (la lettura dello spazio non torna vuota: una
  // pagina nata nel frattempo, una lettura fallita), la conferma non resta
  // su «Undoing…»: dopo `UNDO_HANDOFF_MS` si chiude da sola, e chiusa a mano
  // (Cancel, Esc) mette il fuoco sull'h1 della lettura quando il bottone da
  // cui era partita non c'è più; il segno si toglie sempre (fix round 1, M1).
  const [undoAsk, setUndoAsk] = useState<"ask" | "undone" | null>(null);
  const undoOrigin = useRef<HTMLElement | null>(null);
  const askUndoFirstVersion = useCallback(() => {
    undoOrigin.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setUndoAsk("ask");
  }, []);
  const closeUndo = useCallback(() => {
    if (!undoOrigin.current?.isConnected) root.current?.querySelector<HTMLElement>("h1")?.focus();
    takeFresh(firstVersionWayFreshKey(project.code));
    setUndoAsk(null);
  }, [project.code]);
  useEffect(() => {
    if (undoAsk !== "undone") return;
    const timer = window.setTimeout(closeUndo, UNDO_HANDOFF_MS);
    return () => window.clearTimeout(timer);
  }, [undoAsk, closeUndo]);
  const onFirstVersionUndone = () => {
    markFresh(firstVersionWayFreshKey(project.code));
    setUndoAsk("undone");
    void navigate(productIndexLink(project.code));
  };
  useLayoutEffect(() => {
    if (undoAsk === "undone" && pageCode === null && !isFresh(firstVersionWayFreshKey(project.code)))
      setUndoAsk(null);
  }, [undoAsk, pageCode, space, project.code]);

  // A 1440 il pannello della task prende il posto della colonna, che torna alla sua chiusura.
  const sideShown = view !== null && side.side !== null && !(docked && !!search.task);
  const sideDocked = sideShown && docked;

  // [PE 20]: con la colonna agganciata, se la lettura scendesse sotto 520 px
  // l'albero passa a cassetto finché la colonna è aperta.
  const [rootWidth, setRootWidth] = useState(0);
  useEffect(() => {
    const el = root.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => setRootWidth(el.getBoundingClientRect().width));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  const treeDocked = docked && !(sideDocked && rootWidth > 0 && rootWidth - width - 296 < 520);

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
    if (treeDocked) return;
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
  }, [treeDocked, drawer, closeDrawer]);

  // Una pagina che diventa «non trovata» (eliminata da un altro, permesso
  // perso) chiude il cassetto ([PS 20]); il fuoco che c'era dentro va su «Pages».
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
      onNavigate={treeDocked ? undefined : () => closeDrawer(true)}
    />
  );

  // Chiudere la colonna riporta il fuoco al suo bottone nella barra ([PC 13]);
  // se il bottone è passato nel «⋯» ([PS 10]), al «⋯».
  const closeComments = () => {
    side.closeComments();
    (commentsButton.current ?? moreButton.current)?.focus();
  };
  const closeHistory = () => {
    side.closeHistory();
    (historyButton.current ?? moreButton.current)?.focus();
  };
  const sideContent =
    view && side.side === "comments" ? (
      <CommentsColumn
        key={view.id}
        page={view}
        project={project}
        mode={docked ? "docked" : "overlay"}
        draft={side.draft}
        focus={side.focus}
        active={side.active}
        onClose={closeComments}
        onEndDraft={side.endDraft}
        onActive={side.setActive}
        onFocusThread={side.focusThread}
      />
    ) : view && side.side === "history" ? (
      <HistoryPanel
        key={view.id}
        page={view}
        onClose={closeHistory}
        focus={side.historyFocus}
        onSeeQuestion={(rootId) => side.focusThread(rootId)}
        announce={announce}
      />
    ) : null;

  return (
    <ProductSpaceContext.Provider
      value={{
        project,
        space,
        reveal,
        setEditorStatus,
        comments: bridge,
        marks: marksBridge,
        askUndoFirstVersion,
        editor: editorRef,
      }}
    >
      <div ref={root} className="relative flex h-full min-h-0 flex-col">
        <span aria-live="polite" data-marks-announce="" className="sr-only">
          {announcement}
        </span>
        <SpaceBar
          project={project}
          pageCode={pageCode}
          docked={treeDocked}
          narrow={!docked}
          pagesButton={treeDocked ? null : pagesButton}
          drawer={drawer}
          onPages={() => (drawer ? closeDrawer(false) : setDrawer(true))}
          onDeleted={(parentId) => focusNode(parentId)}
          editorStatus={editorStatus}
          side={side}
          sideShown={sideShown}
          commentsButton={commentsButton}
          historyButton={historyButton}
          moreButton={moreButton}
          pageCount={space.pageCount}
        />
        <ClaudeWaitingLine projectId={project.id} />
        <div className="flex min-h-0 flex-1">
          {treeDocked && (
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
            {/* La lettura e, agganciata, la colonna dei commenti: scorrono insieme, così i fili stanno accanto ai blocchi. */}
            <div className="flex min-h-full">
              <div className="min-w-0 flex-1">
                {/* La colonna di lettura: ≤ 720, centrata nel residuo, 48 px a sinistra per le maniglie dei blocchi. */}
                <div className="mx-auto w-full max-w-[816px] pr-8 pb-16 pl-12">
                  <Outlet />
                </div>
              </div>
              {sideShown && docked && (
                <SideColumnFrame mode="docked" front>
                  {sideContent}
                </SideColumnFrame>
              )}
            </div>
          </div>
        </div>
        {sideShown && !docked && (
          <SideColumnFrame mode="overlay" front={side.front}>
            {sideContent}
          </SideColumnFrame>
        )}
        {undoAsk !== null && (
          <FirstVersionUndoDialog
            project={project}
            onClose={closeUndo}
            onUndone={onFirstVersionUndone}
          />
        )}
        {!treeDocked && drawer && (
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

/** I gesti della pagina che possono finire nel «⋯», dal più importante ([PS 10]). */
const OPTIONAL_PAGE_BAR = ["comments", "history", "export"] as const;
type OptionalPageItem = (typeof OPTIONAL_PAGE_BAR)[number];
/** L'ultima briciola non scende sotto questa larghezza (il titolo, con l'ellissi). */
const LAST_CRUMB_MIN = 96;
const BAR_GAP = 4;

/**
 * La barra dello spazio (40 px, una sola per spazio e pagina, [PS 8]): a
 * sinistra «Pages» (sotto i 1200, o quando la colonna laterale la chiede,
 * [PE 20]), «Product» e le briciole della pagina aperta; a destra i gesti
 * della pagina, nell'ordine di [PS 8]: lo stato di salvataggio dell'editor,
 * gli avatar degli altri presenti (Task 11), Follow, Comments N (i fili aperti), History,
 * «Export ▾» (Task 12), il «⋯» (Copy link, Delete page… per chi scrive).
 * Sull'indice «Search ⌘K» ed «Export ▾» col solo WHOLE SPACE (se ci sono pagine).
 * Una pagina che non c'è perde i gesti e le briciole.
 *
 * La barra non va a capo ([PS 10]): si misura come quella dello spazio di un
 * repository (`OPTIONAL_BAR` di `DocSpace`), con una copia invisibile dei
 * gesti che possono uscire. Prima le briciole intermedie diventano «…» (solo
 * se l'ultima scenderebbe sotto i 96 px); poi Export, History e Comments, in
 * quest'ordine, passano nel «⋯», che resta sempre. Restano sempre «Pages»,
 * «Product», l'ultima briciola, lo stato di salvataggio, gli avatar (a 1024
 * al più 2 e «+N») e Follow.
 */
function SpaceBar({
  project,
  pageCode,
  docked,
  narrow,
  pagesButton,
  drawer,
  onPages,
  onDeleted,
  editorStatus,
  side,
  sideShown,
  commentsButton,
  historyButton,
  moreButton,
  pageCount,
}: {
  project: Project;
  pageCode: string | null;
  docked: boolean;
  /** Sotto i 1200 px: gli avatar al più 2 e «+N» ([PS 10]). */
  narrow: boolean;
  pagesButton: RefObject<HTMLButtonElement | null> | null;
  drawer: boolean;
  onPages: () => void;
  onDeleted: (parentId: string | null) => void;
  editorStatus: EditorStatus | null;
  side: SideColumn;
  sideShown: boolean;
  commentsButton: RefObject<HTMLButtonElement | null>;
  historyButton: RefObject<HTMLButtonElement | null>;
  moreButton: RefObject<HTMLButtonElement | null>;
  /** Le pagine dello spazio, per «9 pages, in tree order» del menu Export. */
  pageCount: number;
}) {
  const { t, i18n } = useTranslation();
  // La stessa lettura della pagina aperta (la cache la condivide con la vista).
  const page = useProductPage(pageCode ?? "", { enabled: pageCode !== null });
  const view = pageCode && page.data && inSpace(page.data, project) ? page.data : null;
  const nav = useRef<HTMLElement>(null);
  const keep = useRef<HTMLSpanElement>(null);
  const measure = useRef<HTMLDivElement>(null);
  // Prima di una misura (o dove non si impagina) vale la regola di prima:
  // nessun gesto nel «⋯», briciole corte quando l'albero è un cassetto.
  const [fit, setFit] = useState<{ hidden: readonly OptionalPageItem[]; compact: boolean } | null>(null);

  const measureBar = useCallback(() => {
    const bar = nav.current;
    const copy = measure.current;
    if (!bar || !copy || bar.clientWidth === 0) return;
    const width = (el: Element | null | undefined) => (el instanceof HTMLElement ? el.offsetWidth : 0);
    const copyWidth = (id: string) => width(copy.querySelector(`[data-bar="${id}"]`));
    const style = getComputedStyle(bar);
    const available =
      bar.clientWidth - (parseFloat(style.paddingLeft) || 0) - (parseFloat(style.paddingRight) || 0);
    // Ciò che resta sempre: i pezzi segnati `data-bar-keep`, misurati dal vivo
    // (lo stato di salvataggio e gli avatar cambiano larghezza da soli).
    const kept = [...bar.querySelectorAll("[data-bar-keep]")].reduce((sum, el) => sum + width(el) + BAR_GAP, 0);
    const last = copyWidth("last");
    const lastMin = Math.min(last, copyWidth("separator") + LAST_CRUMB_MIN);
    const ellipsis = copyWidth("ellipsis");
    const optional = OPTIONAL_PAGE_BAR.map((id) => ({ id, width: copyWidth(id) }));
    const hidden = overflowingBarItems(available, kept + ellipsis + lastMin, optional, 0, BAR_GAP) as OptionalPageItem[];
    const shown = optional.filter((o) => !hidden.includes(o.id)).reduce((sum, o) => sum + o.width + BAR_GAP, 0);
    const room = available - kept - shown;
    const compact = room - copyWidth("ancestors") < lastMin;
    setFit((prev) =>
      prev && prev.compact === compact && prev.hidden.join() === hidden.join() ? prev : { hidden, compact },
    );
  }, []);

  // Si rimisura quando cambia ciò che occupa la barra (lingua, briciole,
  // numero dei commenti, stato di salvataggio, chi è presente: la stessa
  // lettura degli avatar) e a ogni cambio di larghezza.
  const ancestors = view?.breadcrumbs.map((a) => a.title).join("/") ?? "";
  const presentCount = useProductPresence(view?.id ?? "", { enabled: view !== null }).data?.length ?? 0;
  const saveState = editorStatus
    ? `${editorStatus.state} ${editorStatus.skipped} ${editorStatus.dropped}`
    : "";
  useLayoutEffect(measureBar, [
    measureBar,
    i18n.language,
    view?.title,
    ancestors,
    view?.openComments,
    pagesButton,
    presentCount,
    saveState,
  ]);
  const hasView = view !== null;
  useEffect(() => {
    const els = [nav.current, keep.current].filter((el): el is HTMLElement => el !== null);
    if (els.length === 0 || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => measureBar());
    for (const el of els) observer.observe(el);
    return () => observer.disconnect();
  }, [measureBar, hasView]);

  const hidden = view ? (fit?.hidden ?? []) : [];
  const shows = (id: OptionalPageItem) => !hidden.includes(id);
  const compact = fit ? fit.compact : !docked;
  const separator = <span className="px-0.5">›</span>;

  return (
    <nav
      ref={nav}
      aria-label={t("productDocs.space.bar", { code: project.code })}
      className="page-header relative flex min-h-10 shrink-0 items-center gap-1 border-b border-rule pl-3 [--page-header-pr:16px]"
    >
      {/* La copia da misurare: i gesti che possono uscire e le briciole,
          invisibile, fuori dal flusso e dentro una scatola di 0 px. */}
      {view && (
        <div aria-hidden="true" className="absolute top-0 left-0 h-0 w-0 overflow-hidden">
          <div
            ref={measure}
            inert
            className="pointer-events-none invisible flex w-max items-center gap-1 text-sm whitespace-nowrap"
          >
            <span data-bar="separator">{separator}</span>
            <span data-bar="ellipsis" className="flex">
              {view.breadcrumbs.length > 0 && (
                <>
                  {separator}
                  <span className="px-1">…</span>
                </>
              )}
            </span>
            <span data-bar="ancestors" className="flex">
              {view.breadcrumbs.map((a) => (
                <span key={a.id} className="flex">
                  {separator}
                  <span className="max-w-[160px] truncate px-1">{a.title}</span>
                </span>
              ))}
            </span>
            <span data-bar="last" className="flex">
              {separator}
              <span className="px-1">{view.title}</span>
            </span>
            <span data-bar="comments" className={pageBarButton}>
              <CommentGlyph />
              {t("productDocs.space.comments")}
              {view.openComments > 0 && <span className="num">{view.openComments}</span>}
            </span>
            <span data-bar="history" className={pageBarButton}>
              <HistoryGlyph />
              {t("productDocs.space.history")}
            </span>
            <span data-bar="export" className={pageBarButton}>
              {t("productDocs.export.button")}
              <Chevron />
            </span>
          </div>
        </div>
      )}
      {pagesButton && (
        <button
          ref={pagesButton}
          type="button"
          data-bar-keep=""
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
        data-bar-keep=""
        activeOptions={{ exact: true }}
        className="inline-flex h-7 shrink-0 items-center rounded-md px-2 text-md font-semibold text-ink transition-colors duration-[var(--duration-fast)] ease-out hover:bg-ink/6"
      >
        {t("productDocs.space.title")}
      </Link>
      {view && <Breadcrumbs project={project} page={view} compact={compact} />}
      <span ref={keep} className="ml-auto flex shrink-0 items-center gap-1">
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
        {pageCode === null && pageCount > 0 && <ExportMenu project={project} page={null} pageCount={pageCount} />}
        {view && editorStatus && (
          <span data-bar-keep="" className="flex shrink-0">
            <SaveStatus status={editorStatus} />
          </span>
        )}
        {view && (
          <span data-bar-keep="" className="flex shrink-0">
            <PresenceAvatars page={view} max={narrow ? 2 : 4} />
          </span>
        )}
        {view && (
          <span data-bar-keep="" className="flex shrink-0">
            <FollowButton page={view} />
          </span>
        )}
        {view && shows("comments") && (
          <button
            ref={commentsButton}
            type="button"
            aria-pressed={sideShown && side.side === "comments"}
            onClick={side.toggleComments}
            className={pageBarButton}
          >
            <CommentGlyph />
            {t("productDocs.space.comments")}
            {view.openComments > 0 && <span className="num text-ink-faint">{view.openComments}</span>}
          </button>
        )}
        {view && shows("history") && (
          <button
            ref={historyButton}
            type="button"
            aria-pressed={sideShown && side.side === "history"}
            onClick={side.toggleHistory}
            className={pageBarButton}
          >
            <HistoryGlyph />
            {t("productDocs.space.history")}
          </button>
        )}
        {view && shows("export") && (
          <ExportMenu
            key={view.id}
            project={project}
            page={{ id: view.id, code: view.code, title: view.title }}
            pageCount={pageCount}
          />
        )}
        {view && (
          <PageMenu
            project={project}
            page={view}
            docked={docked}
            onDeleted={onDeleted}
            button={moreButton}
            overflow={hidden}
            side={side}
            sideShown={sideShown}
            pageCount={pageCount}
          />
        )}
      </span>
    </nav>
  );
}

function CommentGlyph() {
  return (
    <svg viewBox="0 0 16 16" width={16} height={16} fill="none" stroke="currentColor" strokeWidth={1.4} strokeLinejoin="round" aria-hidden="true" focusable="false" className="shrink-0">
      <path d="M2.75 3.75h10.5v7h-5.5l-3 2.5v-2.5h-2Z" />
    </svg>
  );
}

function HistoryGlyph() {
  return (
    <svg viewBox="0 0 16 16" width={16} height={16} fill="none" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false" className="shrink-0">
      <path d="M2.75 8a5.25 5.25 0 1 0 1.6-3.77" />
      <path d="M2.5 2.75v2.5H5" />
      <path d="M8 5.25V8l2 1.5" />
    </svg>
  );
}

/**
 * Le briciole («Features › Sign-in»), `ink-muted`: ogni antenato porta alla
 * sua pagina; le intermedie si accorciano con l'ellissi, e quando l'ultima
 * scenderebbe sotto i 96 px (la misura della barra) restano solo «…» e
 * l'ultima, il titolo intero nel `title`.
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
          <span aria-current="page" title={page.title} className="min-w-[60px] truncate px-1 text-ink">
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
 * l'indice) e il fuoco va al suo nodo. Quando la barra non ci sta ([PS 10])
 * in testa ci sono i gesti usciti, in quest'ordine: «Comments (2)»,
 * «History», poi i gruppi dell'esportazione. Resta sempre nella barra.
 */
function PageMenu({
  project,
  page,
  docked,
  onDeleted,
  button,
  overflow,
  side,
  sideShown,
  pageCount,
}: {
  project: Project;
  page: ProductPageView;
  docked: boolean;
  onDeleted: (parentId: string | null) => void;
  button: RefObject<HTMLButtonElement | null>;
  overflow: readonly OptionalPageItem[];
  side: SideColumn;
  sideShown: boolean;
  pageCount: number;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const navigate = useNavigate();
  const { editor } = useProductSpaceContext();
  const [open, setOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const parent = page.breadcrumbs.at(-1) ?? null;
  // L'esportazione dal «⋯» (quando «Export ▾» non ci sta): il fuoco torna qui.
  const exporting = useProductExport({
    projectId: project.id,
    projectCode: project.code,
    page: { id: page.id, code: page.code, title: page.title },
    button,
  });
  const copyLink = () =>
    copyText(productPageHref(project.code, page.code)).then(
      () => toast.show(t("docs.page.linkCopied", { code: page.code })),
      () => toast.error(t("docs.page.copyFailed")),
    );
  const close = (restore: boolean) => {
    setOpen(false);
    if (restore) button.current?.focus();
  };
  const has = (id: OptionalPageItem) => overflow.includes(id);
  const more = t("productDocs.space.more");
  return (
    <>
      {/* Aperto, il menu sta sopra la colonna dei commenti sovrapposta (z-45, sotto i 1200). */}
      <span data-bar-keep="" className={`relative inline-flex shrink-0 ${open ? "z-50" : ""}`}>
        <button
          ref={button}
          type="button"
          aria-haspopup="menu"
          aria-expanded={open}
          aria-label={exporting.busy ? `${more} · ${t("productDocs.export.preparing")}` : more}
          title={more}
          onClick={() => setOpen((o) => !o)}
          className="grid size-7 shrink-0 place-items-center rounded-md text-ink-muted transition-colors duration-[var(--duration-fast)] ease-out hover:bg-ink/6 hover:text-ink aria-expanded:bg-ink/10 aria-expanded:text-ink"
        >
          {exporting.busy ? <Spinner /> : <MoreIcon />}
        </button>
        {open && (
          <Menu label={more} onClose={close} align="right">
            {(has("comments") || has("history")) && (
              <MenuGroup>
                {has("comments") && (
                  <button
                    type="button"
                    role="menuitemcheckbox"
                    aria-checked={sideShown && side.side === "comments"}
                    className={itemClass}
                    onClick={() => {
                      close(true);
                      side.toggleComments();
                    }}
                  >
                    {page.openComments > 0
                      ? t("productDocs.space.commentsCount", { count: page.openComments })
                      : t("productDocs.space.comments")}
                  </button>
                )}
                {has("history") && (
                  <button
                    type="button"
                    role="menuitemcheckbox"
                    aria-checked={sideShown && side.side === "history"}
                    className={itemClass}
                    onClick={() => {
                      close(true);
                      side.toggleHistory();
                    }}
                  >
                    {t("productDocs.space.history")}
                  </button>
                )}
              </MenuGroup>
            )}
            {has("export") && (
              <div role="group" aria-label={t("productDocs.export.menu")} className="flex flex-col">
                <ExportGroups
                  hasPage
                  pageCount={pageCount}
                  busy={exporting.busy}
                  onChoose={(scope, format) => {
                    close(true);
                    void exporting.start(scope, format);
                  }}
                />
              </div>
            )}
            {/* I gesti di Claude (11b, [PB 2]): per chi scrive, prima di Copy link. */}
            {page.permissions.edit && (
              <PageClaudeGroup page={page} close={() => close(true)} onDraw={() => editor?.current?.drawScreen()} />
            )}
            <MenuGroup>
              <button
                type="button"
                role="menuitem"
                className={itemClass}
                onClick={() => {
                  close(true);
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
                      close(true);
                      setDeleting(true);
                    }}
                  >
                    {t("productDocs.space.deletePage")}
                  </button>
                ) : null)}
            </MenuGroup>
          </Menu>
        )}
        {exporting.printing && <PrintView doc={exporting.printing} label={t("productDocs.export.printLabel")} />}
      </span>
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
