import type { ProductBlock, ProductBlockType } from "../../../data/model";
import { blocksFromHtml } from "../../../domain/productDocs/pasteHtml";
import { plain } from "../../../domain/productDocs/richText";

/**
 * La tastiera dentro un blocco di testo (shape product-editor.md §3.11). Pura:
 * dice cosa fare, il blocco lo fa. Chi riceve un risultato diverso da `none`
 * annulla il `keydown` (`preventDefault`): così ⌘B non arriva anche come
 * `beforeinput formatBold` (ruling P18), e Invio non arriva come
 * `insertParagraph`.
 */
export type EditorKeyResult =
  | { kind: "split"; offset: number }
  | { kind: "mergeWithPrevious" }
  | { kind: "focusPrevious" | "focusNext" }
  | { kind: "indent" | "outdent" }
  | { kind: "moveBlock"; dir: "up" | "down" }
  | { kind: "toggleMark"; mark: "bold" | "italic" }
  | { kind: "openSlash" }
  | { kind: "undo" | "redo" } // ⌘Z / ⇧⌘Z (shape [PE 21])
  /** Invio su un elemento d'elenco (o to-do) vuoto: torna paragrafo (ruling P41). */
  | { kind: "toParagraph" }
  /** ⇧Invio: a capo nello stesso blocco. Nel codice anche Invio. */
  | { kind: "lineBreak" }
  /** Invio in fondo al codice dopo una riga vuota: la riga vuota se ne va e si continua in un paragrafo. */
  | { kind: "exitCode" }
  | { kind: "none" };

const LISTS = new Set<ProductBlockType>(["bullet", "numbered", "todo"]);
const NONE: EditorKeyResult = { kind: "none" };

/**
 * Il tasto nel suo contesto: il testo del blocco, il cursore (l'inizio della
 * selezione; `collapsed: false` se c'è una selezione), il tipo, il menu «/».
 * ↑/↓ cambiano blocco solo col cursore a 0 / alla fine del testo: il
 * prototipo non misura le righe visive (ruling P41). ⌘K resta la palette.
 */
export function editorKey(
  e: { key: string; shiftKey: boolean; altKey: boolean; metaKey: boolean; ctrlKey: boolean },
  ctx: { text: string; caret: number; type: ProductBlockType; slashOpen: boolean; collapsed?: boolean },
): EditorKeyResult {
  const mod = e.metaKey !== e.ctrlKey; // ⌘ su mac, Ctrl altrove; non entrambi
  const collapsed = ctx.collapsed ?? true;
  const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;

  if (mod && !e.altKey) {
    if (key === "z") return { kind: e.shiftKey ? "redo" : "undo" };
    if (e.shiftKey) return NONE;
    if (key === "b") return { kind: "toggleMark", mark: "bold" };
    if (key === "i") return { kind: "toggleMark", mark: "italic" };
    return NONE;
  }
  if (mod || e.metaKey || e.ctrlKey) return NONE;

  if (e.altKey && e.shiftKey && (key === "ArrowUp" || key === "ArrowDown")) {
    return { kind: "moveBlock", dir: key === "ArrowUp" ? "up" : "down" };
  }
  if (e.altKey) return NONE;

  // Col menu «/» aperto Invio, frecce ed Esc sono del menu.
  if (ctx.slashOpen && (key === "Enter" || key === "ArrowUp" || key === "ArrowDown")) return NONE;

  switch (key) {
    case "Enter":
      if (e.shiftKey) return { kind: "lineBreak" };
      // Nel codice Invio va a capo; in fondo, dopo una riga vuota, si esce.
      if (ctx.type === "code") {
        return collapsed && ctx.caret >= ctx.text.length && ctx.text.endsWith("\n")
          ? { kind: "exitCode" }
          : { kind: "lineBreak" };
      }
      if (ctx.text === "" && LISTS.has(ctx.type)) return { kind: "toParagraph" };
      return { kind: "split", offset: ctx.caret };
    case "Backspace":
      return !e.shiftKey && collapsed && ctx.caret === 0 ? { kind: "mergeWithPrevious" } : NONE;
    case "ArrowUp":
      return !e.shiftKey && collapsed && ctx.caret === 0 ? { kind: "focusPrevious" } : NONE;
    case "ArrowDown":
      return !e.shiftKey && collapsed && ctx.caret >= ctx.text.length ? { kind: "focusNext" } : NONE;
    case "Tab":
      if (ctx.type !== "bullet" && ctx.type !== "numbered") return NONE;
      return { kind: e.shiftKey ? "outdent" : "indent" };
    case "/":
      return ctx.text === "" ? { kind: "openSlash" } : NONE;
    default:
      return NONE;
  }
}

/**
 * Gli appunti in blocchi: con `text/html` i blocchi di `blocksFromHtml`
 * (titoli, elenchi, caselle, citazioni, tabelle, riga orizzontale, codice;
 * grassetto, corsivo e link http(s) — Google Docs compreso), altrimenti una
 * riga di `text/plain` per paragrafo (righe vuote saltate). Prima (shape
 * [PE 14]) erano sempre paragrafi: lo ha cambiato il maintainer dopo le prove
 * a mano del 7 nov 2026. Un HTML senza testo cade sul testo semplice.
 */
export function pasteBlocks(clip: { html: string | null; text: string }, makeId: () => string): ProductBlock[] {
  const fromHtml = clip.html ? blocksFromHtml(clip.html, makeId) : [];
  if (fromHtml.length > 0) return fromHtml;
  return clip.text
    .split(/\r\n|\r|\n/)
    .filter((line) => line.trim() !== "")
    .map((line) => ({ id: makeId(), type: "paragraph", content: plain(line) }));
}
