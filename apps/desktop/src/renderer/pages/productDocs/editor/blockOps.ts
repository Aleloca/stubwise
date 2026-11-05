import type { ProductBlock, RichText } from "../../../data/types";
import { makeBlockId } from "../../../domain/productDocs/blocks";
import { concatRich, plain, splitRich } from "../../../domain/productDocs/richText";
import type { SlashItemId } from "../../../domain/productDocs/shortcuts";

type Table = Extract<ProductBlock, { type: "table" }>;

// I blocchi che i gesti dell'editor scrivono (Task 8 e 9): funzioni pure,
// senza stato dell'editor.

/** Il blocco di testo di un tipo del menu «/» (o di «Turn into»), con la sua frase. */
export function typed(id: string, to: SlashItemId, content: RichText): ProductBlock {
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
export function cloneWithIds(block: ProductBlock): ProductBlock {
  if (block.type === "table") {
    return {
      ...block,
      id: makeBlockId(),
      rows: block.rows.map((r) => ({ id: makeBlockId(), cells: r.cells.map((c) => ({ ...c, id: makeBlockId() })) })),
    };
  }
  return { ...block, id: makeBlockId() };
}

export const emptyParagraph = (): ProductBlock => ({ id: makeBlockId(), type: "paragraph", content: plain("") });

/** Una tabella 2×2 vuota, ogni riga e cella col suo id. */
export const emptyTable = (id: string): ProductBlock => ({
  id,
  type: "table",
  rows: [0, 1].map(() => ({ id: makeBlockId(), cells: [0, 1].map(() => ({ id: makeBlockId(), content: plain("") })) })),
});

/** Inserisce una frase coi suoi segni in `at`: i segni attorno non la prendono. */
export function insertRich(rt: RichText, at: number, piece: RichText): RichText {
  const [a, b] = splitRich(rt, at);
  return concatRich(concatRich(a, piece), b);
}

/**
 * Dove cade un blocco trascinato per ⋮⋮ sopra `overId` (shape [PE 4]):
 * salendo va prima di quel blocco, scendendo dopo. `edge` dice dove sta la
 * linea d'arrivo su `overId`. `null` = il blocco resta dov'era (sopra sé
 * stesso, o un id che non c'è più): nessuna scrittura.
 */
export function dropAfter(
  ids: readonly string[],
  activeId: string,
  overId: string,
): { afterId: string | null; edge: "top" | "bottom" } | null {
  const from = ids.indexOf(activeId);
  const to = ids.indexOf(overId);
  if (from < 0 || to < 0 || from === to) return null;
  return to < from ? { afterId: ids[to - 1] ?? null, edge: "top" } : { afterId: overId, edge: "bottom" };
}

const emptyCell = () => ({ id: makeBlockId(), content: plain("") });

/**
 * Una riga (o una colonna) vuota dopo quella di indice `after`, ogni cella
 * col suo id nuovo (shape §3.10, [PE 13]).
 */
export function tableAdd(table: Table, what: "row" | "column", after: number): Table {
  if (what === "row") {
    const width = table.rows[0]?.cells.length ?? 1;
    const row = { id: makeBlockId(), cells: Array.from({ length: width }, emptyCell) };
    return { ...table, rows: [...table.rows.slice(0, after + 1), row, ...table.rows.slice(after + 1)] };
  }
  return {
    ...table,
    rows: table.rows.map((r) => ({ ...r, cells: [...r.cells.slice(0, after + 1), emptyCell(), ...r.cells.slice(after + 1)] })),
  };
}

/** Senza la riga (o la colonna) `at`; `null` se è l'ultima: una tabella tiene almeno una riga e una colonna. */
export function tableRemove(table: Table, what: "row" | "column", at: number): Table | null {
  if (what === "row") {
    if (table.rows.length <= 1) return null;
    return { ...table, rows: table.rows.filter((_, i) => i !== at) };
  }
  if ((table.rows[0]?.cells.length ?? 0) <= 1) return null;
  return { ...table, rows: table.rows.map((r) => ({ ...r, cells: r.cells.filter((_, i) => i !== at) })) };
}

const wordChar = /[\p{L}\p{N}]/u;

/**
 * Un codice scelto in «Link to…» ([PE 12]), al cursore: come parola a sé
 * (uno spazio prima e dopo se tocca lettere o cifre), così il testo lo
 * riconosce come codice. Il cursore va dopo il codice.
 */
export function insertCode(rt: RichText, at: number, code: string): { content: RichText; caret: number } {
  const before = at > 0 && wordChar.test(rt.text[at - 1]!) ? " " : "";
  const after = at < rt.text.length && wordChar.test(rt.text[at]!) ? " " : "";
  const piece = `${before}${code}${after}`;
  return { content: insertRich(rt, at, plain(piece)), caret: at + before.length + code.length };
}

/** L'altezza massima dei selettori, e lo spazio che tengono dai bordi visibili. */
export const FLOATING_MAX = 320;
/**
 * Il menu «/»: le sue 14 voci in due gruppi stanno intere a 900 di altezza
 * (Impeccable 5: con 320 il gruppo INSERT restava nascosto senza un segno).
 */
export const SLASH_MAX = 560;
const FLOATING_MARGIN = 16;

/**
 * Dove sta un menu del blocco (fix round 1, punto 11): sotto il blocco, alto
 * al più `max` (320; il menu «/» 560) e a 16 px dal fondo visibile (la
 * colonna o la finestra, quello più in alto); sopra se sotto non ci sta
 * tutto e sopra c'è più posto.
 */
export function floatingPlacement(
  box: {
    blockTop: number;
    blockBottom: number;
    viewTop: number;
    viewBottom: number;
    windowHeight: number;
  },
  max = FLOATING_MAX,
): { placement: "below" | "above"; maxHeight: number } {
  const bottom = Math.min(box.viewBottom, box.windowHeight);
  const below = bottom - box.blockBottom - FLOATING_MARGIN;
  const above = box.blockTop - box.viewTop - FLOATING_MARGIN;
  if (below < max && above > below) return { placement: "above", maxHeight: Math.min(max, above) };
  return { placement: "below", maxHeight: Math.max(0, Math.min(max, below)) };
}
