import type { KeyboardEvent as ReactKeyboardEvent, RefObject } from "react";
import type { ProductBlock, ProductBlockOp, RichText } from "../../../data/types";
import { isTextBlock, makeBlockId, splitBlock } from "../../../domain/productDocs/blocks";
import { deleteRange, plain, toggleMark } from "../../../domain/productDocs/richText";
import {
  filterSlashItems,
  typeShortcut,
  type SlashItem,
  type SlashItemId,
} from "../../../domain/productDocs/shortcuts";
import type { TextBlock } from "./BlockBody";
import { cloneWithIds, emptyParagraph, emptyTable, insertRich, typed } from "./blockOps";
import { editorKey, pasteBlocks } from "./keys";
import type { RichBlockHandlers, Selection } from "./RichBlock";
import type { EditorSession } from "./useEditorSession";

// I gesti dell'editor (Task 8, shape product-editor.md §3.3–§3.11): dividere,
// unire, spostare, eliminare, rientrare, «/», i segni, l'incolla, i tasti di
// un blocco e di un blocco selezionato come oggetto. `BlockEditor` tiene lo
// stato (bozze, fuoco, menu) e lo passa qui a ogni disegno.

export interface Focus extends Selection {
  id: string;
  nonce: number;
}

export interface Slash {
  id: string;
  active: number;
  /** Aperto da «+»: il filtro è tutto il testo (nessun «/»). */
  viaPlus: boolean;
  /** Il blocco il cui «+» l'ha aperto. */
  from?: string;
}

/** Lo stato dell'editor che i gesti leggono e cambiano. */
export interface GestureContext {
  t: (key: string, opts?: Record<string, unknown>) => string;
  viewRef: RefObject<ProductBlock[]>;
  sessionRef: RefObject<EditorSession>;
  draftsRef: RefObject<ReadonlyMap<string, ProductBlock>>;
  setDrafts: (next: ReadonlyMap<string, ProductBlock>) => void;
  setDraft: (block: ProductBlock) => void;
  focusRef: RefObject<Focus | null>;
  setFocus: (next: Focus | null) => void;
  caret: (id: string, start: number, end?: number) => void;
  slashRef: RefObject<Slash | null>;
  setSlash: (next: Slash | null) => void;
  linkOpen: boolean;
  setLinkOpen: (open: boolean) => void;
  flush: () => void;
  structure: (ops: ProductBlockOp[]) => void;
  selectShell: (id: string) => void;
  focusBlock: (block: ProductBlock, at: "start" | "end") => void;
  relocating: RefObject<boolean>;
  pendingShell: RefObject<string | null>;
  container: RefObject<HTMLDivElement | null>;
  /** Una tabella nuova: il fuoco nella sua prima cella dopo il disegno. */
  pendingCell: RefObject<string | null>;
  blockOf: (id: string) => ProductBlock | null;
  indexOf: (id: string) => number;
  /** Il blocco intero al posto del suo id (la sua bozza se ne va): una scrittura. */
  replaceBlock: (block: ProductBlock) => void;
  /** Le immagini incollate, scelte o trascinate (Task 9). */
  addImages: (files: File[], at: { afterId: string } | { replaceId: string }) => void;
  /** «/image»: la scelta del file del sistema, per il blocco `id`. */
  chooseImage: (id: string) => void;
  /** «/drive», «/decision», «/link»: il selettore al blocco `id`. */
  openPicker: (kind: "drive" | "decision" | "link", id: string) => void;
}

export function makeGestures(ctx: GestureContext) {
  const {
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
    addImages,
    chooseImage,
    openPicker,
  } = ctx;

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
    // Un doppio clic su «+» non fa due paragrafi: quello appena messo, ancora
    // vuoto e col suo menu aperto, è già la risposta al primo clic.
    const open = slashRef.current;
    if (open?.viaPlus && open.from === id) {
      const placed = blockOf(open.id);
      if (placed && isTextBlock(placed) && placed.content.text === "") return;
    }
    const p = emptyParagraph();
    structure([{ op: "insert", afterId: id, block: p }]);
    caret(p.id, 0);
    setSlash({ id: p.id, active: 0, viaPlus: true, from: id });
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
    filterSlashItems(slashQuery(s), (key) => t(key));

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
      replaceBlock(emptyTable(s.id));
      // Il fuoco nella prima cella (§3.10), dopo il disegno.
      pendingCell.current = s.id;
      setFocus(null);
      return;
    }
    if (item.id === "image" || item.id === "drive" || item.id === "decision" || item.id === "link") {
      // Il «/…» se ne va: il blocco resta vuoto finché non si sceglie (annullare lo lascia così).
      const block = blockOf(s.id);
      if (block && isTextBlock(block) && block.content.text !== "") {
        setDraft({ ...block, content: plain("") } as ProductBlock);
      }
      caret(s.id, 0);
      if (item.id === "image") chooseImage(s.id);
      else openPicker(item.id, s.id);
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
      // Un'immagine dagli appunti: un blocco dopo quello col fuoco ([PE 9]).
      if (clip.files && clip.files.length > 0) {
        addImages(clip.files, { afterId: id });
        return;
      }
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
      // Più righe: un paragrafo per riga, dopo il blocco corrente; la
      // selezione se ne va come con una riga sola (nella stessa scrittura).
      const cut: ProductBlockOp[] =
        sel.start === sel.end
          ? []
          : [{ op: "set", block: { ...block, content: deleteRange(block.content, sel.start, sel.end) } as ProductBlock }];
      let afterId = id;
      const ops: ProductBlockOp[] = pasted.map((b) => {
        const op: ProductBlockOp = { op: "insert", afterId, block: b };
        afterId = b.id;
        return op;
      });
      structure([...cut, ...ops]);
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
    } else if (e.key === "Enter" && (block.type === "table" || block.type === "image")) {
      // Invio entra nella prima cella, o nella didascalia.
      const inner = e.currentTarget.querySelector<HTMLElement>(
        block.type === "table" ? "[data-table-cell] [role=textbox]" : "figcaption input",
      );
      if (inner) {
        e.preventDefault();
        inner.focus();
      }
    } else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
      const at = indexOf(block.id);
      const next = viewRef.current[e.key === "ArrowUp" ? at - 1 : at + 1];
      if (!next) return;
      e.preventDefault();
      focusBlock(next, e.key === "ArrowUp" ? "end" : "start");
    }
  };

  return {
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
  };
}
