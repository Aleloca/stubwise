/**
 * Palette CANONICA del tema Stubwise — v1 è SOLO dark, un solo accento ambra
 * (`signal`), IBM Plex per i font. Le chiavi sono il suffisso esatto della
 * variabile CSS del sito (`--color-<chiave>`, blocco `@theme` in
 * `apps/web/src/styles.css`), non un nome a piacere: così un test di parità
 * (`apps/web/src/theme-parity.test.ts`) può confrontare le due liste 1:1
 * senza una tabella di corrispondenza a parte che potrebbe divergere lei
 * stessa.
 *
 * App M1 (11 set 2026): prima di questo modulo, `apps/mobile/src/theme/
 * tokens.ts` RICOPIAVA questi valori a mano — e ne aveva persi cinque per
 * strada (`ink-850`, `ink-700`, `line-strong`, `signal-bright`,
 * `signal-dim`), proprio quelli che sul sito creano la profondità: superfici
 * rialzate, bordi degli elementi interattivi, l'ambra viva contro quella
 * spenta. Ora l'app li legge da qui, e il test di parità impedisce che si
 * riapra lo stesso scarto.
 *
 * **Non generare il CSS del sito da qui**: il sito resta sul blocco `@theme`
 * di Tailwind v4, che DEVE restare la fonte diretta per lui — questo modulo
 * è la rete di sicurezza che tiene l'app allineata, non l'inverso.
 */
export const designColors = {
  /** Sfondo primario (schermo). */
  "ink-950": "#0a0d10",
  /** Sfondo delle card e delle superfici rialzate. */
  "ink-900": "#0f1318",
  /** Sfondo rialzato di un livello ulteriore (es. riga selezionata, header di sezione). */
  "ink-850": "#131920",
  /** Sfondo rialzato di un livello ulteriore ancora. */
  "ink-800": "#181f28",
  /** Bordo di un elemento interattivo in evidenza (hover/focus). */
  "ink-700": "#242d38",
  /** Bordi e separatori, hairline di default. */
  line: "#1d242d",
  /** Bordo "forte", per gli elementi interattivi. */
  "line-strong": "#2c3641",
  /** Testo primario. */
  fg: "#e9e6df",
  /** Testo secondario. */
  "fg-muted": "#98a1ac",
  /** Testo terziario / annotazioni mono. */
  "fg-faint": "#5c6671",
  /** L'unico accento: ambra segnale. */
  signal: "#f5a623",
  /** Ambra viva — hover/attivo di un elemento di segnale. */
  "signal-bright": "#ffc14d",
  /** Ambra spenta — bordo/sfondo tenue di un elemento di segnale. */
  "signal-dim": "#b97d1a",
  /** Errori, card "lavoro fallito". */
  danger: "#ff6b6e",
  /** Successo, PR pronta, rilasciato. */
  ok: "#4ad295",
} as const;

export type DesignColorKey = keyof typeof designColors;

/** Raggi degli angoli: 8 per i controlli, 10 per le card — stessi valori sul sito e sull'app. */
export const designRadii = {
  control: 8,
  card: 10,
} as const;
