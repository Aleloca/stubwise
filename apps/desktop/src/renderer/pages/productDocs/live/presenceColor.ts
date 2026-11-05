import type { ProductPresenceView } from "../../../data/types";

// I colori della presenza ([PE 17], «The Presence Exception» di DESIGN.md):
// `--presence-1…6`, SOLO nei pezzi della scrittura dal vivo (questa
// cartella) e sempre accanto al nome della persona. Un test sul sorgente
// (`Live.test.tsx`) tiene `var(--presence-…)` fuori da ogni altro file.

export const presenceColor = (color: ProductPresenceView["color"]): string =>
  `var(--presence-${color})`;
