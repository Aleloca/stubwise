import type { ProductBlock, RichText } from "../../../data/types";
import { makeBlockId } from "../../../domain/productDocs/blocks";
import { concatRich, plain, splitRich } from "../../../domain/productDocs/richText";
import type { SlashItemId } from "../../../domain/productDocs/shortcuts";

// I blocchi che i gesti dell'editor scrivono (Task 8): funzioni pure, senza
// stato dell'editor. Il Task 9 aggiunge qui i suoi tipi di blocco.

/** Le voci del menu «/» che l'editor sa già mettere; il Task 9 aggiunge immagine, Drive, collegamento e decisione. */
export const READY: ReadonlySet<SlashItemId> = new Set<SlashItemId>([
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
