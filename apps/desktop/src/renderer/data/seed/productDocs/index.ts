import type { ProductBlock } from "../../types";
import {
  PRODUCT_COMMENTS,
  PRODUCT_FOLLOWS,
  PRODUCT_NOTIFICATIONS,
  PRODUCT_PAGES,
  PRODUCT_REMOVED_BLOCK_IDS,
  PRODUCT_REVISIONS,
} from "./acq";

export {
  PRODUCT_COMMENTS,
  PRODUCT_FOLLOWS,
  PRODUCT_NOTIFICATIONS,
  PRODUCT_PAGES,
  PRODUCT_REVISIONS,
};
export { PRODUCT_SCRIPTS } from "./presence";

const idsOf = (b: ProductBlock): string[] =>
  b.type === "table"
    ? [b.id, ...b.rows.flatMap((r) => [r.id, ...r.cells.map((c) => c.id)])]
    : [b.id];

/**
 * Gli id di blocco, di riga e di cella del seme: un id dato non si riusa mai,
 * neanche quello di un blocco che una modifica del seme ha tolto. Il blocco
 * che un copione inserisce NON è qui (ruling P11).
 */
export const productSeedBlockIds = (): Set<string> =>
  new Set([...PRODUCT_PAGES.flatMap((p) => p.blocks.flatMap(idsOf)), ...PRODUCT_REMOVED_BLOCK_IDS]);
