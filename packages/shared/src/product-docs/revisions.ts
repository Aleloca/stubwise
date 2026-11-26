// Area 11, F1: l'unione delle revisioni del prototipo
// (`data/productDocs/revisions.ts`): una scrittura di blocchi si aggiunge
// all'ultima revisione della pagina se quella ha la stessa sessione, la stessa
// persona, `kind: "edit"` e nessun `via`. Per blocco resta il primo `before`
// e l'ultimo `after`; un blocco tornato com'era esce dai cambi.
import type { ProductBlock, ProductBlockChange } from "../schemas/product-docs.js";
import { blockChanges } from "./blocks.js";

/** Il cambio di un blocco fra due estremi (`null` = non c'era / non c'è più); `null` se è com'era. */
function between(before: ProductBlock | null, after: ProductBlock | null, blockId: string) {
  const change = blockChanges(before ? [before] : [], after ? [after] : []).find(
    (c) => c.blockId === blockId,
  );
  return change ?? null;
}

/** Unisce i cambi nuovi a quelli di una revisione: primo `before`, ultimo `after`. */
export function mergeChanges(
  old: readonly ProductBlockChange[],
  next: readonly ProductBlockChange[],
): ProductBlockChange[] {
  const out = old.map((c) => ({ ...c }));
  for (const change of next) {
    const i = out.findIndex((c) => c.blockId === change.blockId);
    if (i < 0) {
      out.push(change);
      continue;
    }
    const prev = out[i]!;
    const merged = between(prev.before, change.after, change.blockId);
    if (merged === null) {
      out.splice(i, 1);
      continue;
    }
    // Un'unione (`mergedFrom`) resta detta: la prima, se ce n'è più d'una.
    const mergedFrom = prev.mergedFrom ?? change.mergedFrom;
    out[i] = mergedFrom && merged.after !== null ? { ...merged, mergedFrom } : merged;
  }
  return out;
}

