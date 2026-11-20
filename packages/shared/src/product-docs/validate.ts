import type { InlineMark, ProductBlock, RichText } from "../schemas/product-docs.js";
import { safeLinkHref } from "./rich-text.js";

// Area 11, F1: la validazione dei segni di un blocco scritto, portata dal
// prototipo (`data/productDocs/writes.ts`, `validMark`/`validRich`). La usa
// il server prima di salvare, qualunque strada abbia preso la scrittura
// (l'editor, e dal 11b Claude).

/** Un segno è dentro il testo, non vuoto, e un link ha un indirizzo http(s) (`safeLinkHref`). */
const validMark = (m: InlineMark, length: number): boolean =>
  Number.isInteger(m.start) &&
  Number.isInteger(m.end) &&
  m.start >= 0 &&
  m.start < m.end &&
  m.end <= length &&
  (m.type === "bold" || m.type === "italic" || (m.type === "link" && safeLinkHref(m.href) === m.href));

export const validRichText = (rt: RichText): boolean => rt.marks.every((m) => validMark(m, rt.text.length));

/** Le frasi di un blocco: la sua, o quelle delle celle. */
export const richTextsOf = (block: ProductBlock): RichText[] =>
  block.type === "table" ? block.rows.flatMap((r) => r.cells.map((c) => c.content)) : "content" in block ? [block.content] : [];

/** Ogni id di un blocco: il blocco, e per una tabella le righe e le celle (un id non si riusa mai). */
export const blockIdsOf = (block: ProductBlock): string[] =>
  block.type === "table" ? [block.id, ...block.rows.flatMap((r) => [r.id, ...r.cells.map((c) => c.id)])] : [block.id];

/** Il blocco ha segni validi in ogni sua frase. */
export const validProductBlock = (block: ProductBlock): boolean => richTextsOf(block).every(validRichText);
