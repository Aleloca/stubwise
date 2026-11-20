import type { ProductPresenceView } from "../../data/types";

// La presenza nella doc di prodotto, le regole che non dipendono da chi
// tiene i dati: il colore stabile di una persona e le iniziali dal nome.
// Le usano il prototipo (`data/productDocs/presence.ts`) e la build app
// (`backend/real/productLive.ts`, area 11 F4).

/** Il colore della presenza di una persona: lo stesso ovunque e a ogni ripristino. */
export function presenceColor(personId: string): ProductPresenceView["color"] {
  let h = 0;
  for (const ch of personId) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return ((h % 6) + 1) as ProductPresenceView["color"];
}

/** Le iniziali di un nome: le prime lettere delle prime due parole («Marco Bellini» → «MB»). */
export function initialsOf(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  return words
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join("");
}
