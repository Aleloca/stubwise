import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type Ref,
} from "react";
import { useTranslation } from "react-i18next";
import type { ProductBlock, ProductBlockOp, ProductPageView, RichText } from "../../../data/types";
import { isTextBlock, makeBlockId, splitBlock } from "../../../domain/productDocs/blocks";
import {
  concatRich,
  deleteRange,
  plain,
  setLink,
  splitRich,
  toggleMark,
} from "../../../domain/productDocs/richText";
import {
  filterSlashItems,
  typeShortcut,
  type SlashItem,
  type SlashItemId,
} from "../../../domain/productDocs/shortcuts";
import { BlockHandle } from "./BlockHandle";
import { editorKey, pasteBlocks } from "./keys";
import { RichBlockEdit, RichBlockRead, RichReadOnly, type RichBlockHandlers, type Selection } from "./RichBlock";
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

type TextBlock = Extract<ProductBlock, { content: RichText }>;

/** Le voci del menu «/» che l'editor sa già mettere; il Task 9 aggiunge immagine, Drive, collegamento e decisione. */
const READY: ReadonlySet<SlashItemId> = new Set<SlashItemId>([
  "heading1",
  "heading2",
  "heading3",
  "paragraph",
  "bullet",
  "numbered",
  "todo",
  "quote",
  "divider",
  "table",
]);

const SAVE_AFTER_MS = 800;

/** Lo spazio sopra e sotto, e l'altezza della prima riga (per la maniglia), dalla tabella §3.2. */
function layoutOf(block: ProductBlock): { pt: number; pb: number; line: number; gutterTop: number } {
  switch (block.type) {
    case "heading":
      return [
        { pt: 28, pb: 8, line: 26, gutterTop: 28 },
        { pt: 20, pb: 6, line: 22, gutterTop: 20 },
        { pt: 16, pb: 4, line: 20, gutterTop: 16 },
      ][block.level - 1]!;
    case "paragraph":
      return { pt: 0, pb: 8, line: 22, gutterTop: 0 };
    case "bullet":
    case "numbered":
    case "todo":
      return { pt: 0, pb: 4, line: 22, gutterTop: 0 };
    case "quote":
      return { pt: 8, pb: 8, line: 22, gutterTop: 8 };
    case "divider":
      return { pt: 16, pb: 16, line: 20, gutterTop: 6 };
    default:
      return { pt: 12, pb: 12, line: 20, gutterTop: 21 };
  }
}

const TEXT_CLASS: Record<string, string> = {
  heading1: "text-xl font-semibold text-balance text-ink",
  heading2: "text-lg font-semibold text-balance text-ink",
  heading3: "text-md font-semibold text-ink",
  paragraph: "text-md leading-[22px] text-pretty text-ink",
  list: "text-md leading-[22px] text-ink",
  quote: "text-md leading-[22px] text-ink-muted",
};

const textClassOf = (block: TextBlock, checked = false) =>
  block.type === "heading"
    ? TEXT_CLASS[`heading${block.level}`]!
    : block.type === "quote"
      ? TEXT_CLASS.quote!
      : block.type === "paragraph"
        ? TEXT_CLASS.paragraph!
        : `${TEXT_CLASS.list!}${checked ? " text-ink-muted" : ""}`;

/** Il blocco di testo di un tipo del menu «/» (o di «Turn into»), con la sua frase. */
function typed(id: string, to: SlashItemId, content: RichText): ProductBlock {
  switch (to) {
    case "heading1":
    case "heading2":
    case "heading3":
      return { id, type: "heading", level: Number(to.slice(-1)) as 1 | 2 | 3, content };
    case "bullet":
    case "numbered":
      return { id, type: to, content, indent: 0 };
    case "todo":
      return { id, type: "todo", content, checked: false };
    case "quote":
      return { id, type: "quote", content };
    default:
      return { id, type: "paragraph", content };
  }
}

/** Un blocco con id nuovi (anche righe e celle): «Duplicate». */
function cloneWithIds(block: ProductBlock): ProductBlock {
  if (block.type === "table") {
    return {
      ...block,
      id: makeBlockId(),
      rows: block.rows.map((r) => ({ id: makeBlockId(), cells: r.cells.map((c) => ({ ...c, id: makeBlockId() })) })),
    };
  }
  return { ...block, id: makeBlockId() };
}

const emptyParagraph = (): ProductBlock => ({ id: makeBlockId(), type: "paragraph", content: plain("") });

/** Una tabella 2×2 vuota, ogni riga e cella col suo id. */
const emptyTable = (id: string): ProductBlock => ({
  id,
  type: "table",
  rows: [0, 1].map(() => ({ id: makeBlockId(), cells: [0, 1].map(() => ({ id: makeBlockId(), content: plain("") })) })),
});

/** Inserisce una frase coi suoi segni in `at`: i segni attorno non la prendono. */
function insertRich(rt: RichText, at: number, piece: RichText): RichText {
  const [a, b] = splitRich(rt, at);
  return concatRich(concatRich(a, piece), b);
}

/** Le voci numerate contano di fila, per rientro; un altro blocco riparte da 1. */
function numbersOf(blocks: readonly ProductBlock[]): number[] {
  const counters: number[] = [];
  return blocks.map((block) => {
    if (block.type !== "numbered") {
      counters.length = 0;
      return 0;
    }
    counters.length = block.indent + 1;
    counters[block.indent] = (counters[block.indent] ?? 0) + 1;
    return counters[block.indent]!;
  });
}

export interface BlockEditorHandle {
  /** Il fuoco nel primo blocco (Invio dal titolo). */
  focusFirst(): void;
}

interface Focus extends Selection {
  id: string;
  nonce: number;
}

interface Slash {
  id: string;
  active: number;
  /** Aperto da «+»: il filtro è tutto il testo (nessun «/»). */
  viaPlus: boolean;
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

// --- chi legge soltanto ------------------------------------------------------

function ReadOnlyBody({ page }: { page: ProductPageView }) {
  const numbers = numbersOf(page.blocks);
  return (
    <div data-editor-body="" className="flex flex-col">
      {page.blocks.map((block, i) => {
        // I blocchi vuoti non occupano spazio per chi legge (§5).
        if (isTextBlock(block) && block.content.text.trim() === "") return null;
        const { pt, pb } = layoutOf(block);
        return (
          <div key={block.id} data-block-id={block.id} style={{ paddingTop: pt, paddingBottom: pb }}>
            <BlockBody block={block} page={page} number={numbers[i]!}>
              {isTextBlock(block) && (
                <RichReadOnly content={block.content} className={textClassOf(block, block.type === "todo" && block.checked)} />
              )}
            </BlockBody>
          </div>
        );
      })}
    </div>
  );
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

  // --- i gesti ----------------------------------------------------------------

  const split = (block: TextBlock, sel: Selection) => {
    const base = sel.start === sel.end ? block : { ...block, content: deleteRange(block.content, sel.start, sel.end) };
    const [first, second] = splitBlock(base, sel.start, makeBlockId());
    structure([
      { op: "set", block: first },
      { op: "insert", afterId: block.id, block: second },
    ]);
    caret(second.id, 0);
  };

  const mergeIntoPrevious = (block: TextBlock) => {
    const at = indexOf(block.id);
    const prev = at > 0 ? viewRef.current[at - 1]! : null;
    if (!prev) return;
    if (!isTextBlock(prev)) {
      // Sopra un blocco che non è testo: lo si seleziona invece di unire.
      flush();
      selectShell(prev.id);
      return;
    }
    const offset = prev.content.text.length;
    structure([{ op: "merge", firstId: prev.id, secondId: block.id }]);
    caret(prev.id, offset);
  };

  const moveBlock = (id: string, dir: "up" | "down") => {
    const list = viewRef.current;
    const at = list.findIndex((b) => b.id === id);
    if (at < 0 || (dir === "up" && at === 0) || (dir === "down" && at === list.length - 1)) return;
    const afterId = dir === "up" ? (at >= 2 ? list[at - 2]!.id : null) : list[at + 1]!.id;
    relocating.current = true;
    structure([{ op: "move", blockId: id, afterId }]);
    const f = focusRef.current;
    if (f?.id === id) caret(id, f.start, f.end);
    else pendingShell.current = id;
  };

  const deleteBlock = (id: string) => {
    const list = viewRef.current;
    const at = list.findIndex((b) => b.id === id);
    if (at < 0) return;
    if (list.length === 1) {
      // L'ultimo blocco non se ne va: torna un paragrafo vuoto (la pagina resta scrivibile).
      structure([{ op: "set", block: { id, type: "paragraph", content: plain("") } }]);
      caret(id, 0);
      return;
    }
    structure([{ op: "delete", blockId: id }]);
    const near = list[at + 1] ?? list[at - 1]!;
    focusBlock(near, at + 1 < list.length ? "start" : "end");
  };

  const indent = (block: TextBlock, by: 1 | -1) => {
    if (block.type !== "bullet" && block.type !== "numbered") return;
    const next = Math.max(0, Math.min(2, block.indent + by)) as 0 | 1 | 2;
    if (next === block.indent) return;
    structure([{ op: "set", block: { ...block, indent: next } }]);
  };

  const turnInto = (id: string, to: SlashItemId) => {
    const block = blockOf(id);
    if (!block || !isTextBlock(block)) return;
    const next = typed(id, to, block.content);
    // Lo stesso rientro, se resta un elenco.
    if ((next.type === "bullet" || next.type === "numbered") && (block.type === "bullet" || block.type === "numbered"))
      next.indent = block.indent;
    structure([{ op: "set", block: next }]);
    caret(id, block.content.text.length);
  };

  const addBelow = (id: string) => {
    const p = emptyParagraph();
    structure([{ op: "insert", afterId: id, block: p }]);
    caret(p.id, 0);
    setSlash({ id: p.id, active: 0, viaPlus: true });
  };

  const duplicate = (id: string) => {
    const block = blockOf(id);
    if (!block) return;
    const copy = cloneWithIds(block);
    structure([{ op: "insert", afterId: id, block: copy }]);
    focusBlock(copy, "end");
  };

  // --- «/» --------------------------------------------------------------------

  const slashQuery = (s: Slash | null): string => {
    if (!s) return "";
    const block = blockOf(s.id);
    const text = block && isTextBlock(block) ? block.content.text : "";
    return s.viaPlus ? text : text.slice(1);
  };
  const slashItems = (s: Slash | null): SlashItem[] =>
    filterSlashItems(slashQuery(s), (key) => t(key)).filter((i) => READY.has(i.id));

  const pickSlash = (item: SlashItem) => {
    const s = slashRef.current;
    if (!s) return;
    setSlash(null);
    // La bozza «/tab» se ne va: il blocco diventa ciò che si è scelto.
    const rest = new Map(draftsRef.current);
    rest.delete(s.id);
    setDrafts(rest);
    flush();
    if (item.id === "divider") {
      const p = emptyParagraph();
      sessionRef.current.save([
        { op: "set", block: { id: s.id, type: "divider" } },
        { op: "insert", afterId: s.id, block: p },
      ]);
      caret(p.id, 0);
      return;
    }
    if (item.id === "table") {
      sessionRef.current.save([{ op: "set", block: emptyTable(s.id) }]);
      selectShell(s.id);
      return;
    }
    sessionRef.current.save([{ op: "set", block: typed(s.id, item.id, plain("")) }]);
    caret(s.id, 0);
  };

  // --- i segni ---------------------------------------------------------------

  const applyContent = (id: string, content: RichText, sel: Selection) => {
    const block = blockOf(id);
    if (!block || !isTextBlock(block)) return;
    setDraft({ ...block, content } as ProductBlock);
    caret(id, sel.start, sel.end);
  };

  // --- ciò che chiede un blocco ------------------------------------------------

  const handlers: RichBlockHandlers = {
    enter(id, sel) {
      if (focusRef.current?.id === id) return;
      caret(id, sel.start, sel.end);
    },
    input(id, content, sel, inputType) {
      const block = blockOf(id);
      if (!block || !isTextBlock(block)) return;
      sessionRef.current.touch();
      const before = block.content.text;
      // Le scorciatoie digitate («## », «- », «---»…) in un paragrafo: prima
      // si salvano i caratteri scritti (⌘Z li rimette come testo), poi il tipo.
      const shortcut = inputType === "insertText" && block.type === "paragraph" ? typeShortcut(content.text) : null;
      if (shortcut && !typeShortcut(before)) {
        setDraft({ ...block, content } as ProductBlock);
        flush();
        setSlash(null);
        const cut = content.text.length - shortcut.rest.length;
        if (shortcut.type === "divider") {
          const p = emptyParagraph();
          sessionRef.current.save([
            { op: "set", block: { id, type: "divider" } },
            { op: "insert", afterId: id, block: p },
          ]);
          caret(p.id, 0);
          return;
        }
        const to: SlashItemId =
          shortcut.type === "heading" ? (`heading${shortcut.level}` as SlashItemId) : (shortcut.type as SlashItemId);
        sessionRef.current.save([{ op: "set", block: typed(id, to, deleteRange(content, 0, cut)) }]);
        caret(id, Math.max(0, sel.start - cut));
        return;
      }
      applyContent(id, content, sel);
      const s = slashRef.current;
      if (before === "" && content.text === "/") setSlash({ id, active: 0, viaPlus: false });
      else if (s?.id === id) {
        if (!s.viaPlus && !content.text.startsWith("/")) setSlash(null);
        else setSlash({ ...s, active: 0 });
      }
    },
    key(id, e, sel) {
      const block = blockOf(id);
      if (!block || !isTextBlock(block)) return false;
      const s = slashRef.current?.id === id ? slashRef.current : null;
      if (e.key !== "Shift" && e.key !== "Meta" && e.key !== "Alt" && e.key !== "Control") sessionRef.current.touch();

      if (s) {
        const items = slashItems(s);
        if (e.key === "ArrowDown" || e.key === "ArrowUp") {
          const n = items.length;
          if (n > 0) setSlash({ ...s, active: (s.active + (e.key === "ArrowDown" ? 1 : -1) + n) % n });
          return true;
        }
        if (e.key === "Enter") {
          const item = items[Math.min(s.active, items.length - 1)];
          if (item) pickSlash(item);
          return true;
        }
        if (e.key === "Escape") {
          // Esc chiude lasciando «/…» com'era nel blocco.
          setSlash(null);
          return true;
        }
        if (e.key === "Backspace" && s.viaPlus && block.content.text === "") {
          setSlash(null);
          return true;
        }
      }

      if (e.key === "Escape") {
        if (linkOpen) {
          setLinkOpen(false);
          return true;
        }
        if (sel.start !== sel.end) {
          caret(id, sel.end);
          return true;
        }
        // Esc in un blocco di testo seleziona il blocco ([PE 5]).
        flush();
        selectShell(id);
        return true;
      }
      if (e.key === "F10" && e.altKey) {
        container.current?.querySelector<HTMLButtonElement>('[role="toolbar"] button')?.focus();
        return true;
      }

      const result = editorKey(e, {
        text: block.content.text,
        caret: sel.start,
        type: block.type,
        slashOpen: s !== null,
        collapsed: sel.start === sel.end,
      });
      switch (result.kind) {
        case "none":
          // Tab fuori da un elenco non fa niente: il fuoco non esce.
          return e.key === "Tab";
        case "split":
          split(block, sel);
          return true;
        case "toParagraph":
          structure([{ op: "set", block: { id, type: "paragraph", content: block.content } }]);
          caret(id, 0);
          return true;
        case "lineBreak":
          applyContent(id, insertRich(deleteRange(block.content, sel.start, sel.end), sel.start, plain("\n")), {
            start: sel.start + 1,
            end: sel.start + 1,
          });
          return true;
        case "mergeWithPrevious":
          mergeIntoPrevious(block);
          return true;
        case "focusPrevious":
        case "focusNext": {
          const at = indexOf(id);
          const next = viewRef.current[result.kind === "focusPrevious" ? at - 1 : at + 1];
          if (!next) return false;
          focusBlock(next, result.kind === "focusPrevious" ? "end" : "start");
          return true;
        }
        case "indent":
        case "outdent":
          indent(block, result.kind === "indent" ? 1 : -1);
          return true;
        case "moveBlock":
          moveBlock(id, result.dir);
          return true;
        case "toggleMark":
          // Il keydown annullato: niente `beforeinput formatBold` dopo (ruling P18).
          if (sel.start !== sel.end) applyContent(id, toggleMark(block.content, sel.start, sel.end, result.mark), sel);
          return true;
        case "undo":
        case "redo":
          flush();
          if (result.kind === "undo") sessionRef.current.undo();
          else sessionRef.current.redo();
          return true;
        case "openSlash":
          // Il «/» entra come testo (`beforeinput`), e lì si apre il menu.
          return false;
      }
    },
    paste(id, clip, sel) {
      const block = blockOf(id);
      if (!block || !isTextBlock(block)) return;
      sessionRef.current.touch();
      const pasted = pasteBlocks(clip, makeBlockId);
      if (pasted.length === 0) return;
      if (pasted.length === 1) {
        // Una riga: al cursore, coi suoi segni.
        const piece = (pasted[0] as TextBlock).content;
        const content = insertRich(deleteRange(block.content, sel.start, sel.end), sel.start, piece);
        const at = sel.start + piece.text.length;
        applyContent(id, content, { start: at, end: at });
        return;
      }
      // Più righe: un paragrafo per riga, dopo il blocco corrente.
      let afterId = id;
      const ops: ProductBlockOp[] = pasted.map((b) => {
        const op: ProductBlockOp = { op: "insert", afterId, block: b };
        afterId = b.id;
        return op;
      });
      structure(ops);
      const last = pasted.at(-1) as TextBlock;
      caret(last.id, last.content.text.length);
    },
    select(id, sel) {
      const f = focusRef.current;
      if (f?.id !== id) return;
      // Il cursore che si muove da sé: si ricorda, senza ridisegnare.
      setFocus({ ...f, start: sel.start, end: sel.end });
    },
    leave(id, related) {
      if (relocating.current) return;
      if (focusRef.current?.id !== id) return;
      // Dentro la barra, il campo del link o il menu «/»: il blocco resta col fuoco.
      if (related?.closest?.("[data-editor-floating]")) return;
      flush();
      setFocus(null);
      setSlash(null);
      setLinkOpen(false);
    },
    history(kind) {
      flush();
      if (kind === "undo") sessionRef.current.undo();
      else sessionRef.current.redo();
    },
  };

  /** I tasti di un blocco selezionato come oggetto ([PE 5]). */
  const shellKey = (block: ProductBlock) => (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget) return;
    const mod = e.metaKey !== e.ctrlKey;
    if (mod && !e.altKey && e.key.toLowerCase() === "z") {
      e.preventDefault();
      flush();
      if (e.shiftKey) sessionRef.current.redo();
      else sessionRef.current.undo();
      return;
    }
    if (e.altKey && e.shiftKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
      e.preventDefault();
      moveBlock(block.id, e.key === "ArrowUp" ? "up" : "down");
      return;
    }
    if (mod || e.altKey || e.shiftKey) return;
    if (e.key === "Backspace" || e.key === "Delete") {
      e.preventDefault();
      deleteBlock(block.id);
    } else if (e.key === "Enter" && isTextBlock(block)) {
      e.preventDefault();
      caret(block.id, block.content.text.length);
    } else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
      const at = indexOf(block.id);
      const next = viewRef.current[e.key === "ArrowUp" ? at - 1 : at + 1];
      if (!next) return;
      e.preventDefault();
      focusBlock(next, e.key === "ArrowUp" ? "end" : "start");
    }
  };

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

  const firstEmptyPage = view.length === 1 && isTextBlock(view[0]!) && view[0]!.content.text === "";

  return (
    <div ref={container} data-editor-body="" aria-label={t("productDocs.editor.body")} role="group" className="relative flex flex-col">
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
          <div
            key={block.id}
            ref={(el) => {
              if (el) shells.current.set(block.id, el);
              else shells.current.delete(block.id);
            }}
            data-block-id={block.id}
            tabIndex={-1}
            aria-label={label}
            onKeyDown={shellKey(block)}
            style={{ paddingTop: layout.pt, paddingBottom: layout.pb, ["--block-pt" as string]: `${layout.gutterTop}px` }}
            className="group/block relative rounded-lg focus:outline-2 focus:outline-offset-2 focus:outline-focus focus:outline-solid"
          >
            <BlockHandle
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
          </div>
        );
      })}
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

/** Il nome accessibile di un blocco, dal tipo (§7). */
function blockLabel(block: ProductBlock, t: (key: string, opts?: Record<string, unknown>) => string): string {
  switch (block.type) {
    case "heading":
      return t("productDocs.editor.blocks.heading", { level: block.level });
    case "bullet":
    case "numbered":
      return t(`productDocs.editor.blocks.${block.type}`, { level: block.indent + 1 });
    case "paragraph":
    case "todo":
    case "quote":
    case "divider":
      return t(`productDocs.editor.blocks.${block.type}`);
    case "table":
      return t("productDocs.space.blockTable");
    case "image":
      return t("productDocs.space.blockImage");
    case "drive":
      return t("productDocs.space.blockDrive", { code: block.code });
    case "decision":
      return t("productDocs.space.blockDecision");
  }
}

/**
 * Ciò che sta intorno al testo di un blocco: il titolo (h2–h4), il segno
 * dell'elenco, la casella, il filetto della citazione; e i blocchi che non
 * sono testo, finché il Task 9 non li disegna (un segnaposto da leggere).
 */
function BlockBody({
  block,
  page,
  number,
  onCheck,
  onSelectObject,
  children,
}: {
  block: ProductBlock;
  page: ProductPageView;
  number: number;
  onCheck?: (checked: boolean) => void;
  onSelectObject?: () => void;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  switch (block.type) {
    case "heading": {
      const Tag = (["h2", "h3", "h4"] as const)[block.level - 1]!;
      return <Tag>{children}</Tag>;
    }
    case "paragraph":
      return <>{children}</>;
    case "quote":
      return <blockquote className="border-l-2 border-rule-strong pl-3">{children}</blockquote>;
    case "bullet":
    case "numbered":
      return (
        <div style={{ paddingLeft: 24 * (block.indent + 1) }} className="relative">
          <span
            aria-hidden="true"
            style={{ left: 24 * block.indent }}
            className="num absolute top-0 w-6 pr-2 text-right text-md leading-[22px] text-ink-muted"
          >
            {block.type === "bullet" ? "•" : `${number}.`}
          </span>
          {children}
        </div>
      );
    case "todo":
      return (
        <div className="flex items-start gap-2">
          <input
            type="checkbox"
            checked={block.checked}
            disabled={!onCheck}
            aria-label={t("productDocs.editor.blocks.done")}
            onChange={(e) => onCheck?.(e.target.checked)}
            className="mt-[3px] size-4 shrink-0 accent-ink disabled:opacity-100"
          />
          <div className="min-w-0 flex-1">{children}</div>
        </div>
      );
    case "divider":
      return <hr className="border-rule" onMouseDown={onSelectObject} />;
    default:
      return <Placeholder block={block} page={page} onSelect={onSelectObject} />;
  }
}

/** Un blocco che il Task 9 disegnerà: una riga tenue da leggere (ruling P17). */
function Placeholder({
  block,
  page,
  onSelect,
}: {
  block: Exclude<ProductBlock, { content: RichText }>;
  page: ProductPageView;
  onSelect?: () => void;
}) {
  const { t } = useTranslation();
  let text: string;
  switch (block.type) {
    case "table":
      text = t("productDocs.space.blockTable");
      break;
    case "image":
      text = block.caption || t("productDocs.space.blockImage");
      break;
    case "drive":
      text = t("productDocs.space.blockDrive", { code: block.code });
      break;
    case "decision": {
      // Una decisione che chi legge non vede non dice titolo né data (R-G5).
      const d = page.decisions[block.decisionId];
      text = d ? d.title : t("productDocs.space.blockDecision");
      break;
    }
    default:
      text = "";
  }
  return (
    <p
      data-block-placeholder={block.type}
      onMouseDown={(e) => {
        if (!onSelect) return;
        e.preventDefault();
        onSelect();
      }}
      className="rounded-lg border border-dashed border-rule px-3 py-2 text-sm text-ink-muted"
    >
      {text}
    </p>
  );
}
