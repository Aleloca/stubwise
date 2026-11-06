import type { ProductBlock } from "../../types";
import {
  PRODUCT_COMMENTS,
  PRODUCT_FOLLOWS,
  PRODUCT_NOTIFICATIONS as NOTIFICATIONS_11A,
  PRODUCT_REMOVED_BLOCK_IDS,
  PRODUCT_REVISIONS,
} from "./acq";
import {
  PRODUCT_COMMENTS_11B,
  PRODUCT_MARKS_11B,
  PRODUCT_NOTIFICATIONS_11B,
  PRODUCT_PAGES_11B,
  PRODUCT_REVISIONS_11B,
  PRODUCT_SOURCES_SEEN_11B,
} from "./acq11b";

export { PRODUCT_COMMENTS, PRODUCT_FOLLOWS, PRODUCT_REVISIONS };
export { PRODUCT_COMMENTS_11B, PRODUCT_MARKS_11B, PRODUCT_REVISIONS_11B, PRODUCT_SOURCES_SEEN_11B };
export { PRODUCT_SCRIPTS } from "./presence";

/** Le pagine di adesso: quelle del 11a con le scritture di Claude del 11b. */
export const PRODUCT_PAGES = PRODUCT_PAGES_11B;

/** Le card del seme: la menzione del 11a e quelle di Claude del 11b. */
export const PRODUCT_NOTIFICATIONS = [...NOTIFICATIONS_11A, ...PRODUCT_NOTIFICATIONS_11B];

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
