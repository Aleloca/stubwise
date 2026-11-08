import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import type { ProductBlock, RichText } from "../../../data/types";
import { makeBlockId } from "../../../domain/productDocs/blocks";
import { concatRich, deleteRange, plain, setLink, toggleMark } from "../../../domain/productDocs/richText";
import { itemClass } from "../../../tasks-ui/Menu";
import { MenuButton } from "../../tasks/controls";
import { insertRich, tableAdd, tableRemove } from "./blockOps";
import { pastedImages } from "./images";
import { pasteBlocks } from "./keys";
import { RichBlockEdit, RichBlockRead, RichReadOnly, type RichBlockHandlers, type Selection } from "./RichBlock";
import { useCommentGesture } from "../comments/SelectionCommentButton";
import { SelectionBar, linkAt } from "./SelectionBar";

// La tabella (shape product-editor.md §3.10, [PE 13]): griglia 1 px `rule`,
// celle 8×12, 14/20, colonne di almeno 120 e lo scorrimento orizzontale
// dentro la tabella. Ogni cella è una frase coi suoi segni e un'ancora a sé.
// Per chi scrive ogni cella è il `contenteditable` controllato dei blocchi
// di testo; le bozze della tabella vanno all'editor come bozza del blocco
// (un `set` della tabella all'uscita). Tab / ⇧Tab fra le celle, a capo di
// riga; Tab sull'ultima cella esce al blocco dopo; ↑/↓ dalla prima/ultima
// riga escono, ⇧Tab sulla prima esce al blocco prima. La barra della
// selezione c'è anche nelle celle (§3.5). Un'immagine incollata in una cella
// va sotto la tabella (fix round 1). «⋯» in alto a destra: Add row · Add
// column · Remove row · Remove column, sulla riga e la colonna della cella
// col fuoco (anche dopo il clic su «⋯»); senza una cella col fuoco, sulla
// prima cella.

export type Table = Extract<ProductBlock, { type: "table" }>;

/** Ciò che la tabella chiede all'editor. */
export interface TableEditing {
  /** La tabella con una cella cambiata: la bozza del blocco. */
  draft(table: Table): void;
  /** Un gesto di struttura (righe, colonne): un `set` della tabella. */
  replace(table: Table): void;
  /** Il fuoco esce dalla tabella: la bozza si salva. */
  leave(): void;
  /** Uscire dalla tabella al blocco prima o dopo. */
  exit(dir: "prev" | "next"): void;
  /** Esc: la tabella diventa l'oggetto selezionato. */
  select(): void;
  /** ⌘Z / ⇧⌘Z dell'editor. */
  history(kind: "undo" | "redo"): void;
  /** Un tasto: «Saved» sparisce. */
  touch(): void;
  /** Le immagini incollate in una cella: vanno sotto la tabella. */
  images(files: File[]): void;
  /** La cella col fuoco e il cursore (`null` = nessuna): la presenza di chi scrive (Task 11). */
  focusCell(at: { id: string; start: number; end: number } | null): void;
}

interface CellFocus extends Selection {
  id: string;
  nonce: number;
}

const cellClass = "min-w-[120px] border border-rule px-3 py-2 align-top";
const textClass = "text-md leading-5 text-ink";

export function TableBlock({ block, editing }: { block: Table; editing?: TableEditing }) {
  const { t } = useTranslation();
  if (!editing) {
    return (
      <div className="overflow-x-auto">
        <table className="border-collapse">
          <tbody>
            {block.rows.map((row) => (
              <tr key={row.id}>
                {row.cells.map((cell) => (
                  <td key={cell.id} data-anchor-id={cell.id} className={cellClass}>
                    <RichReadOnly content={cell.content} className={textClass} />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        <span className="sr-only">{t("productDocs.space.blockTable")}</span>
      </div>
    );
  }
  return <WritableTable block={block} editing={editing} />;
}

/** Il menu «⋯» della tabella si apre a destra se ci sta (240 px prima del bordo visibile), altrimenti a sinistra. */
function menuAlignFor(el: HTMLElement): "left" | "right" {
  const right = el.closest(".overflow-y-auto")?.getBoundingClientRect().right ?? window.innerWidth;
  return el.getBoundingClientRect().left + 240 <= right ? "left" : "right";
}

function WritableTable({ block, editing }: { block: Table; editing: TableEditing }) {
  const { t } = useTranslation();
  /** «Comment» su una selezione nella cella (Task 10): l.ancora è la cella. */
  const comment = useCommentGesture();
  const [focus, setFocusState] = useState<CellFocus | null>(null);
  const focusRef = useRef(focus);
  const nonce = useRef(0);
  const setFocus = (next: CellFocus | null) => {
    focusRef.current = next;
    setFocusState(next);
  };
  const caret = (id: string, start: number, end = start) => setFocus({ id, start, end, nonce: ++nonce.current });
  /** La riga e la colonna dell'ultima cella col fuoco: le usa «⋯» anche dopo che il fuoco è andato sul bottone. */
  const [last, setLast] = useState<{ row: number; col: number } | null>(null);
  const [linkOpen, setLinkOpen] = useState(false);
  const [menuAlign, setMenuAlign] = useState<"left" | "right">("left");
  const wrapper = useRef<HTMLDivElement>(null);

  const tableRef = useRef(block);
  tableRef.current = block;
  const editingRef = useRef(editing);
  editingRef.current = editing;

  const cells = () => tableRef.current.rows.flatMap((r, row) => r.cells.map((c, col) => ({ cell: c, row, col })));
  const posOf = (id: string) => cells().find((c) => c.cell.id === id) ?? null;
  const withCell = (id: string, content: RichText): Table => ({
    ...tableRef.current,
    rows: tableRef.current.rows.map((r) => ({
      ...r,
      cells: r.cells.map((c) => (c.id === id ? { ...c, content } : c)),
    })),
  });
  const goTo = (row: number, col: number, at: "start" | "end") => {
    const target = tableRef.current.rows[row]?.cells[col];
    if (!target) return false;
    setLast({ row, col });
    caret(target.id, at === "start" ? 0 : target.content.text.length);
    return true;
  };
  const exit = (dir: "prev" | "next") => {
    setFocus(null);
    editingRef.current.exit(dir);
  };

  // La cella col fuoco va all'editor, che la manda agli altri come presenza.
  useEffect(() => {
    editingRef.current.focusCell(focus ? { id: focus.id, start: focus.start, end: focus.end } : null);
  }, [focus?.id, focus?.start, focus?.end]);
  useEffect(() => () => editingRef.current.focusCell(null), []);

  const handlers: RichBlockHandlers = {
    enter(id, sel) {
      if (focusRef.current?.id === id) return;
      const pos = posOf(id);
      if (pos) setLast({ row: pos.row, col: pos.col });
      caret(id, sel.start, sel.end);
    },
    input(id, content, sel) {
      editingRef.current.touch();
      editingRef.current.draft(withCell(id, content));
      caret(id, sel.start, sel.end);
    },
    key(id, e, sel) {
      const pos = posOf(id);
      if (!pos) return false;
      const { rows } = tableRef.current;
      const width = rows[pos.row]!.cells.length;
      const text = pos.cell.content.text;
      const mod = e.metaKey !== e.ctrlKey;
      if (!["Shift", "Meta", "Alt", "Control"].includes(e.key)) editingRef.current.touch();
      if (e.key === "Tab") {
        const flat = pos.row * width + pos.col + (e.shiftKey ? -1 : 1);
        if (flat < 0) {
          exit("prev");
          return true;
        }
        if (flat >= rows.length * width) {
          exit("next");
          return true;
        }
        goTo(Math.floor(flat / width), flat % width, "end");
        return true;
      }
      if (e.key === "Enter" && !e.shiftKey && !mod) {
        // Invio va alla cella sotto (l'ultima riga esce): ⇧Invio va a capo nella cella.
        if (!goTo(pos.row + 1, pos.col, "end")) exit("next");
        return true;
      }
      if (e.key === "Enter" && e.shiftKey) {
        const content = insertRich(deleteRange(pos.cell.content, sel.start, sel.end), sel.start, plain("\n"));
        editingRef.current.draft(withCell(id, content));
        caret(id, sel.start + 1);
        return true;
      }
      if (e.key === "ArrowUp" && !e.altKey && sel.start === sel.end && sel.start === 0) {
        if (!goTo(pos.row - 1, pos.col, "end")) exit("prev");
        return true;
      }
      if (e.key === "ArrowDown" && !e.altKey && sel.start === sel.end && sel.end === text.length) {
        if (!goTo(pos.row + 1, pos.col, "start")) exit("next");
        return true;
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
        setFocus(null);
        editingRef.current.leave();
        editingRef.current.select();
        return true;
      }
      if (mod && !e.altKey && (e.key.toLowerCase() === "b" || e.key.toLowerCase() === "i")) {
        if (sel.start !== sel.end) {
          const mark = e.key.toLowerCase() === "b" ? "bold" : "italic";
          editingRef.current.draft(withCell(id, toggleMark(pos.cell.content, sel.start, sel.end, mark)));
          caret(id, sel.start, sel.end);
        }
        return true;
      }
      if (mod && !e.altKey && e.key.toLowerCase() === "z") {
        setFocus(null);
        editingRef.current.leave();
        editingRef.current.history(e.shiftKey ? "redo" : "undo");
        return true;
      }
      // ⌘K resta la palette; il resto lo scrive `beforeinput`.
      return false;
    },
    paste(id, clip, sel) {
      const pos = posOf(id);
      if (!pos) return;
      editingRef.current.touch();
      const images = pastedImages(clip);
      if (images.length > 0) {
        editingRef.current.images(images);
        return;
      }
      // In una cella tutto entra al cursore, una riga per a capo.
      const pasted = pasteBlocks(clip, makeBlockId);
      // Una tabella incollata in una cella: una riga per riga, le celle separate da uno spazio.
      const lines = pasted.flatMap((b) =>
        "content" in b
          ? [b.content]
          : b.type === "table"
            ? b.rows.map((r) => plain(r.cells.map((c) => c.content.text).join(" ")))
            : [],
      );
      if (lines.length === 0) return;
      const piece = lines.slice(1).reduce((acc, rt) => concatRich(concatRich(acc, plain("\n")), rt), lines[0]!);
      const content = insertRich(deleteRange(pos.cell.content, sel.start, sel.end), sel.start, piece);
      editingRef.current.draft(withCell(id, content));
      caret(id, sel.start + piece.text.length);
    },
    select(id, sel) {
      const f = focusRef.current;
      if (f?.id !== id) return;
      setFocus({ ...f, start: sel.start, end: sel.end });
    },
    leave(id, related) {
      if (focusRef.current?.id !== id) return;
      // Verso un'altra cella: è la cella dopo a prendere il fuoco.
      if (related?.closest?.(`[data-table-id="${tableRef.current.id}"] [data-table-cell]`)) return;
      // Dentro la barra o il campo del link: la cella resta col fuoco.
      if (related?.closest?.("[data-editor-floating]")) return;
      setFocus(null);
      setLinkOpen(false);
      // Fuori dalla tabella (non verso il suo «⋯»): nessuna cella col fuoco.
      if (!related?.closest?.(`[data-table-id="${tableRef.current.id}"]`)) setLast(null);
      editingRef.current.leave();
    },
    history(kind) {
      setFocus(null);
      editingRef.current.leave();
      editingRef.current.history(kind);
    },
  };

  const rowCount = block.rows.length;
  const colCount = block.rows[0]?.cells.length ?? 0;
  // La cella col fuoco (o l'ultima, se il fuoco è andato su «⋯»); nessuna: la prima.
  const at = {
    row: Math.min(last?.row ?? 0, rowCount - 1),
    col: Math.min(last?.col ?? 0, colCount - 1),
  };

  // --- la barra della selezione (§3.5) ---------------------------------------
  const editingContent = focus ? (posOf(focus.id)?.cell.content ?? null) : null;
  const linkHere =
    focus && editingContent && focus.start === focus.end ? linkAt(editingContent, focus.start, focus.end) : null;
  const showBar = !!focus && !!editingContent && (focus.start !== focus.end || linkHere !== null);
  const barStart = linkHere ? linkHere.start : (focus?.start ?? 0);
  const barEnd = linkHere ? linkHere.end : (focus?.end ?? 0);
  const [barStyle, setBarStyle] = useState<CSSProperties>({});
  useLayoutEffect(() => {
    if (!showBar) return;
    const box = wrapper.current?.getBoundingClientRect();
    const sel = document.getSelection();
    const editingEl = wrapper.current?.querySelector("[data-editing]");
    if (!box || !sel || sel.rangeCount === 0 || !editingEl?.contains(sel.getRangeAt(0).startContainer)) return;
    const rect = sel.getRangeAt(0).getBoundingClientRect();
    const next: CSSProperties = {
      top: rect.top - box.top - 8,
      left: Math.max(rect.left - box.left, 0),
      transform: "translateY(-100%)",
    };
    setBarStyle((prev) => (JSON.stringify(prev) === JSON.stringify(next) ? prev : next));
  }, [focus, showBar, linkOpen]);
  const marked = (content: RichText, sel: Selection) => {
    if (!focus) return;
    editingRef.current.draft(withCell(focus.id, content));
    caret(focus.id, sel.start, sel.end);
  };
  const structure = (next: Table | null) => {
    if (!next) return;
    setFocus(null);
    setLast(null);
    editingRef.current.replace(next);
  };
  const disabled = (text: string, reason: string) => (
    <button
      type="button"
      role="menuitem"
      aria-disabled="true"
      tabIndex={-1}
      className={`${itemClass} cursor-default flex-col items-start gap-0 hover:bg-transparent`}
    >
      <span className="text-ink-muted">{text}</span>
      <span className="text-xs text-ink-muted">{reason}</span>
    </button>
  );
  const item = (text: string, run: () => void, close: () => void) => (
    <button
      type="button"
      role="menuitem"
      tabIndex={-1}
      className={itemClass}
      onClick={() => {
        close();
        run();
      }}
    >
      {text}
    </button>
  );

  return (
    <div ref={wrapper} data-table-id={block.id} className="group/table relative w-fit max-w-full">
      <div className="overflow-x-auto">
        <table className="border-collapse">
          <tbody>
            {block.rows.map((row, r) => (
              <tr key={row.id}>
                {row.cells.map((cell, c) => {
                  const label = t("productDocs.blocks.table.cell", { row: r + 1, column: c + 1 });
                  const editingCell = focus?.id === cell.id ? focus : null;
                  return (
                    <td key={cell.id} data-table-cell="" data-anchor-id={cell.id} className={cellClass}>
                      {editingCell ? (
                        <RichBlockEdit
                          id={cell.id}
                          content={cell.content}
                          label={label}
                          className={textClass}
                          selection={editingCell}
                          nonce={editingCell.nonce}
                          placeholder={null}
                          listbox={null}
                          handlers={handlers}
                        />
                      ) : (
                        <RichBlockRead
                          id={cell.id}
                          content={cell.content}
                          label={label}
                          className={textClass}
                          placeholder={null}
                          tabStop={false}
                          handlers={handlers}
                        />
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {showBar && focus && editingContent && (
        <SelectionBar
          content={editingContent}
          start={barStart}
          end={barEnd}
          linkOpen={linkOpen}
          style={barStyle}
          onBold={() => marked(toggleMark(editingContent, barStart, barEnd, "bold"), focus)}
          onItalic={() => marked(toggleMark(editingContent, barStart, barEnd, "italic"), focus)}
          onLink={() => setLinkOpen(true)}
          onApplyLink={(href) => {
            setLinkOpen(false);
            marked(setLink(editingContent, barStart, barEnd, href), { start: barStart, end: barEnd });
          }}
          onRemoveLink={() => {
            setLinkOpen(false);
            marked(setLink(editingContent, barStart, barEnd, null), { start: barStart, end: barEnd });
          }}
          onCloseLink={() => {
            setLinkOpen(false);
            caret(focus.id, focus.start, focus.end);
          }}
          onComment={
            comment
              ? () => {
                  const quote = editingContent.text.slice(barStart, barEnd);
                  editingRef.current.leave();
                  comment(focus.id, quote);
                }
              : undefined
          }
        />
      )}
      <div
        // Il menu si apre verso il margine libero a destra, non sopra la
        // tabella che modifica (Impeccable 16); verso sinistra solo se a
        // destra non c'è posto (si decide prima del clic: passaggio o fuoco).
        onPointerEnter={(e) => setMenuAlign(menuAlignFor(e.currentTarget))}
        onFocus={(e) => setMenuAlign(menuAlignFor(e.currentTarget))}
        className="absolute top-0 -right-7 opacity-0 transition-opacity duration-[var(--duration-fast)] ease-out group-focus-within/table:opacity-100 group-hover/table:opacity-100 has-[[aria-expanded=true]]:opacity-100"
      >
        <MenuButton
          menuLabel={t("productDocs.blocks.table.menu")}
          ariaLabel={t("productDocs.blocks.table.menu")}
          title={t("productDocs.blocks.table.menu")}
          align={menuAlign}
          className="grid size-5 place-items-center rounded-[4px] text-ink-faint transition-colors duration-[var(--duration-fast)] ease-out hover:bg-ink/6 hover:text-ink aria-expanded:bg-ink/10 aria-expanded:text-ink"
          wrapperClassName="inline-flex shrink-0"
          label={
            <svg viewBox="0 0 16 16" width={14} height={14} fill="currentColor" aria-hidden="true" focusable="false">
              <circle cx="3.5" cy="8" r="1.2" />
              <circle cx="8" cy="8" r="1.2" />
              <circle cx="12.5" cy="8" r="1.2" />
            </svg>
          }
        >
          {(close) => (
            <>
              {item(t("productDocs.blocks.table.addRow"), () => structure(tableAdd(tableRef.current, "row", at.row)), close)}
              {item(t("productDocs.blocks.table.addColumn"), () => structure(tableAdd(tableRef.current, "column", at.col)), close)}
              <div role="separator" className="my-1 h-px bg-rule" />
              {rowCount <= 1
                ? disabled(t("productDocs.blocks.table.removeRow"), t("productDocs.blocks.table.minRow"))
                : item(t("productDocs.blocks.table.removeRow"), () => structure(tableRemove(tableRef.current, "row", at.row)), close)}
              {colCount <= 1
                ? disabled(t("productDocs.blocks.table.removeColumn"), t("productDocs.blocks.table.minColumn"))
                : item(t("productDocs.blocks.table.removeColumn"), () => structure(tableRemove(tableRef.current, "column", at.col)), close)}
            </>
          )}
        </MenuButton>
      </div>
    </div>
  );
}
