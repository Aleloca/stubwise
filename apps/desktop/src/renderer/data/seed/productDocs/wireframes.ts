import type { ProductBlock } from "../../types";

// I disegni delle bozze di schermata di Claude (11b, Task 7; shape
// product-claude-backlog.md §3.5): il prototipo non disegna, sceglie fra
// questi schizzi dalle parole della pagina (`pickWireframe`). Ogni disegno ha
// le sue parole chiave (in minuscolo, en e it) e da due a tre varianti
// («Rifai» passa alla seguente).
//
// Uno schizzo, non un design: fil di ferro in bianco e nero, linee 1.5 in
// `currentColor` (nel tema scuro le stesse linee chiare; esportato, nero su
// bianco), nessun riempimento colorato, nessuna fotografia e nessun testo
// vero — i testi sono barre segnaposto più tenui (`opacity`). Nessun colore
// letterale: lo verifica il test del seme.

const OPEN =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 360 240" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">';
const CLOSE = "</svg>";

/** Il telefono in mezzo al riquadro: il contorno e la barra in alto. */
const PHONE = '<rect x="110" y="8" width="140" height="224" rx="14"/><path d="M110 34h140"/>';

/** Una barra di testo segnaposto, più tenue delle linee. */
const bar = (x: number, y: number, w: number) => `<path opacity=".45" d="M${x} ${y}h${w}"/>`;
const box = (x: number, y: number, w: number, h: number, r = 4) =>
  `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}"/>`;
/** Un bottone: il contorno e la sua barra. */
const button = (x: number, y: number, w: number) => `${box(x, y, w, 18, 9)}${bar(x + 12, y + 9, w - 24)}`;

const sketch = (...parts: string[]) => `${OPEN}${PHONE}${parts.join("")}${CLOSE}`;

/** La settimana: sette caselle dei giorni in fila. */
const week = (y: number) => Array.from({ length: 7 }, (_, i) => box(120 + i * 17.5, y, 14, 16, 3)).join("");
/** Una card di un corso: il contorno, il nome e l'orario. */
const classCard = (y: number) => `${box(120, y, 120, 34)}${bar(128, y + 12, 60)}${bar(128, y + 23, 34)}`;

export const PRODUCT_WIREFRAMES: Record<string, { keywords: string[]; variants: string[] }> = {
  booking: {
    keywords: ["booking", "book", "class", "timetable", "prenotazion", "prenota", "corso", "lezion"],
    variants: [
      sketch(bar(122, 22, 50), week(42), classCard(68), classCard(108), classCard(148), button(150, 200, 60)),
      sketch(bar(122, 22, 50), box(120, 42, 120, 22, 11), bar(132, 53, 50), week(74), classCard(100), classCard(140), button(150, 196, 60)),
      sketch(
        bar(122, 22, 50),
        week(42),
        `${box(120, 68, 120, 70)}${bar(128, 82, 70)}${bar(128, 96, 50)}${bar(128, 110, 60)}`,
        `${box(120, 146, 56, 22, 6)}${box(184, 146, 56, 22, 6)}`,
        button(150, 196, 60),
      ),
    ],
  },
  membership: {
    keywords: ["membership", "desk", "check-in", "check in", "abbonament", "tessera", "reception"],
    variants: [
      sketch(bar(122, 22, 50), box(140, 56, 80, 80, 6), `<path d="M156 72h16v16h-16zM188 104h16v16h-16zM156 104h16M188 72h16"/>`, bar(140, 156, 80), bar(150, 170, 60), button(150, 196, 60)),
      sketch(bar(122, 22, 50), box(120, 48, 120, 70, 8), bar(130, 64, 70), bar(130, 78, 50), box(150, 128, 60, 60, 4), button(150, 200, 60)),
    ],
  },
  bills: {
    keywords: ["bill", "invoice", "pdf", "due date", "bollett", "fattur", "scadenz"],
    variants: [
      sketch(
        bar(122, 22, 40),
        ...[46, 84, 122, 160].map((y) => `${box(120, y, 120, 30)}${bar(128, y + 11, 54)}${bar(128, y + 21, 30)}${box(210, y + 8, 22, 14, 3)}`),
        button(150, 202, 60),
      ),
      sketch(bar(122, 22, 40), box(120, 44, 120, 64, 6), bar(130, 60, 60), bar(130, 76, 80), bar(130, 92, 40), ...[118, 146, 174].map((y) => `${bar(122, y, 70)}${bar(214, y, 24)}`), button(150, 202, 60)),
    ],
  },
  "sign-in": {
    keywords: ["sign-in", "sign in", "login", "log in", "google", "password", "accesso", "accedi"],
    variants: [
      sketch(box(160, 52, 40, 40, 20), bar(140, 112, 80), button(126, 140, 108), bar(150, 182, 60)),
      sketch(bar(140, 60, 80), box(126, 84, 108, 22, 6), box(126, 114, 108, 22, 6), button(126, 150, 108), bar(150, 190, 60)),
    ],
  },
  /** Lo schizzo generico: quando nessun altro disegno ha parole nella pagina. */
  screen: {
    keywords: ["screen", "schermata"],
    variants: [
      sketch(bar(122, 22, 50), box(120, 44, 120, 80, 6), bar(122, 140, 100), bar(122, 154, 80), bar(122, 168, 90), button(150, 200, 60)),
      sketch(bar(122, 22, 50), ...[44, 80, 116, 152].map((y) => `${box(120, y, 120, 28)}${bar(128, y + 14, 70)}`), button(150, 200, 60)),
    ],
  },
};

/** Il disegno di riserva, quando nessun altro ha parole nella pagina. */
export const FALLBACK_WIREFRAME = "screen";

// --- le letture del seme (le usano le letture della pagina e l'esportazione) ---

/** La chiave di un disegno nelle letture (`ProductPageView.wireframes`, l'esportazione). */
export const wireframeKey = (wireframeId: string, variant: number): string => `${wireframeId}:${variant}`;

/** L'SVG di una variante; `null` = un disegno (o una variante) che il seme non ha. */
export function wireframeSvg(wireframeId: string, variant: number): string | null {
  return Object.hasOwn(PRODUCT_WIREFRAMES, wireframeId)
    ? (PRODUCT_WIREFRAMES[wireframeId]!.variants[variant] ?? null)
    : null;
}

/** Le bozze dei blocchi, per chiave: ciò che una lettura passa alla pagina. */
export function wireframesOf(blocks: readonly ProductBlock[]): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const b of blocks)
    if (b.type === "wireframe") out[wireframeKey(b.wireframeId, b.variant)] = wireframeSvg(b.wireframeId, b.variant);
  return out;
}

