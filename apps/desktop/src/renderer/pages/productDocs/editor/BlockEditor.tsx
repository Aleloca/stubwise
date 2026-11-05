import {
  DndContext,
  DragOverlay,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type Announcements,
  type DragEndEvent,
} from "@dnd-kit/core";
import { SortableContext } from "@dnd-kit/sortable";
import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type DragEvent as ReactDragEvent,
  type Ref,
} from "react";
import { useTranslation } from "react-i18next";
import type { ProductBlock, ProductBlockOp, ProductPageView, ProductPresenceView } from "../../../data/types";
import { anchorIdsOf, anchorText, isTextBlock, makeBlockId } from "../../../domain/productDocs/blocks";
import { setLink, toggleMark } from "../../../domain/productDocs/richText";
import { BlockBody, ReadOnlyBody, blockLabel, layoutOf, numbersOf, textClassOf } from "./BlockBody";
import { useProductSpaceContext } from "../parts";
import { CommentMark } from "../comments/CommentMark";
import { useCommentGesture } from "../comments/SelectionCommentButton";
import { LiveNoteRegion, RemoteBlockNote } from "../live/RemoteBlockNote";
import { RemoteCursors } from "../live/RemoteCursor";
import { useSendPresence } from "../live/useSendPresence";
import { BlockHandle } from "./BlockHandle";
import { FLOATING_MAX, SLASH_MAX, dropAfter, floatingPlacement, insertCode } from "./blockOps";
import { BlockShell } from "./BlockShell";
import { DecisionPicker } from "./DecisionPicker";
import { DrivePicker } from "./DrivePicker";
import { ImageRefusalRow } from "./ImageBlock";
import { PRODUCT_IMAGE_TYPES, filesOf, readImageFile, type ImageRefusal } from "./images";
import { LinkPicker } from "./LinkPicker";
import { makeGestures, type Focus, type Slash } from "./gestures";
import { RichBlockEdit, RichBlockRead } from "./RichBlock";
import { SelectionBar, linkAt } from "./SelectionBar";
import { SlashMenu, slashOptionId } from "./SlashMenu";
import type { Table, TableEditing } from "./TableBlock";
import type { EditorSession } from "./useEditorSession";

// L'editor a blocchi di una pagina di prodotto (shape product-editor.md):
// una pagina stampata in cui si può scrivere. Nessuna cornice, nessuna
// barra fissa: gli strumenti compaiono dove è la mano — la maniglia al
// passaggio, il menu «/» al cursore, la barra sopra la selezione ([PE 1]).
// Chi legge soltanto vede la stessa pagina senza nessuno di quegli
// strumenti e senza un `contenteditable`.
//
// I dati: la pagina della sessione (`session.blocks`: la lettura più le
// scritture in fila) e, sopra, le bozze dei blocchi in cui si sta scrivendo.
// Una bozza si salva all'uscita dal blocco, a ogni gesto di struttura
// (dividere, unire, «/», spostare, rientrare) e dopo 800 ms senza tasti
// ([PE 15]). I blocchi che non sono testo (Task 9): l'immagine (incollata,
// scelta con «/image» o trascinata come file sulla colonna, [PE 9]), il file
// del Drive e la decisione (dai loro selettori), la tabella (si scrive cella
// per cella, [PE 13]); «/link» mette un codice nel testo ([PE 12]).
// Il disegno dei blocchi sta in `BlockBody`, i gesti in `gestures`, i
// blocchi che i gesti scrivono in `blockOps`. Un blocco si trascina per ⋮⋮
// ([PE 4]): una scrittura sola, un `move`; lasciato dov'era, niente.
//
// La scrittura dal vivo (Task 11, §3.13): i cursori degli altri nei blocchi
// letti (`RemoteCursors`); nel blocco col fuoco, invece, la nota «… is
// writing here» (`RemoteBlockNote`) e il blocco tenuto com'è dalla sessione
// (`session.hold`, [PE 18]). Dove scrive chi guarda va agli altri con
// `useSendPresence`. Le persone sono quelle di `getProductPresence`.

const SAVE_AFTER_MS = 800;
/** Il rifiuto di un'immagine resta 6 s, o fino a «Dismiss» (§3.6). */
const REFUSAL_MS = 6000;

type PickerKind = "drive" | "decision" | "link";

/** I blocchi non si spostano mentre se ne trascina uno: l'arrivo è una linea ([PS 12]). */
const stillBlocks = () => null;

/**
 * La frase citata di un blocco commentato per intero (⋮⋮ → Comment, ⌥⌘M):
 * il testo; per un'immagine la didascalia (o «Image»); per gli altri oggetti
 * il nome del tipo («Drive file ACQ-F1», «Decision»). Mai il titolo di una
 * decisione: chi legge il filo potrebbe non vederla (R-G5).
 */
function commentTextOf(block: ProductBlock, t: (key: string, opts?: Record<string, unknown>) => string): string {
  if (isTextBlock(block)) return block.content.text;
  if (block.type === "image" && block.caption.trim() !== "") return block.caption;
  return blockLabel(block, t);
}

export interface BlockEditorHandle {
  /** Il fuoco nel primo blocco (Invio dal titolo). */
  focusFirst(): void;
}

export function BlockEditor({
  page,
  session,
  editable,
  handle,
  others = [],
}: {
  page: ProductPageView;
  session: EditorSession;
  editable: boolean;
  handle?: Ref<BlockEditorHandle>;
  /** Gli altri presenti (non chi guarda), dalla presenza filtrata per chi guarda. */
  others?: readonly ProductPresenceView[];
}) {
  if (!editable) return <ReadOnlyBody page={page} others={others} />;
  return <WritableBody page={page} session={session} handle={handle} others={others} />;
}

/** Chi scrive (ha un'ancora) nel blocco `id`. */
export const writersIn = (others: readonly ProductPresenceView[], id: string): ProductPresenceView[] =>
  others.filter((p) => p.anchorId === id);

// --- chi scrive --------------------------------------------------------------

function WritableBody({
  page,
  session,
  handle,
  others,
}: {
  page: ProductPageView;
  session: EditorSession;
  handle?: Ref<BlockEditorHandle>;
  others: readonly ProductPresenceView[];
}) {
  const { t } = useTranslation();
  const container = useRef<HTMLDivElement>(null);
  const shells = useRef(new Map<string, HTMLDivElement>());

  const [drafts, setDraftsState] = useState<ReadonlyMap<string, ProductBlock>>(new Map());
  const draftsRef = useRef(drafts);
  const setDrafts = (next: ReadonlyMap<string, ProductBlock>) => {
    draftsRef.current = next;
    setDraftsState(next);
  };
  const [focus, setFocusState] = useState<Focus | null>(null);
  const focusRef = useRef(focus);
  const nonce = useRef(0);
  const setFocus = (next: Focus | null) => {
    focusRef.current = next;
    setFocusState(next);
    // Il blocco col fuoco non cambia per mano d'altri finché non lo si lascia ([PE 18]).
    session.hold(next?.id ?? null);
  };
  const caret = (id: string, start: number, end = start) =>
    setFocus({ id, start, end, nonce: ++nonce.current });
  const [slash, setSlashState] = useState<Slash | null>(null);
  const slashRef = useRef(slash);
  const setSlash = (next: Slash | null) => {
    slashRef.current = next;
    setSlashState(next);
  };
  const [linkOpen, setLinkOpen] = useState(false);
  const { project, comments: bridge } = useProductSpaceContext();
  /** «Comment» (Task 10): solo per chi può commentare. */
  const comment = useCommentGesture();
  /** Un selettore aperto al blocco `id`; `at` è il cursore a cui torna il fuoco. */
  const [picker, setPickerState] = useState<{ kind: PickerKind; id: string; at: number } | null>(null);
  const pickerRef = useRef(picker);
  const setPicker = (next: typeof picker) => {
    pickerRef.current = next;
    setPickerState(next);
  };
  /** Il rifiuto di un'immagine, sotto il blocco dove sarebbe andata. */
  const [refusal, setRefusal] = useState<{ anchorId: string; reason: ImageRefusal; n: number } | null>(null);
  const refusalRow = useRef<HTMLDivElement>(null);
  /** Il blocco sotto cui cadrebbe un file trascinato. */
  const [fileDrop, setFileDrop] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  /** Il blocco che l'immagine scelta con «/image» sostituisce. */
  const imageTarget = useRef<string | null>(null);
  /** Una tabella nuova: il fuoco nella sua prima cella dopo il disegno. */
  const pendingCell = useRef<string | null>(null);
  /** Un blocco da selezionare come oggetto dopo il prossimo disegno. */
  const pendingShell = useRef<string | null>(null);
  /** Un gesto che sposta il blocco col fuoco: il blur del DOM non è un'uscita. */
  const relocating = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const view = session.shown.map((b) => drafts.get(b.id) ?? b);
  const viewRef = useRef(view);
  viewRef.current = view;
  const sessionRef = useRef(session);
  sessionRef.current = session;

  const blockOf = (id: string) => viewRef.current.find((b) => b.id === id) ?? null;
  const indexOf = (id: string) => viewRef.current.findIndex((b) => b.id === id);

  /** Salva le bozze (un `set` per blocco cambiato) come una scrittura. */
  const flush = useCallback(() => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    const pending = draftsRef.current;
    if (pending.size === 0) return;
    draftsRef.current = new Map();
    setDraftsState(draftsRef.current);
    const live = new Map(sessionRef.current.blocks.map((b) => [b.id, b]));
    const ops: ProductBlockOp[] = [];
    for (const [id, block] of pending) {
      const now = live.get(id);
      // Un blocco tolto da altri nel frattempo: la bozza non ha più dove andare.
      if (!now || JSON.stringify(now) === JSON.stringify(block)) continue;
      ops.push({ op: "set", block });
    }
    if (ops.length > 0) sessionRef.current.save(ops);
  }, []);

  /** Un gesto di struttura: prima le bozze (la loro scrittura), poi il gesto (la sua). */
  const structure = (ops: ProductBlockOp[]) => {
    flush();
    sessionRef.current.save(ops);
  };

  /** Il blocco intero al posto del suo id: la sua bozza se ne va (è dentro), le altre si salvano prima. */
  const replaceBlock = (block: ProductBlock) => {
    if (draftsRef.current.has(block.id)) {
      const rest = new Map(draftsRef.current);
      rest.delete(block.id);
      setDrafts(rest);
    }
    structure([{ op: "set", block }]);
  };

  const setDraft = (block: ProductBlock) => {
    const next = new Map(draftsRef.current);
    next.set(block.id, block);
    setDrafts(next);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(flush, SAVE_AFTER_MS);
  };

  // Uscire dalla pagina (o cambiare persona) salva ciò che resta.
  useEffect(() => () => flush(), [flush]);

  // La cella di tabella col fuoco (le celle hanno il loro fuoco, in `TableBlock`):
  // anche lì chi guarda scrive, e gli altri non devono leggerlo come «reading».
  const [cellFocus, setCellFocus] = useState<{ id: string; start: number; end: number } | null>(null);

  // Dove scrive chi guarda, per gli altri: lo scarto entro la frase salvata
  // (una bozza più lunga non è ancora sul «server»). Nel blocco tenuto
  // ([PE 18]) lo scarto è contato sulla frase disegnata, che può non essere
  // quella vera: limitato alla sua lunghezza, il cursore che vedono gli altri
  // è approssimato finché non si esce dal blocco.
  const here = focus ?? cellFocus;
  const savedLength = here ? (anchorText(session.blocks, here.id)?.length ?? 0) : 0;
  useSendPresence(
    page.id,
    here
      ? {
          anchorId: here.id,
          offset: Math.min(here.end, savedLength),
          selection:
            here.start !== here.end ? [Math.min(here.start, savedLength), Math.min(here.end, savedLength)] : null,
        }
      : null,
  );

  /**
   * Seleziona un blocco come oggetto (anello di fuoco), dopo il disegno. Il
   * disegno c'è sempre (`redraw`): da una cella o da una didascalia il fuoco
   * dell'editor è già `null`, e senza un disegno il guscio non lo prenderebbe
   * (il fuoco finirebbe sul body, o resterebbe un `pendingShell` vecchio).
   */
  const [, redraw] = useState(0);
  const selectShell = (id: string) => {
    pendingShell.current = id;
    setFocus(null);
    setSlash(null);
    setLinkOpen(false);
    redraw((n) => n + 1);
  };

  /** Il fuoco su un blocco: un testo col cursore, un oggetto con l'anello. */
  const focusBlock = (block: ProductBlock, at: "start" | "end") => {
    if (isTextBlock(block)) {
      const n = at === "start" ? 0 : block.content.text.length;
      caret(block.id, n);
    } else selectShell(block.id);
  };

  // Dopo il disegno: l'oggetto da selezionare; un blocco col fuoco che non c'è
  // più (annullato, tolto da altri) passa il fuoco al vicino: mai sul body.
  const order = useRef<string[]>([]);
  useLayoutEffect(() => {
    relocating.current = false;
    if (pendingCell.current && view.find((b) => b.id === pendingCell.current)?.type === "table") {
      const cell = shells.current.get(pendingCell.current)?.querySelector<HTMLElement>("[data-table-cell] [role=textbox]");
      pendingCell.current = null;
      cell?.focus();
    }
    if (pendingShell.current) {
      const el = shells.current.get(pendingShell.current);
      pendingShell.current = null;
      el?.focus();
    }
    const f = focusRef.current;
    if (f && !view.some((b) => b.id === f.id)) {
      const was = order.current.indexOf(f.id);
      const near = view[Math.min(Math.max(was - 1, 0), view.length - 1)];
      if (near) focusBlock(near, "end");
      else setFocus(null);
    }
    order.current = view.map((b) => b.id);
  });

  useImperativeHandle(handle, () => ({
    focusFirst: () => {
      const first = viewRef.current[0];
      if (first) focusBlock(first, "start");
    },
  }));

  const {
    handlers,
    shellKey,
    addBelow,
    turnInto,
    moveBlock,
    duplicate,
    deleteBlock,
    slashQuery,
    slashItems,
    pickSlash,
    applyContent,
  } = makeGestures({
    t,
    viewRef,
    sessionRef,
    draftsRef,
    setDrafts,
    setDraft,
    focusRef,
    setFocus,
    caret,
    slashRef,
    setSlash,
    linkOpen,
    setLinkOpen,
    flush,
    structure,
    selectShell,
    focusBlock,
    relocating,
    pendingShell,
    container,
    pendingCell,
    blockOf,
    indexOf,
    replaceBlock,
    addImages: (files, at) => addImages(files, at),
    chooseImage: (id) => {
      imageTarget.current = id;
      fileInput.current?.click();
    },
    openPicker: (kind, id) => setPicker({ kind, id, at: focusRef.current?.id === id ? focusRef.current.start : 0 }),
  });

  // --- immagini ([PE 9]) --------------------------------------------------------

  /**
   * Le immagini incollate, scelte o trascinate: dopo un blocco, o al posto
   * del blocco vuoto di «/image». Un file rifiutato non mette niente e lo
   * dice sotto quel blocco (il primo rifiuto); gli altri entrano.
   */
  const addImages = (files: File[], at: { afterId: string } | { replaceId: string }) => {
    if (files.length === 0) return;
    void Promise.all(files.map(readImageFile)).then((results) => {
      const anchorId = "afterId" in at ? at.afterId : at.replaceId;
      const refused = results.find((r) => !r.ok);
      setRefusal(refused && !refused.ok ? { anchorId, reason: refused.reason, n: Date.now() } : null);
      const images: ProductBlock[] = results.flatMap((r) =>
        r.ok ? [{ id: makeBlockId(), type: "image" as const, src: r.src, caption: "", alt: r.alt }] : [],
      );
      if (images.length === 0) return;
      if (!blockOf(anchorId)) return;
      if ("replaceId" in at) {
        const [first, ...rest] = images;
        const placed = { ...first!, id: at.replaceId } as ProductBlock;
        if (draftsRef.current.has(at.replaceId)) {
          const others = new Map(draftsRef.current);
          others.delete(at.replaceId);
          setDrafts(others);
        }
        flush();
        let afterId = at.replaceId;
        sessionRef.current.save([
          { op: "set", block: placed },
          ...rest.map((b) => {
            const op: ProductBlockOp = { op: "insert", afterId, block: b };
            afterId = b.id;
            return op;
          }),
        ]);
        selectShell(at.replaceId);
        return;
      }
      let afterId = at.afterId;
      structure(
        images.map((b) => {
          const op: ProductBlockOp = { op: "insert", afterId, block: b };
          afterId = b.id;
          return op;
        }),
      );
    });
  };

  const dismissRefusal = () => {
    const r = refusal;
    const hadFocus = !!refusalRow.current?.contains(document.activeElement);
    setRefusal(null);
    // Il bottone che sparisce non lascia il fuoco sul body: torna nel blocco.
    const anchor = r ? blockOf(r.anchorId) : null;
    if (hadFocus && anchor) focusBlock(anchor, "end");
  };
  const dismissRef = useRef(dismissRefusal);
  dismissRef.current = dismissRefusal;
  useEffect(() => {
    if (!refusal) return;
    const timer = setTimeout(() => dismissRef.current(), REFUSAL_MS);
    return () => clearTimeout(timer);
  }, [refusal]);

  const hasFiles = (e: ReactDragEvent) => Array.from(e.dataTransfer?.types ?? []).includes("Files");
  const dropTarget = (e: ReactDragEvent) =>
    (e.target as Element).closest?.("[data-block-id]")?.getAttribute("data-block-id") ?? viewRef.current.at(-1)?.id ?? null;
  const onFileDragOver = (e: ReactDragEvent) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    const id = dropTarget(e);
    if (id !== fileDrop) setFileDrop(id);
  };
  const onFileDrop = (e: ReactDragEvent) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    const id = dropTarget(e);
    setFileDrop(null);
    if (id) addImages(filesOf(e.dataTransfer.files), { afterId: id });
  };

  // --- i selettori ([PE 10], [PE 11], [PE 12]) -----------------------------------

  /** Esc: il selettore si chiude e il fuoco torna nel blocco, al cursore di prima. */
  const closePicker = () => {
    const p = pickerRef.current;
    setPicker(null);
    if (p) caret(p.id, p.at);
  };
  /** Il fuoco è uscito dal selettore: verso il blocco, resta lì; altrove, si esce anche dal blocco. */
  const leavePicker = (related: Element | null) => {
    const p = pickerRef.current;
    setPicker(null);
    if (!p || related?.closest?.(`[data-block-text="${p.id}"]`)) return;
    if (related?.closest?.("[data-editor-floating]")) return;
    flush();
    setFocus(null);
  };
  const pickObject = (block: ProductBlock) => {
    setPicker(null);
    replaceBlock(block);
    selectShell(block.id);
  };
  const pickCode = (code: string) => {
    const p = pickerRef.current;
    setPicker(null);
    const block = p ? blockOf(p.id) : null;
    if (!p || !block || !isTextBlock(block)) return;
    const out = insertCode(block.content, p.at, code);
    setDraft({ ...block, content: out.content } as ProductBlock);
    caret(p.id, out.caret);
  };

  /** Ciò che una tabella chiede all'editor ([PE 13]). */
  const tableEditing = (id: string): TableEditing => ({
    draft: (table: Table) => setDraft(table),
    replace: (table: Table) => replaceBlock(table),
    leave: () => flush(),
    exit: (dir) => {
      const at = indexOf(id);
      const next = viewRef.current[dir === "next" ? at + 1 : at - 1];
      if (next) focusBlock(next, dir === "next" ? "start" : "end");
      else selectShell(id);
    },
    select: () => selectShell(id),
    images: (files) => addImages(files, { afterId: id }),
    history: (kind) => {
      flush();
      if (kind === "undo") sessionRef.current.undo();
      else sessionRef.current.redo();
    },
    touch: () => sessionRef.current.touch(),
    focusCell: setCellFocus,
  });

  // --- il disegno ------------------------------------------------------------

  const numbers = numbersOf(view);
  const focusedBlock = focus ? view.find((b) => b.id === focus.id) : undefined;
  const focusedText = focusedBlock && isTextBlock(focusedBlock) ? focusedBlock : null;
  const listId = `slash-${page.id}`;
  const openSlash = slash && focusedText && slash.id === focusedText.id ? slash : null;
  const items = openSlash ? slashItems(openSlash) : [];
  const active = Math.min(openSlash?.active ?? 0, Math.max(items.length - 1, 0));
  const linkHere =
    focus && focusedText && focus.start === focus.end ? linkAt(focusedText.content, focus.start, focus.end) : null;
  const showBar = !!focus && !!focusedText && !openSlash && (focus.start !== focus.end || linkHere !== null);
  const barStart = linkHere && focus!.start === focus!.end ? linkHere.start : (focus?.start ?? 0);
  const barEnd = linkHere && focus!.start === focus!.end ? linkHere.end : (focus?.end ?? 0);

  // Dove stanno il menu «/» e la barra: sotto il blocco, sopra la selezione.
  const [floating, setFloating] = useState<{ slash: CSSProperties; bar: CSSProperties }>({ slash: {}, bar: {} });
  useLayoutEffect(() => {
    const box = container.current?.getBoundingClientRect();
    if (!box || !focus) return;
    const shell = shells.current.get(focus.id);
    // Sotto il blocco; sopra, se sotto non ci sta (il menu è alto al più 320).
    let slashStyle: CSSProperties = {};
    if (shell) {
      // Lo spazio visibile è quello della colonna che scorre (sotto la barra).
      const r = shell.getBoundingClientRect();
      const view = shell.closest(".overflow-y-auto")?.getBoundingClientRect();
      const place = floatingPlacement(
        {
          blockTop: r.top,
          blockBottom: r.bottom,
          viewTop: view?.top ?? 0,
          viewBottom: view?.bottom ?? window.innerHeight,
          windowHeight: window.innerHeight,
        },
        // Il menu «/» mostra le sue voci intere; i selettori restano a 320.
        openSlash ? SLASH_MAX : FLOATING_MAX,
      );
      slashStyle =
        place.placement === "above"
          ? { top: shell.offsetTop, left: 0, transform: "translateY(-100%)", maxHeight: place.maxHeight }
          : { top: shell.offsetTop + shell.offsetHeight, left: 0, maxHeight: place.maxHeight };
    }
    setFloating((prev) => {
      // La barra resta dov'è quando il fuoco va nel campo del link (la
      // selezione allora non è più nel blocco): si misura solo lì dentro.
      // Col campo del link aperto la barra resta ferma dov'era (Impeccable 4):
      // ancorata dal basso 8 px sopra la selezione, il campo cresce verso l'alto.
      let barStyle = prev.bar;
      const sel = document.getSelection();
      const editingEl = container.current?.querySelector("[data-editing]");
      const measure = !linkOpen || prev.bar.top === undefined;
      if (measure && sel && sel.rangeCount > 0 && editingEl?.contains(sel.getRangeAt(0).startContainer)) {
        const rect = sel.getRangeAt(0).getBoundingClientRect();
        // 8 px sopra la selezione, ancorata dal basso: il campo del link (e il
        // suo rifiuto) crescono verso l'alto, senza coprire la riga.
        barStyle = {
          top: rect.top - box.top - 8,
          left: Math.max(rect.left - box.left, 0),
          transform: "translateY(-100%)",
        };
      }
      const next = { slash: slashStyle, bar: barStyle };
      return JSON.stringify(prev) === JSON.stringify(next) ? prev : next;
    });
  }, [focus, openSlash, showBar, linkOpen, picker]);

  // La barra (e il campo del link, più largo) non esce dal bordo destro della
  // colonna di lettura: a 1440 non entra nella colonna dei commenti (Impeccable 4).
  const barRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const bar = barRef.current;
    const box = container.current;
    if (!bar || !box || box.clientWidth === 0 || typeof floating.bar.left !== "number") return;
    const max = Math.max(0, box.clientWidth - bar.offsetWidth);
    bar.style.left = `${Math.min(floating.bar.left, max)}px`;
  });

  // --- trascinare per ⋮⋮ ([PE 4]) ---------------------------------------------

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));
  const [drag, setDrag] = useState<{ activeId: string; overId: string | null } | null>(null);
  const ids = view.map((b) => b.id);
  const drop = drag?.overId ? dropAfter(ids, drag.activeId, drag.overId) : null;
  const labelOf = (id: unknown) => {
    const block = view.find((b) => b.id === id);
    return block ? blockLabel(block, t) : "";
  };
  const announcements: Announcements = {
    onDragStart: ({ active: a }) => t("productDocs.editor.handle.dragging", { block: labelOf(a.id) }),
    onDragOver: ({ active: a, over }) => {
      const d = over ? dropAfter(ids, String(a.id), String(over.id)) : null;
      if (!d || !over) return undefined;
      return t(d.edge === "top" ? "productDocs.editor.handle.dropBefore" : "productDocs.editor.handle.dropAfter", {
        block: labelOf(over.id),
      });
    },
    onDragEnd: ({ active: a, over }) =>
      over && dropAfter(ids, String(a.id), String(over.id))
        ? t("productDocs.editor.handle.dropped", { block: labelOf(a.id) })
        : t("productDocs.editor.handle.dropCancelled", { block: labelOf(a.id) }),
    onDragCancel: ({ active: a }) => t("productDocs.editor.handle.dropCancelled", { block: labelOf(a.id) }),
  };
  const onDragEnd = ({ active: a, over }: DragEndEvent) => {
    setDrag(null);
    const d = over ? dropAfter(viewRef.current.map((b) => b.id), String(a.id), String(over.id)) : null;
    // Lasciato dov'era: nessuna scrittura, niente in cronologia.
    if (!d) return;
    structure([{ op: "move", blockId: String(a.id), afterId: d.afterId }]);
    pendingShell.current = String(a.id);
  };
  const dragged = drag ? view.find((b) => b.id === drag.activeId) : undefined;

  const firstEmptyPage = view.length === 1 && isTextBlock(view[0]!) && view[0]!.content.text === "";

  return (
    <div
      ref={container}
      data-editor-body=""
      aria-label={t("productDocs.editor.body")}
      role="group"
      className="relative flex flex-col pr-7"
      onKeyDown={(e) => {
        // ⌥⌘M (la scorciatoia di Google Docs, §6): dal blocco col fuoco al
        // suo primo filo, o la casella se non ne ha.
        if (!(e.altKey && (e.metaKey || e.ctrlKey) && e.code === "KeyM") || !bridge) return;
        const id = (e.target as Element).closest?.("[data-block-id]")?.getAttribute("data-block-id");
        const block = id ? blockOf(id) : null;
        if (!block) return;
        // In una tabella l'ancora è la cella col fuoco.
        const cellId =
          block.type === "table"
            ? ((e.target as Element).closest?.("[data-anchor-id]")?.getAttribute("data-anchor-id") ?? null)
            : null;
        const anchors = cellId ? [cellId] : anchorIdsOf(block);
        if (anchors.some((a) => (bridge.counts.get(a) ?? 0) > 0)) {
          e.preventDefault();
          bridge.openAnchor(anchors);
          return;
        }
        const target = cellId
          ? { id: cellId, text: anchorText([block], cellId) ?? "" }
          : block.type === "table"
            ? null
            : { id: block.id, text: commentTextOf(block, t) };
        // Agisce solo se c'è dove commentare; altrimenti il tasto resta a chi viene dopo.
        if (!comment || !target) return;
        e.preventDefault();
        flush();
        comment(target.id, target.text);
      }}
      onDragOver={onFileDragOver}
      onDragLeave={(e) => {
        if (!container.current?.contains(e.relatedTarget as Node | null)) setFileDrop(null);
      }}
      onDrop={onFileDrop}
    >
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragStart={({ active: a }) => setDrag({ activeId: String(a.id), overId: String(a.id) })}
        onDragOver={({ over }) => setDrag((d) => (d ? { ...d, overId: over ? String(over.id) : null } : d))}
        onDragEnd={onDragEnd}
        onDragCancel={() => setDrag(null)}
        accessibility={{
          announcements,
          screenReaderInstructions: { draggable: t("productDocs.editor.handle.instructions") },
        }}
      >
        <SortableContext items={ids} strategy={stillBlocks}>
          {view.map((block, i) => {
            const layout = layoutOf(block);
            const editing = focus?.id === block.id && isTextBlock(block) ? focus : null;
            const label = blockLabel(block, t);
            const text = isTextBlock(block) ? (
              editing ? (
                <RichBlockEdit
                  id={block.id}
                  content={block.content}
                  label={label}
                  className={textClassOf(block, block.type === "todo" && block.checked)}
                  selection={editing}
                  nonce={editing.nonce}
                  placeholder={block.content.text === "" ? t("productDocs.editor.placeholder") : null}
                  listbox={
                    openSlash && items[active]
                      ? { id: listId, active: slashOptionId(listId, items[active]!.id) }
                      : openSlash
                        ? { id: listId, active: null }
                        : null
                  }
                  handlers={handlers}
                />
              ) : (
                <RichBlockRead
                  id={block.id}
                  content={block.content}
                  label={label}
                  className={textClassOf(block, block.type === "todo" && block.checked)}
                  placeholder={firstEmptyPage ? t("productDocs.editor.placeholder") : null}
                  tabStop={i === 0}
                  handlers={handlers}
                />
              )
            ) : null;
            return (
              <BlockShell
                key={block.id}
                after={
                  refusal?.anchorId === block.id ? (
                    <div ref={refusalRow} key={refusal.n}>
                      <ImageRefusalRow reason={refusal.reason} onDismiss={dismissRefusal} />
                    </div>
                  ) : null
                }
                dropNote={fileDrop === block.id ? t("productDocs.blocks.image.drop") : null}
                id={block.id}
                label={label}
                register={(el) => {
                  if (el) shells.current.set(block.id, el);
                  else shells.current.delete(block.id);
                }}
                onKeyDown={shellKey(block)}
                dropLine={drop && drag?.overId === block.id ? drop.edge : fileDrop === block.id ? "bottom" : null}
                tinted={!!bridge?.activeAnchor && anchorIdsOf(block).includes(bridge.activeAnchor)}
                style={{ paddingTop: layout.pt, paddingBottom: layout.pb, ["--block-pt" as string]: `${layout.gutterTop}px` }}
              >
                {(dragHandle) => (
                  <>
                    <BlockHandle
                      drag={dragHandle}
                      label={label}
                      line={layout.line}
                      isText={isTextBlock(block)}
                      first={i === 0}
                      last={i === view.length - 1}
                      onAdd={() => addBelow(block.id)}
                      onTurnInto={(to) => turnInto(block.id, to)}
                      onMove={(dir) => moveBlock(block.id, dir)}
                      onDuplicate={() => duplicate(block.id)}
                      onDelete={() => deleteBlock(block.id)}
                      onComment={
                        // Ogni blocco che è un'ancora (non la tabella: lì le celle, con ⌥⌘M o la selezione).
                        comment && block.type !== "table"
                          ? () => {
                              flush();
                              // La frase intera (la bozza compresa: `view` la contiene).
                              comment(block.id, commentTextOf(block, t));
                            }
                          : undefined
                      }
                    />
                    <CommentMark anchorIds={anchorIdsOf(block)} below={block.type === "table"} />
                    {isTextBlock(block) &&
                      (editing ? (
                        <RemoteBlockNote people={writersIn(others, block.id)} />
                      ) : (
                        <RemoteCursors people={writersIn(others, block.id)} contentKey={JSON.stringify(block.content)} />
                      ))}
                    <BlockBody
                      block={block}
                      page={page}
                      number={numbers[i]!}
                      onCheck={(checked) => block.type === "todo" && structure([{ op: "set", block: { ...block, checked } }])}
                      onSelectObject={() => selectShell(block.id)}
                      onCaption={(caption) => {
                        const now = blockOf(block.id);
                        if (now?.type === "image") structure([{ op: "set", block: { ...now, caption } }]);
                      }}
                      table={block.type === "table" ? tableEditing(block.id) : undefined}
                    >
                      {text}
                    </BlockBody>
                  </>
                )}
              </BlockShell>
            );
          })}
        </SortableContext>
        <DragOverlay dropAnimation={null} className={`product-block-overlay ${drop ? "" : "cursor-not-allowed"}`}>
          {dragged && (
            <div className="flex h-8 max-w-[480px] items-center rounded-md border border-rule-strong bg-surface px-3 text-sm text-ink opacity-90 shadow-[0_4px_16px_-4px_oklch(0_0_0/0.35)]">
              <span className="truncate">
                {isTextBlock(dragged) && dragged.content.text.trim() !== "" ? dragged.content.text : labelOf(dragged.id)}
              </span>
            </div>
          )}
        </DragOverlay>
      </DndContext>
      {openSlash && (
        <SlashMenu
          id={listId}
          items={items}
          active={active}
          query={slashQuery(openSlash)}
          onPick={pickSlash}
          style={floating.slash}
        />
      )}
      {picker?.kind === "drive" && (
        <DrivePicker
          id={`picker-${page.id}`}
          project={project}
          style={floating.slash}
          onPick={(file) => pickObject({ id: picker.id, type: "drive", fileId: file.id, code: file.code })}
          onClose={closePicker}
          onLeave={leavePicker}
        />
      )}
      {picker?.kind === "decision" && (
        <DecisionPicker
          id={`picker-${page.id}`}
          project={project}
          style={floating.slash}
          onPick={(decisionId) => pickObject({ id: picker.id, type: "decision", decisionId })}
          onClose={closePicker}
          onLeave={leavePicker}
        />
      )}
      {picker?.kind === "link" && (
        <LinkPicker
          id={`picker-${page.id}`}
          style={floating.slash}
          onPick={pickCode}
          onClose={closePicker}
          onLeave={leavePicker}
        />
      )}
      {/* «/image»: la scelta del file del sistema (nessun fuoco, nessun posto nella pagina). */}
      <input
        ref={fileInput}
        type="file"
        accept={PRODUCT_IMAGE_TYPES.join(",")}
        aria-label={t("productDocs.blocks.image.choose")}
        tabIndex={-1}
        hidden
        onChange={(e) => {
          const files = filesOf(e.target.files);
          const id = imageTarget.current;
          imageTarget.current = null;
          e.target.value = "";
          if (id && files.length > 0) addImages(files.slice(0, 1), { replaceId: id });
        }}
      />
      <LiveNoteRegion people={focus ? writersIn(others, focus.id) : []} />
      {showBar && focusedText && (
        <SelectionBar
          ref={barRef}
          content={focusedText.content}
          start={barStart}
          end={barEnd}
          linkOpen={linkOpen}
          style={floating.bar}
          onBold={() => applyContent(focusedText.id, toggleMark(focusedText.content, barStart, barEnd, "bold"), focus!)}
          onItalic={() => applyContent(focusedText.id, toggleMark(focusedText.content, barStart, barEnd, "italic"), focus!)}
          onLink={() => setLinkOpen(true)}
          onApplyLink={(href) => {
            setLinkOpen(false);
            applyContent(focusedText.id, setLink(focusedText.content, barStart, barEnd, href), {
              start: barStart,
              end: barEnd,
            });
          }}
          onRemoveLink={() => {
            setLinkOpen(false);
            applyContent(focusedText.id, setLink(focusedText.content, barStart, barEnd, null), {
              start: barStart,
              end: barEnd,
            });
          }}
          onCloseLink={() => {
            setLinkOpen(false);
            caret(focusedText.id, focus!.start, focus!.end);
          }}
          onComment={
            comment
              ? () => {
                  const quote = focusedText.content.text.slice(barStart, barEnd);
                  flush();
                  comment(focusedText.id, quote);
                }
              : undefined
          }
        />
      )}
    </div>
  );
}
