import type { ProductBlock } from "../../data/model";
import { anchorIdsOf } from "./blocks";

/**
 * Le sezioni di una pagina di prodotto: un titolo e ciò che gli sta sotto.
 * Servono al segnale «qualcuno scrive qui» (Task 5) e alle righe della
 * presenza («scrive in Rules»). Una cella di tabella sta nella sezione della
 * sua tabella.
 */

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

/**
 * Le ancore della sezione, nell'ordine della pagina: dal titolo fino al
 * prossimo titolo di livello uguale o più alto (un H3 dentro un H2 sta nella
 * sezione dell'H2). `null` = le ancore prima del primo titolo; un titolo che
 * non c'è dà un elenco vuoto.
 */
export function sectionRange(blocks: readonly ProductBlock[], headingId: string | null): string[] {
  let start = 0;
  // Prima del primo titolo la sezione la chiude qualunque titolo (livello 0).
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
