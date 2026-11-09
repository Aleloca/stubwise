import { FIXED_BLOCKS as SHARED_FIXED_BLOCKS, sameBlock } from "@stubwise/shared";
import type { HomeBlockKind } from "../data/types";

// Le regole della Home a blocchi (fissi, stesso blocco, unione dei reparti
// nell'ordine del primo, «è cambiata») stanno in `@stubwise/shared`
// (integrazione area 2, fetta 3): una regola, un posto, la usa anche il
// server. Le funzioni sono generiche sul blocco: qui ci passa il
// `HomeBlockRef` del prototipo.
export { resolveHome, sameBlock } from "@stubwise/shared";

/** I blocchi che aprono ogni Home e non si nascondono. */
export const FIXED_BLOCKS: HomeBlockKind[] = [...SHARED_FIXED_BLOCKS];

type AnyBlock = { kind: string; filterId?: string };

/**
 * La Home `edited` (ciò che l'editor mostrava) con dentro di nuovo i blocchi
 * di `original` che l'app non mostra (`hidden`: un tipo che non conosce, un
 * blocco di un'area non integrata). Personalizzare non deve cancellarli: ognuno
 * torna dopo l'ultimo blocco visibile che lo precedeva ed è ancora nella Home;
 * se lo precedevano solo blocchi tolti va in coda, se non lo precedeva nessuno
 * resta in testa. Si tolgono solo con «Ripristina».
 */
export function withHiddenBlocks<T extends AnyBlock>(
  edited: readonly T[],
  original: readonly T[],
  hidden: (block: T) => boolean,
): T[] {
  const has = (list: readonly T[], b: T) => list.some((x) => sameBlock(x, b));
  const head: T[] = [];
  const tail: T[] = [];
  const after = new Map<T, T[]>();
  let anchor: T | null = null;
  let seenVisible = false;
  for (const block of original) {
    if (!hidden(block)) {
      seenVisible = true;
      const kept = edited.find((x) => sameBlock(x, block));
      if (kept) anchor = kept;
      continue;
    }
    if (has(edited, block)) continue;
    if (anchor) after.set(anchor, [...(after.get(anchor) ?? []), block]);
    else (seenVisible ? tail : head).push(block);
  }
  return [...head, ...edited.flatMap((b) => [b, ...(after.get(b) ?? [])]), ...tail];
}
