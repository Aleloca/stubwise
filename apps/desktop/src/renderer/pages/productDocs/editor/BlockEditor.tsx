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
  type Ref,
} from "react";
import { useTranslation } from "react-i18next";
import type { ProductBlock, ProductBlockOp, ProductPageView } from "../../../data/types";
import { isTextBlock } from "../../../domain/productDocs/blocks";
import { setLink, toggleMark } from "../../../domain/productDocs/richText";
import { BlockBody, ReadOnlyBody, blockLabel, layoutOf, numbersOf, textClassOf } from "./BlockBody";
import { BlockHandle } from "./BlockHandle";
import { dropAfter } from "./blockOps";
import { BlockShell } from "./BlockShell";
import { makeGestures, type Focus, type Slash } from "./gestures";
import { RichBlockEdit, RichBlockRead } from "./RichBlock";
import { SelectionBar, linkAt } from "./SelectionBar";
import { SlashMenu, slashOptionId } from "./SlashMenu";
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
// ([PE 15]). I blocchi che il Task 9 disegna (tabella, immagine, file del
// Drive, decisione) qui sono un segnaposto da leggere (ruling P17).
// Il disegno dei blocchi sta in `BlockBody`, i gesti in `gestures`, i
// blocchi che i gesti scrivono in `blockOps`. Un blocco si trascina per ⋮⋮
// ([PE 4]): una scrittura sola, un `move`; lasciato dov'era, niente.

const SAVE_AFTER_MS = 800;

/** I blocchi non si spostano mentre se ne trascina uno: l'arrivo è una linea ([PS 12]). */
const stillBlocks = () => null;

export interface BlockEditorHandle {
  /** Il fuoco nel primo blocco (Invio dal titolo). */
  focusFirst(): void;
}

export function BlockEditor({
  page,
  session,
  editable,
  handle,
}: {
  page: ProductPageView;
  session: EditorSession;
  editable: boolean;
  handle?: Ref<BlockEditorHandle>;
}) {
  if (!editable) return <ReadOnlyBody page={page} />;
  return <WritableBody page={page} session={session} handle={handle} />;
}

// --- chi scrive --------------------------------------------------------------

function WritableBody({
  page,
  session,
  handle,
}: {
  page: ProductPageView;
  session: EditorSession;
  handle?: Ref<BlockEditorHandle>;
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
  /** Un blocco da selezionare come oggetto dopo il prossimo disegno. */
  const pendingShell = useRef<string | null>(null);
  /** Un gesto che sposta il blocco col fuoco: il blur del DOM non è un'uscita. */
  const relocating = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const view = session.blocks.map((b) => drafts.get(b.id) ?? b);
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

  const setDraft = (block: ProductBlock) => {
    const next = new Map(draftsRef.current);
    next.set(block.id, block);
    setDrafts(next);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(flush, SAVE_AFTER_MS);
  };

  // Uscire dalla pagina (o cambiare persona) salva ciò che resta.
  useEffect(() => () => flush(), [flush]);

  /** Seleziona un blocco come oggetto (anello di fuoco), dopo il disegno. */
  const selectShell = (id: string) => {
    pendingShell.current = id;
    setFocus(null);
    setSlash(null);
    setLinkOpen(false);
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
    blockOf,
    indexOf,
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
      const below = (view?.bottom ?? window.innerHeight) - r.bottom - 8;
      const above = r.top - (view?.top ?? 0) - 8;
      slashStyle =
        below < 320 && above > below
          ? { top: shell.offsetTop, left: 0, transform: "translateY(-100%)", maxHeight: Math.min(320, above) }
          : { top: shell.offsetTop + shell.offsetHeight, left: 0, maxHeight: Math.max(Math.min(320, below), 160) };
    }
    setFloating((prev) => {
      // La barra resta dov'è quando il fuoco va nel campo del link (la
      // selezione allora non è più nel blocco): si misura solo lì dentro.
      let barStyle = prev.bar;
      const sel = document.getSelection();
      const editingEl = container.current?.querySelector("[data-editing]");
      if (sel && sel.rangeCount > 0 && editingEl?.contains(sel.getRangeAt(0).startContainer)) {
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
  }, [focus, openSlash, showBar, linkOpen]);

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
    <div ref={container} data-editor-body="" aria-label={t("productDocs.editor.body")} role="group" className="relative flex flex-col">
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
                id={block.id}
                label={label}
                register={(el) => {
                  if (el) shells.current.set(block.id, el);
                  else shells.current.delete(block.id);
                }}
                onKeyDown={shellKey(block)}
                dropLine={drop && drag?.overId === block.id ? drop.edge : null}
                style={{ paddingTop: layout.pt, paddingBottom: layout.pb, ["--block-pt" as string]: `${layout.gutterTop}px` }}
              >
                {(dragListeners) => (
                  <>
                    <BlockHandle
                      dragListeners={dragListeners}
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
                    />
                    <BlockBody
                      block={block}
                      page={page}
                      number={numbers[i]!}
                      onCheck={(checked) => block.type === "todo" && structure([{ op: "set", block: { ...block, checked } }])}
                      onSelectObject={() => selectShell(block.id)}
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
      {showBar && focusedText && (
        <SelectionBar
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
        />
      )}
    </div>
  );
}
