import type { RichText } from "../../../data/model";
import { deleteRange, insertText, toggleMark } from "../../../domain/productDocs/richText";

/**
 * Un `beforeinput` sul testo coi segni (shape product-editor.md §9: ogni
 * `beforeinput` passa da qui, il DOM non è mai la fonte): il risultato e dove
 * va il cursore; `null` = non è nostro (lo prende `editorKey`, o non fa
 * niente). Per `formatBold`/`formatItalic` la selezione resta com'era: il
 * cursore detto è la sua fine.
 *
 * `formatBold`/`formatItalic` valgono solo per i `beforeinput` che non
 * nascono da un tasto (il menu Modifica): ⌘B e ⌘I li prende il `keydown`
 * (`editorKey` → `toggleMark`), che annulla l'evento, così Chromium non
 * manda anche il suo `formatBold` e i due cambi non si annullano a vicenda
 * (ruling P18).
 */
export function applyInput(
  rt: RichText,
  sel: { start: number; end: number },
  e: { inputType: string; data: string | null },
): { content: RichText; caret: number } | null {
  const start = Math.max(0, Math.min(sel.start, sel.end, rt.text.length));
  const end = Math.min(Math.max(sel.start, sel.end), rt.text.length);
  const collapsed = start === end;
  const cut = () => ({ content: deleteRange(rt, start, end), caret: start });

  switch (e.inputType) {
    case "insertText":
    case "insertReplacementText": {
      const data = e.data ?? "";
      const base = collapsed ? rt : deleteRange(rt, start, end);
      if (data === "") return collapsed ? null : { content: base, caret: start };
      return { content: insertText(base, start, data), caret: start + data.length };
    }
    case "deleteContentBackward": {
      if (!collapsed) return cut();
      if (start === 0) return null;
      const from = start - charBefore(rt.text, start);
      return { content: deleteRange(rt, from, start), caret: from };
    }
    case "deleteContentForward": {
      if (!collapsed) return cut();
      if (start >= rt.text.length) return null;
      return { content: deleteRange(rt, start, start + charAfter(rt.text, start)), caret: start };
    }
    case "deleteWordBackward": {
      if (!collapsed) return cut();
      if (start === 0) return null;
      const from = wordStartBefore(rt.text, start);
      return { content: deleteRange(rt, from, start), caret: from };
    }
    case "deleteWordForward": {
      if (!collapsed) return cut();
      if (start >= rt.text.length) return null;
      return { content: deleteRange(rt, start, wordEndAfter(rt.text, start)), caret: start };
    }
    case "deleteSoftLineBackward":
    case "deleteHardLineBackward": {
      if (!collapsed) return cut();
      if (start === 0) return null;
      // Fino all'inizio della riga; subito dopo un a capo, l'a capo stesso.
      const lineStart = rt.text.lastIndexOf("\n", start - 1) + 1;
      const from = lineStart === start ? start - 1 : lineStart;
      return { content: deleteRange(rt, from, start), caret: from };
    }
    case "deleteByCut":
    case "deleteContent":
      return collapsed ? null : cut();
    case "formatBold":
    case "formatItalic":
      if (collapsed) return null;
      return {
        content: toggleMark(rt, start, end, e.inputType === "formatBold" ? "bold" : "italic"),
        caret: end,
      };
    default:
      // insertParagraph, insertLineBreak (Invio, ⇧Invio: `editorKey`),
      // historyUndo/Redo, insertFromDrop, insertFromPaste (l'incolla passa da
      // `pasteBlocks`), e ogni altro tipo.
      return null;
  }
}

const isLow = (code: number) => code >= 0xdc00 && code <= 0xdfff;
const isHigh = (code: number) => code >= 0xd800 && code <= 0xdbff;

/** Quante unità occupa la lettera prima di `at` (2 per una coppia surrogata). */
function charBefore(text: string, at: number): number {
  return at >= 2 && isLow(text.charCodeAt(at - 1)) && isHigh(text.charCodeAt(at - 2)) ? 2 : 1;
}

function charAfter(text: string, at: number): number {
  return isHigh(text.charCodeAt(at)) && isLow(text.charCodeAt(at + 1)) ? 2 : 1;
}

/** L'inizio della parola prima di `at`: prima gli spazi, poi le lettere. */
function wordStartBefore(text: string, at: number): number {
  let i = at;
  while (i > 0 && /\s/.test(text[i - 1]!)) i--;
  while (i > 0 && !/\s/.test(text[i - 1]!)) i--;
  return i;
}

function wordEndAfter(text: string, at: number): number {
  let i = at;
  while (i < text.length && /\s/.test(text[i]!)) i++;
  while (i < text.length && !/\s/.test(text[i]!)) i++;
  return i;
}
