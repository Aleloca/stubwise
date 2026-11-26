// Area 11, F4: le sezioni di una pagina di prodotto, una regola per il server
// (le prese), il worker (F5: Claude aspetta chi scrive nella stessa sezione) e
// il client (la presenza). Dal prototipo (`domain/productDocs/sections.ts`).
import type { ProductBlock } from "../schemas/product-docs.js";
import { anchorIdsOf } from "./blocks.js";

/**
 * La chiave della sezione «in cima» (i blocchi prima del primo titolo) dove ne
 * serve una che non sia null: la presa (`product_section_holds`), il 409
 * `section_busy`, gli eventi dello stream. Un id di blocco è `blk-…`, quindi
 * non si confonde.
 */
export const PRODUCT_TOP_SECTION = "top";

/** L'indice del blocco che contiene l'ancora (il blocco stesso o una sua cella); -1 se non c'è. */
function blockIndexOf(blocks: readonly ProductBlock[], anchorId: string): number {
  return blocks.findIndex((b) => anchorIdsOf(b).includes(anchorId));
}

/**
 * Il titolo sopra l'ancora (qualunque livello); un titolo è la sua stessa
 * sezione. `null` = prima del primo titolo, o un'ancora che non c'è.
 */
export function sectionOf(blocks: readonly ProductBlock[], anchorId: string): string | null {
  for (let i = blockIndexOf(blocks, anchorId); i >= 0; i--) {
    const b = blocks[i]!;
    if (b.type === "heading") return b.id;
  }
  return null;
}

/** Come {@link sectionOf}, con la chiave della sezione in cima al posto di null (per le prese). */
export const sectionKeyOf = (blocks: readonly ProductBlock[], anchorId: string): string => sectionOf(blocks, anchorId) ?? PRODUCT_TOP_SECTION;

/**
 * Le ancore della sezione, nell'ordine della pagina: dal titolo fino al
 * prossimo titolo di livello uguale o più alto (un H3 dentro un H2 sta nella
 * sezione dell'H2). `null` = le ancore prima del primo titolo; un titolo che
 * non c'è dà un elenco vuoto.
 */
export function sectionRange(blocks: readonly ProductBlock[], headingId: string | null): string[] {
  let start = 0;
  let level = 0;
  if (headingId !== null) {
    start = blocks.findIndex((b) => b.id === headingId);
    const heading = blocks[start];
    if (heading?.type !== "heading") return [];
    level = heading.level;
  }
  const out: string[] = [];
  for (let i = start; i < blocks.length; i++) {
    const b = blocks[i]!;
    if (b.type === "heading" && b.id !== headingId && (level === 0 || b.level <= level)) break;
    out.push(...anchorIdsOf(b));
  }
  return out;
}

/** `b` sta nella sezione di `a` (il segnale «qualcuno scrive qui»); falso se `a` non c'è. */
export function inSectionOf(blocks: readonly ProductBlock[], a: string, b: string): boolean {
  if (blockIndexOf(blocks, a) < 0) return false;
  return sectionRange(blocks, sectionOf(blocks, a)).includes(b);
}
