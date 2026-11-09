import { FIXED_BLOCKS as SHARED_FIXED_BLOCKS } from "@stubwise/shared";
import type { HomeBlockKind } from "../data/types";

// Le regole della Home a blocchi (fissi, stesso blocco, unione dei reparti
// nell'ordine del primo, «è cambiata») stanno in `@stubwise/shared`
// (integrazione area 2, fetta 3): una regola, un posto, la usa anche il
// server. Le funzioni sono generiche sul blocco: qui ci passa il
// `HomeBlockRef` del prototipo.
export { resolveHome, sameBlock } from "@stubwise/shared";

/** I blocchi che aprono ogni Home e non si nascondono. */
export const FIXED_BLOCKS: HomeBlockKind[] = [...SHARED_FIXED_BLOCKS];
