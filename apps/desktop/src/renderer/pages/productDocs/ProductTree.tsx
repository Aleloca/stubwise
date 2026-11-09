import {
  DndContext,
  DragOverlay,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type Announcements,
  type DragEndEvent,
  type DragMoveEvent,
  type DragOverEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { SortableContext, useSortable } from "@dnd-kit/sortable";
import { useNavigate } from "@tanstack/react-router";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
} from "react";
import { useTranslation } from "react-i18next";
import { buildProductTree, canMoveUnder, flattenTree } from "../../domain/productDocs/tree";
import {
  ancestorsOf,
  findNode,
  moveAnnouncement,
  movedPages,
  projectDrop,
  siblingsOf,
  type FlatRow,
} from "../../domain/productDocs/treeMoves";
import {
  useMoveProductPage,
  useProductPage,
  useRenameProductPage,
} from "../../data/queries";
import type { ProductPageRef, ProductSpaceView, ProductTreeNode, Project } from "../../data/types";
import { Menu, itemClass } from "../../tasks-ui/Menu";
import { useToast } from "../../tasks-ui/Toast";
import { copyText } from "../../tasks-ui/exportFile";
import { MoreIcon, PlusIcon, ghostButton, smallSecondary } from "../task/parts";
import {
  DeletePageDialog,
  productPageHref,
  productPageLink,
  productIndexLink,
  useCreateAndOpen,
} from "./parts";

// L'albero dello spazio Prodotto (shape product-space.md §3.5, §6). Una lista
// piatta (`flattenTree`) con `aria-level`: `@dnd-kit/sortable` la riordina, e
// la profondità di arrivo viene dal movimento orizzontale (24 px = un
// livello). Da tastiera: ↑/↓, →/←, Invio apre, F2 rinomina, ⇧F10 apre il
// «⋯» (Move up, Move down, Indent, Outdent): nessuno spostamento fuori dal
// menu. Le voci impossibili sono spente con la loro frase; «Delete» legge
// `deleteBlocked` dalla vista della pagina, non lo ricalcola. Chi legge
// soltanto (`permissions.edit` falso) ha l'albero dei Docs: niente maniglie,
// niente «+», niente «⋯».

/** Oltre 4 livelli il rientro smette di crescere (la profondità resta in `aria-level`). */
const MAX_INDENT = 4;
/** Quanto resta l'avviso di uno spostamento non riuscito. */
const MOVE_ERROR_MS = 6000;
/** La sosta sopra una pagina chiusa che la apre durante il trascinamento. */
const HOVER_OPEN_MS = 600;

export interface FocusRequest {
  /** `null`: il primo nodo (dopo l'eliminazione di una radice). */
  pageId: string | null;
  nonce: number;
}

type Flat = FlatRow;

/** Nessuno spostamento delle righe durante il trascinamento (vedi [PS 12]). */
const stillRows = () => null;

const indentOf = (depth: number) => 20 + Math.min(depth, MAX_INDENT) * 12;

/** «+» e «⋯» del nodo: 20 px ciascuno, `ink-muted`. */
const nodeAction =
  "grid size-5 shrink-0 place-items-center rounded-sm text-ink-muted transition-colors duration-[var(--duration-fast)] ease-out hover:bg-ink/8 hover:text-ink aria-expanded:bg-ink/8 aria-expanded:text-ink disabled:opacity-50";

export function ProductTree({
  project,
  space,
  currentCode,
  expandRequest,
  focusRequest,
  onNavigate,
}: {
  project: Project;
  space: ProductSpaceView;
  /** La pagina aperta (il codice nell'indirizzo). */
  currentCode: string | null;
  /** Una pagina di cui aprire i genitori (cambia `nonce` per ripeterlo). */
  expandRequest: { pageId: string; nonce: number } | null;
  /** Un nodo a cui portare il fuoco (dopo un'eliminazione dalla barra). */
  focusRequest: FocusRequest | null;
  /** Dopo l'apertura di una pagina (il cassetto si chiude). */
  onNavigate?: () => void;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const toast = useToast();
  const move = useMoveProductPage();
  const rename = useRenameProductPage();
  const edit = space.permissions.edit;
  const root = useRef<HTMLUListElement>(null);

  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  // La posizione dopo uno spostamento, finché la lettura non torna (ottimistica).
  const [override, setOverride] = useState<ProductPageRef[] | null>(null);
  const [titles, setTitles] = useState<ReadonlyMap<string, string>>(() => new Map());
  const [moveError, setMoveError] = useState<{ title: string; retry: () => void } | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<ProductPageRef | null>(null);
  const [announce, setAnnounce] = useState("");
  const [pendingFocus, setPendingFocus] = useState<{
    pageId: string | null;
    /** Un nodo da non scegliere (quello appena eliminato). */
    skip?: string;
  } | null>(null);
  const [active, setActive] = useState<string | null>(null);
  const [drag, setDrag] = useState<{ activeId: string; overId: string | null; offsetX: number } | null>(
    null,
  );
  const [pendingExpand, setPendingExpand] = useState<string | null>(null);
  // Dal cassetto, «+» lo chiude come un'apertura: il fuoco va al titolo nuovo.
  const create = useCreateAndOpen(project, () => onNavigate?.());
  const newPage = useRef<HTMLButtonElement>(null);

  // Una lettura nuova (dopo una scrittura, anche altrui) sostituisce la
  // posizione ottimistica. Un titolo ottimistico resta finché la lettura non
  // ha il nome nuovo: una ricarica per un'altra ragione non fa tornare quello vecchio.
  useEffect(() => {
    setOverride(null);
    const base = new Map(flattenTree(space.tree).map((f) => [f.page.id, f.page.title]));
    setTitles((prev) => {
      const next = new Map([...prev].filter(([id, title]) => base.has(id) && base.get(id) !== title));
      return next.size === prev.size ? prev : next;
    });
  }, [space.tree]);

  useEffect(() => {
    if (!moveError) return;
    const timer = window.setTimeout(() => setMoveError(null), MOVE_ERROR_MS);
    return () => window.clearTimeout(timer);
  }, [moveError]);

  const basePages = flattenTree(space.tree).map((f) => f.page);
  const pages = (override ?? basePages).map((p) =>
    titles.has(p.id) ? { ...p, title: titles.get(p.id)! } : p,
  );
  const tree = buildProductTree(pages);
  const byId = new Map(pages.map((p) => [p.id, p]));
  const current = currentCode ? pages.find((p) => p.code === currentCode) : undefined;

  const expandAncestors = (pageId: string) => {
    const keys = ancestorsOf(pages, pageId);
    setCollapsed((prev) =>
      keys.some((k) => prev.has(k)) ? new Set([...prev].filter((k) => !keys.includes(k))) : prev,
    );
  };

  // La pagina aperta si vede sempre: i suoi genitori si aprono.
  const currentId = current?.id ?? null;
  useEffect(() => {
    // `expandAncestors` legge le pagine di questo giro: basta la pagina aperta.
    if (currentId) expandAncestors(currentId);
  }, [currentId]);

  useEffect(() => {
    if (expandRequest) setPendingExpand(expandRequest.pageId);
  }, [expandRequest]);
  useEffect(() => {
    if (!pendingExpand || !byId.has(pendingExpand)) return;
    expandAncestors(pendingExpand);
    setPendingExpand(null);
  });

  useEffect(() => {
    if (focusRequest) setPendingFocus({ pageId: focusRequest.pageId });
  }, [focusRequest]);
  // Il fuoco va al nodo chiesto appena c'è (anche dopo che si è spostato).
  useLayoutEffect(() => {
    if (!pendingFocus) return;
    // La pagina appena eliminata può esserci ancora finché la lettura non torna: non è un bersaglio.
    const items = [
      ...(root.current?.querySelectorAll<HTMLElement>("[role=treeitem]") ?? []),
    ].filter((el) => el.dataset.pageId !== pendingFocus.skip);
    // Nessun nodo (l'ultima pagina eliminata): «+ New page» in testa all'albero.
    const target =
      pendingFocus.pageId === null
        ? (items[0] ?? (space.pageCount === 0 ? newPage.current : null))
        : items.find((el) => el.dataset.pageId === pendingFocus.pageId);
    if (!target) return;
    target.focus();
    setPendingFocus(null);
  });

  // Le righe visibili: sotto una pagina chiusa (o sotto quella trascinata) niente.
  const visible: Flat[] = [];
  const walk = (nodes: readonly ProductTreeNode[], depth: number) => {
    for (const node of nodes) {
      visible.push({ page: node.page, depth, hasChildren: node.children.length > 0 });
      if (collapsed.has(node.page.id) || drag?.activeId === node.page.id) continue;
      walk(node.children, depth + 1);
    }
  };
  walk(tree, 0);

  const toggle = (pageId: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (!next.delete(pageId)) next.add(pageId);
      return next;
    });

  const open = (page: ProductPageRef) => {
    onNavigate?.();
    void navigate(productPageLink(project.code, page.code));
  };

  /** La frase di uno spostamento, dalla posizione nuova: prima del successivo, dopo il precedente, dentro il genitore. */
  function movedWords(next: readonly ProductPageRef[], page: ProductPageRef): string {
    const { kind, other } = moveAnnouncement(next, page.id);
    const key = { before: "movedBefore", after: "movedAfter", inside: "movedInside", alone: "moved" }[kind];
    return t(`productDocs.tree.${key}`, { title: page.title, other });
  }

  async function moveTo(page: ProductPageRef, parentId: string | null, index: number) {
    if (move.isPending) return;
    if (!canMoveUnder(pages, page.id, parentId)) return;
    const next = movedPages(pages, page.id, parentId, index);
    setOverride(next);
    setMoveError(null);
    if (parentId) setCollapsed((prev) => new Set([...prev].filter((k) => k !== parentId)));
    const ok = await move
      .mutateAsync({ pageId: page.id, parentId, index })
      .then(() => true)
      .catch(() => false);
    if (ok) {
      setAnnounce(movedWords(next, page));
      return;
    }
    // Non riuscito: la riga torna dov'era, con l'avviso e Retry in cima all'albero.
    setOverride(null);
    setMoveError({ title: page.title, retry: () => void moveTo(page, parentId, index) });
  }

  // --- il «⋯» del nodo -------------------------------------------------------

  function positionOf(page: ProductPageRef) {
    const sibs = siblingsOf(tree, page.parentId).map((n) => n.page);
    const index = sibs.findIndex((p) => p.id === page.id);
    const parent = page.parentId ? (byId.get(page.parentId) ?? null) : null;
    const parentIndex = parent
      ? siblingsOf(tree, parent.parentId).findIndex((n) => n.page.id === parent.id)
      : -1;
    return { sibs, index, above: sibs[index - 1] ?? null, parent, parentIndex };
  }

  const closeMenu = (pageId: string, restore: boolean) => {
    setMenuFor(null);
    if (restore) setPendingFocus({ pageId });
  };

  function onAction(page: ProductPageRef, action: NodeAction) {
    const pos = positionOf(page);
    closeMenu(page.id, true);
    switch (action) {
      case "rename":
        return setRenaming(page.id);
      case "subpage":
        return void addSubpage(page);
      case "up":
        return void moveTo(page, page.parentId, pos.index - 1);
      case "down":
        return void moveTo(page, page.parentId, pos.index + 1);
      case "indent":
        if (!pos.above) return;
        return void moveTo(page, pos.above.id, findNode(tree, pos.above.id)?.children.length ?? 0);
      case "outdent":
        if (!pos.parent) return;
        return void moveTo(page, pos.parent.parentId, pos.parentIndex + 1);
      case "copy":
        return void copyText(productPageHref(project.code, page.code)).then(
          () => toast.show(t("docs.page.linkCopied", { code: page.code })),
          () => toast.error(t("docs.page.copyFailed")),
        );
      case "delete":
        return setDeleting(page);
    }
  }

  async function addSubpage(parent: ProductPageRef) {
    setCollapsed((prev) => new Set([...prev].filter((k) => k !== parent.id)));
    await create.run(parent.id);
  }

  // --- rinominare ------------------------------------------------------------

  function finishRename(page: ProductPageRef, value: string | null) {
    setRenaming(null);
    setPendingFocus({ pageId: page.id });
    const title = value?.trim() ?? "";
    // Vuoto o uguale: torna al titolo di prima, senza scrivere.
    if (!title || title === page.title) return;
    setTitles((prev) => new Map(prev).set(page.id, title));
    rename.mutate(
      { pageId: page.id, title },
      {
        onSuccess: () => setAnnounce(t("productDocs.tree.renamed", { title })),
        onError: () => {
          setTitles((prev) => {
            const next = new Map(prev);
            next.delete(page.id);
            return next;
          });
          toast.error(t("productDocs.tree.renameFailed", { title: page.title }));
        },
      },
    );
  }

  // --- tastiera --------------------------------------------------------------

  function onKeyDown(e: KeyboardEvent<HTMLUListElement>) {
    const target = e.target as HTMLElement;
    // Solo sul nodo: i tasti del campo di rinomina, dei bottoni e del menu sono loro.
    if (target.getAttribute("role") !== "treeitem") return;
    const items = [...e.currentTarget.querySelectorAll<HTMLElement>("[role=treeitem]")];
    const at = items.indexOf(target);
    const flat = visible[at];
    if (!flat) return;
    const go = (i: number) => {
      e.preventDefault();
      items[Math.max(0, Math.min(items.length - 1, i))]?.focus();
    };
    const id = flat.page.id;
    const isOpen = flat.hasChildren && !collapsed.has(id);
    switch (e.key) {
      case "ArrowDown":
        return go(at + 1);
      case "ArrowUp":
        return go(at - 1);
      case "Home":
        return go(0);
      case "End":
        return go(items.length - 1);
      case "ArrowRight":
        if (!flat.hasChildren) return;
        e.preventDefault();
        if (!isOpen) toggle(id);
        else items[at + 1]?.focus();
        return;
      case "ArrowLeft":
        e.preventDefault();
        if (isOpen) return toggle(id);
        if (flat.page.parentId)
          items.find((el) => el.dataset.pageId === flat.page.parentId)?.focus();
        return;
      case "Enter":
      case " ":
        e.preventDefault();
        return open(flat.page);
      case "F2":
        if (!edit) return;
        e.preventDefault();
        return setRenaming(id);
      case "F10":
        if (!e.shiftKey || !edit) return;
        e.preventDefault();
        return setMenuFor(id);
      case "ContextMenu":
        if (!edit) return;
        e.preventDefault();
        return setMenuFor(id);
    }
  }

  // --- trascinare ------------------------------------------------------------

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));
  const projection =
    drag?.overId != null ? projectDrop(visible, drag.activeId, drag.overId, drag.offsetX) : null;
  const dragged = drag ? (byId.get(drag.activeId) ?? null) : null;
  const dropValid =
    !!projection && !!dragged && canMoveUnder(pages, dragged.id, projection.parentId);
  const latest = useRef({ projection, dropValid, dragged });
  latest.current = { projection, dropValid, dragged };
  // La linea d'arrivo ([PS 12]): solo per una destinazione possibile che
  // cambia qualcosa; sopra la riga d'arrivo se si sale, sotto se si scende,
  // sulla riga vuota d'origine se cambia solo il livello.
  const dropLine = (() => {
    if (!drag || !projection || !dropValid || !dragged || drag.overId === null) return null;
    const pos = positionOf(dragged);
    if (projection.parentId === dragged.parentId && projection.index === pos.index) return null;
    const from = visible.findIndex((f) => f.page.id === drag.activeId);
    const to = visible.findIndex((f) => f.page.id === drag.overId);
    const edge: "top" | "bottom" | "middle" = to < from ? "top" : to > from ? "bottom" : "middle";
    return { rowId: drag.overId, edge, depth: projection.depth };
  })();

  // La sosta di 600 ms sopra una pagina chiusa con sottopagine la apre.
  const overId = drag?.overId ?? null;
  useEffect(() => {
    if (!overId || !collapsed.has(overId)) return;
    const timer = window.setTimeout(() => toggle(overId), HOVER_OPEN_MS);
    return () => window.clearTimeout(timer);
  }, [overId, collapsed]);

  /** «Inside Features» / «After Sign-in» / «Before Sign-in»: dove cade la pagina. */
  function dropWords(): string | undefined {
    const { projection: p, dropValid: ok, dragged: page } = latest.current;
    if (!p || !ok || !page) return undefined;
    const target = movedPages(pages, page.id, p.parentId, p.index);
    const sibs = siblingsOf(buildProductTree(target), p.parentId).map((n) => n.page);
    const at = sibs.findIndex((x) => x.id === page.id);
    if (sibs[at - 1]) return t("productDocs.tree.dropAfter", { name: sibs[at - 1]!.title });
    const parent = p.parentId ? byId.get(p.parentId) : undefined;
    if (parent) return t("productDocs.tree.dropInside", { name: parent.title });
    if (sibs[at + 1]) return t("productDocs.tree.dropBefore", { name: sibs[at + 1]!.title });
    return undefined;
  }

  const announcements: Announcements = {
    onDragStart: () =>
      t("productDocs.tree.dragging", { title: latest.current.dragged?.title ?? "" }),
    onDragOver: () => dropWords(),
    onDragMove: () => dropWords(),
    onDragEnd: () => dropWords(),
    onDragCancel: () =>
      t("productDocs.tree.dropCancelled", { title: latest.current.dragged?.title ?? "" }),
  };

  const onDragStart = ({ active: a }: DragStartEvent) =>
    setDrag({ activeId: String(a.id), overId: String(a.id), offsetX: 0 });
  const onDragMove = ({ delta }: DragMoveEvent) =>
    setDrag((d) => (d ? { ...d, offsetX: delta.x } : d));
  const onDragOver = ({ over }: DragOverEvent) =>
    setDrag((d) => (d ? { ...d, overId: over ? String(over.id) : null } : d));
  const onDragEnd = ({ over, delta }: DragEndEvent) => {
    const d = drag;
    setDrag(null);
    if (!d || !over) return;
    const page = byId.get(d.activeId);
    const p = projectDrop(visible, d.activeId, String(over.id), delta.x);
    if (!page || !p || !canMoveUnder(pages, page.id, p.parentId)) return;
    const pos = positionOf(page);
    if (p.parentId === page.parentId && p.index === pos.index) return;
    void moveTo(page, p.parentId, p.index);
  };

  const tabStop =
    (active && visible.some((f) => f.page.id === active) && active) ||
    (current && visible.some((f) => f.page.id === current.id) && current.id) ||
    visible[0]?.page.id;

  return (
    <div className="flex flex-col pb-4">
      <div className="flex h-9 shrink-0 items-center gap-2 pr-1.5 pl-3">
        <h2 className="heading-group">{t("productDocs.tree.pages")}</h2>
        {space.pageCount > 0 && (
          <span className="num text-xs text-ink-faint">{space.pageCount}</span>
        )}
        {edit && (
          <button
            ref={newPage}
            type="button"
            disabled={create.isPending}
            onClick={() => void create.run(null)}
            className={`${ghostButton} ml-auto h-6 px-1.5 text-xs disabled:opacity-60`}
          >
            <PlusIcon />
            {t("productDocs.tree.newPage")}
          </button>
        )}
      </div>
      {moveError && (
        <div
          role="alert"
          className="mx-2 mb-1 flex items-center gap-2 rounded-md bg-critical/8 px-2 py-1.5 text-xs text-ink"
        >
          <span className="min-w-0 flex-1 text-pretty">
            {t("productDocs.tree.moveFailed", { title: moveError.title })}
          </span>
          <button
            type="button"
            disabled={move.isPending}
            onClick={() => moveError.retry()}
            className={`${smallSecondary} h-6 px-2 text-xs`}
          >
            {t("productDocs.tree.retry")}
          </button>
        </div>
      )}
      <p role="status" aria-live="polite" className="sr-only">
        {announce}
      </p>
      {edit && (
        <p id={`product-tree-help-${project.id}`} className="sr-only">
          {t("productDocs.tree.instructions")}
        </p>
      )}
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragStart={onDragStart}
        onDragMove={onDragMove}
        onDragOver={onDragOver}
        onDragEnd={onDragEnd}
        onDragCancel={() => setDrag(null)}
        accessibility={{ announcements }}
      >
        {/* Le righe non si spostano mentre si trascina: l'origine resta una riga
            vuota tratteggiata e l'arrivo è una linea ([PS 12]). */}
        <SortableContext items={visible.map((f) => f.page.id)} strategy={stillRows}>
          <ul
            ref={root}
            role="tree"
            aria-label={t("productDocs.space.treeLabel", { code: project.code })}
            aria-describedby={edit ? `product-tree-help-${project.id}` : undefined}
            onKeyDown={onKeyDown}
            onFocus={(e) => {
              const id = (e.target as HTMLElement).dataset.pageId;
              if (id && (e.target as HTMLElement).getAttribute("role") === "treeitem") setActive(id);
            }}
            className="flex flex-col px-1"
          >
            {visible.map((flat) => (
              <TreeNode
                key={flat.page.id}
                flat={flat}
                edit={edit}
                open={!collapsed.has(flat.page.id)}
                selected={flat.page.id === current?.id}
                tabbable={flat.page.id === tabStop}
                renaming={renaming === flat.page.id}
                menuOpen={menuFor === flat.page.id}
                dropInside={
                  dropValid && projection?.parentId === flat.page.id && drag?.activeId !== flat.page.id
                }
                dropLine={dropLine?.rowId === flat.page.id ? dropLine : null}
                position={positionOf(flat.page)}
                creating={create.isPending}
                onOpen={() => open(flat.page)}
                onToggle={() => toggle(flat.page.id)}
                onMenu={(next) => (next ? setMenuFor(flat.page.id) : closeMenu(flat.page.id, false))}
                onCloseMenu={(restore) => closeMenu(flat.page.id, restore)}
                onAction={(a) => onAction(flat.page, a)}
                onAddSubpage={() => void addSubpage(flat.page)}
                onRenamed={(value) => finishRename(flat.page, value)}
              />
            ))}
          </ul>
        </SortableContext>
        <DragOverlay
          dropAnimation={null}
          className={`product-tree-overlay ${dropLine ? "" : "cursor-not-allowed"}`}
        >
          {dragged && (
            <div className="flex h-7 items-center rounded-md border border-rule-strong bg-surface px-3 text-sm font-medium text-ink opacity-90 shadow-[0_4px_16px_-4px_oklch(0_0_0/0.35)]">
              <span className="truncate">{dragged.title}</span>
            </div>
          )}
        </DragOverlay>
      </DndContext>
      {deleting && (
        <DeletePageDialog
          page={deleting}
          onClose={() => {
            setDeleting(null);
            setPendingFocus({ pageId: byId.has(deleting.id) ? deleting.id : null });
          }}
          onDeleted={() => {
            const parent = deleting.parentId ? byId.get(deleting.parentId) : undefined;
            setDeleting(null);
            setAnnounce(t("productDocs.tree.deleted"));
            if (current?.id === deleting.id || parent) {
              void navigate({
                ...(parent
                  ? productPageLink(project.code, parent.code)
                  : productIndexLink(project.code)),
                replace: true,
              });
            }
            setPendingFocus({ pageId: parent?.id ?? null, skip: deleting.id });
          }}
        />
      )}
    </div>
  );
}

type NodeAction = "rename" | "subpage" | "up" | "down" | "indent" | "outdent" | "copy" | "delete";

/**
 * Un nodo: il `treeitem` stesso (prende il fuoco, porta livello, espansione
 * e selezione); la riga visibile è dentro, alta 28 px. Al passaggio o al
 * fuoco, per chi scrive: la maniglia a sinistra (nella fascia del rientro),
 * «+» e «⋯» a destra.
 */
function TreeNode({
  flat,
  edit,
  open,
  selected,
  tabbable,
  renaming,
  menuOpen,
  dropInside,
  dropLine,
  position,
  creating,
  onOpen,
  onToggle,
  onMenu,
  onCloseMenu,
  onAction,
  onAddSubpage,
  onRenamed,
}: {
  flat: Flat;
  edit: boolean;
  open: boolean;
  selected: boolean;
  tabbable: boolean;
  renaming: boolean;
  menuOpen: boolean;
  dropInside: boolean;
  /** La linea d'arrivo su questa riga: sopra, sotto o (solo il livello cambia) in mezzo. */
  dropLine: { edge: "top" | "bottom" | "middle"; depth: number } | null;
  position: { index: number; sibs: ProductPageRef[]; above: ProductPageRef | null; parent: ProductPageRef | null };
  creating: boolean;
  onOpen: () => void;
  onToggle: () => void;
  onMenu: (open: boolean) => void;
  onCloseMenu: (restore: boolean) => void;
  onAction: (action: NodeAction) => void;
  onAddSubpage: () => void;
  onRenamed: (value: string | null) => void;
}) {
  const { t } = useTranslation();
  const { page, depth, hasChildren } = flat;
  const {
    setNodeRef,
    setActivatorNodeRef,
    listeners,
    isDragging,
  } = useSortable({ id: page.id, disabled: !edit || renaming });
  const stop = (e: MouseEvent) => e.stopPropagation();

  return (
    <li
      ref={setNodeRef}
      role="treeitem"
      aria-level={depth + 1}
      aria-expanded={hasChildren ? open : undefined}
      aria-selected={selected}
      aria-label={page.title}
      aria-posinset={position.index + 1}
      aria-setsize={position.sibs.length}
      data-page-id={page.id}
      data-tree-row
      tabIndex={tabbable ? 0 : -1}
      className="group/node relative outline-none [&:focus-visible>[data-row]]:outline-2 [&:focus-visible>[data-row]]:-outline-offset-2 [&:focus-visible>[data-row]]:outline-focus"
    >
      {dropLine && (
        // L'arrivo: 2 px d'inchiostro che partono dal rientro del livello d'arrivo.
        <span
          aria-hidden="true"
          data-drop-line={dropLine.edge}
          style={{ left: indentOf(dropLine.depth) }}
          className={`pointer-events-none absolute right-1 z-10 h-0.5 rounded-full bg-ink ${
            dropLine.edge === "top" ? "-top-px" : dropLine.edge === "bottom" ? "-bottom-px" : "top-1/2 -translate-y-1/2"
          }`}
        />
      )}
      {isDragging ? (
        // L'origine: lo spazio vuoto della riga, col tratteggio `rule`.
        <div
          aria-hidden="true"
          data-drag-origin
          className="h-7 rounded-md border border-dashed border-rule"
        />
      ) : (
        <div
          data-row
          title={`${page.code} · ${page.title}`}
          onClick={renaming ? undefined : onOpen}
          // La freccia (16) e il suo spazio (4) stanno prima del titolo: foglie e
          // genitori hanno il titolo sullo stesso bordo (Impeccable 11).
          style={{ paddingLeft: indentOf(depth) + (hasChildren ? -16 : 4) }}
          className={`relative flex h-7 min-w-0 cursor-default items-center gap-1 rounded-md pr-1 text-sm transition-colors duration-[var(--duration-fast)] ease-out hover:bg-ink/6 ${
            selected ? "bg-ink/10 font-semibold text-ink" : "text-ink-muted hover:text-ink"
          } ${dropInside ? "bg-ink/10 ring-1 ring-ink/40 ring-inset" : ""}`}
        >
          {edit && (
            <button
              ref={setActivatorNodeRef}
              type="button"
              tabIndex={-1}
              aria-label={t("productDocs.tree.handle", { title: page.title })}
              onClick={stop}
              {...listeners}
              className="absolute top-1/2 left-0.5 grid size-4 -translate-y-1/2 cursor-grab touch-none place-items-center rounded-sm text-ink-faint opacity-0 group-focus-within/node:opacity-100 group-hover/node:opacity-100 active:cursor-grabbing"
            >
              <GripIcon />
            </button>
          )}
          {hasChildren && (
            <button
              type="button"
              tabIndex={-1}
              aria-label={t(open ? "docs.tree.collapse" : "docs.tree.expand", { name: page.title })}
              onClick={(e) => {
                e.stopPropagation();
                onToggle();
              }}
              className="grid size-4 shrink-0 place-items-center rounded-sm text-ink-faint hover:text-ink"
            >
              <Caret open={open} />
            </button>
          )}
          {renaming ? (
            <RenameField title={page.title} onDone={onRenamed} />
          ) : (
            <span className="min-w-0 flex-1 truncate">{page.title}</span>
          )}
          {edit && !renaming && (
            <span
              onClick={stop}
              className={`flex shrink-0 items-center opacity-0 group-focus-within/node:opacity-100 group-hover/node:opacity-100 ${menuOpen ? "opacity-100" : ""}`}
            >
              <button
                type="button"
                tabIndex={-1}
                disabled={creating}
                aria-label={t("productDocs.tree.addSubpage", { title: page.title })}
                title={t("productDocs.tree.newSubpage")}
                onClick={onAddSubpage}
                className={nodeAction}
              >
                <PlusIcon />
              </button>
              <span className="relative inline-flex">
                <button
                  type="button"
                  tabIndex={-1}
                  aria-haspopup="menu"
                  aria-expanded={menuOpen}
                  aria-label={t("productDocs.tree.more", { title: page.title })}
                  title={t("productDocs.tree.more", { title: page.title })}
                  onClick={() => onMenu(!menuOpen)}
                  className={nodeAction}
                >
                  <MoreIcon />
                </button>
                {menuOpen && (
                  <Menu
                    label={t("productDocs.tree.more", { title: page.title })}
                    onClose={onCloseMenu}
                    align="right"
                  >
                    <NodeMenuItems page={page} position={position} onAction={onAction} />
                  </Menu>
                )}
              </span>
            </span>
          )}
        </div>
      )}
    </li>
  );
}

/**
 * Le voci del «⋯» ([PS 13]): Rename · New subpage · Move up · Move down ·
 * Indent · Outdent · Copy link · Delete…. Una voce impossibile è spenta con
 * la sua frase sotto, mai nascosta; «Delete» legge dalla vista della pagina
 * se ha sottopagine (una regola: niente «Who?»).
 */
function NodeMenuItems({
  page,
  position,
  onAction,
}: {
  page: ProductPageRef;
  position: { index: number; sibs: ProductPageRef[]; above: ProductPageRef | null; parent: ProductPageRef | null };
  onAction: (action: NodeAction) => void;
}) {
  const { t } = useTranslation();
  const view = useProductPage(page.code);
  const item = (action: NodeAction, label: string, off?: string, critical = false) =>
    off ? (
      <button
        key={action}
        type="button"
        role="menuitem"
        tabIndex={-1}
        aria-disabled="true"
        className={`${itemClass} cursor-default flex-col items-start gap-0 hover:bg-transparent`}
      >
        <span className="text-ink-muted">{label}</span>
        <span className="max-w-[200px] text-xs text-pretty text-ink-faint">{off}</span>
      </button>
    ) : (
      <button
        key={action}
        type="button"
        role="menuitem"
        tabIndex={-1}
        className={`${itemClass} ${critical ? "text-critical" : ""}`}
        onClick={() => onAction(action)}
      >
        {label}
      </button>
    );
  const last = position.index === position.sibs.length - 1;
  const perms = view.data?.permissions;
  const deleteOff =
    view.data === undefined
      ? t("productDocs.tree.checking")
      : perms?.deleteBlocked === "has_children"
        ? t("productDocs.tree.hasChildren")
        : undefined;
  return (
    <>
      {item("rename", t("productDocs.tree.rename"))}
      {item("subpage", t("productDocs.tree.newSubpage"))}
      <span aria-hidden="true" className="my-1 border-t border-rule" />
      {item("up", t("productDocs.tree.moveUp"), position.index === 0 ? t("productDocs.tree.alreadyFirst") : undefined)}
      {item("down", t("productDocs.tree.moveDown"), last ? t("productDocs.tree.alreadyLast") : undefined)}
      {item("indent", t("productDocs.tree.indent"), position.above ? undefined : t("productDocs.tree.needsAbove"))}
      {item("outdent", t("productDocs.tree.outdent"), position.parent ? undefined : t("productDocs.tree.alreadyTop"))}
      <span aria-hidden="true" className="my-1 border-t border-rule" />
      {item("copy", t("productDocs.tree.copyLink"))}
      {/* Una pagina che la vista non dà più (eliminata nel frattempo) non promette niente. */}
      {view.data !== null &&
        (view.data === undefined || perms?.delete || perms?.deleteBlocked) &&
        item("delete", t("productDocs.tree.delete"), deleteOff, true)}
    </>
  );
}

/**
 * Il titolo in un campo della stessa altezza, selezionato ([PS 14]): Invio
 * salva, Esc torna al titolo di prima, il clic fuori salva. Vuoto: il
 * `title` lo dice, e salvare torna al titolo di prima.
 */
function RenameField({ title, onDone }: { title: string; onDone: (value: string | null) => void }) {
  const { t } = useTranslation();
  const ref = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState(title);
  const done = useRef(false);
  const finish = (next: string | null) => {
    if (done.current) return;
    done.current = true;
    onDone(next);
  };
  useLayoutEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  return (
    <input
      ref={ref}
      value={value}
      aria-label={t("productDocs.tree.renameField", { title })}
      title={value.trim() ? undefined : t("productDocs.tree.needsTitle")}
      aria-invalid={value.trim() ? undefined : true}
      onChange={(e) => setValue(e.target.value)}
      onClick={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") {
          e.preventDefault();
          finish(value);
        } else if (e.key === "Escape") {
          e.preventDefault();
          finish(null);
        }
      }}
      onBlur={() => finish(value)}
      className="h-6 min-w-0 flex-1 rounded-sm border border-rule-strong bg-ground px-1.5 text-sm font-normal text-ink outline-none focus-visible:border-focus aria-invalid:border-critical"
    />
  );
}

function Caret({ open }: { open: boolean }) {
  return (
    <svg
      viewBox="0 0 16 16"
      width={12}
      height={12}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      className={`transition-transform duration-[var(--duration-fast)] ease-out motion-reduce:transition-none ${open ? "rotate-90" : ""}`}
    >
      <path d="m6 4 4 4-4 4" />
    </svg>
  );
}

/** La maniglia ⋮⋮ (16 px). */
function GripIcon() {
  return (
    <svg viewBox="0 0 16 16" width={14} height={14} fill="currentColor" aria-hidden="true" focusable="false">
      {[5, 8, 11].flatMap((y) => [
        <circle key={`a${y}`} cx="6" cy={y} r="1.1" />,
        <circle key={`b${y}`} cx="10" cy={y} r="1.1" />,
      ])}
    </svg>
  );
}
