/**
 * Palette CANONICA del tema Stubwise — v1 è SOLO dark, un solo accento ambra
 * (`signal`), IBM Plex per i font. Le chiavi sono il suffisso della variabile
 * CSS (`--color-<chiave>`) del sito di prima.
 *
 * **È la fonte** (D9 del ritiro del web vecchio, R1): fino a R1 la fonte vera
 * era il blocco `@theme` di Tailwind di `apps/web`, e questo modulo ne era la
 * copia tenuta allineata da un test di parità. Col web vecchio sono andati
 * via il blocco e il test: chi cambia un colore lo cambia QUI. L'unico
 * lettore è `apps/mobile` (`theme/tokens.ts`), che lo importa invece di
 * ricopiarlo: la copia a mano ne aveva persi cinque per strada (`ink-850`,
 * `ink-700`, `line-strong`, `signal-bright`, `signal-dim`, App M1, 11 set
 * 2026). La nuova app ha i suoi token, nel renderer di `apps/desktop`.
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

/**
 * Raggi degli angoli: 8 per i controlli, 10 per le card. Fix di review (App
 * M1+M2, Task 4, 11 set 2026): il docblock precedente diceva «stessi valori
 * sul sito e sull'app», ma non è vero — `apps/web/src/styles.css` non
 * definisce nessuna custom property di raggio (usa le utility Tailwind
 * `rounded-sm` inline, verificato con un grep), quindi non c'è niente con cui
 * questi due numeri siano allineati né un test che lo verifichi. Sono i
 * valori del canvas di design dell'app, usati SOLO da `apps/mobile`.
 */
export const designRadii = {
  control: 8,
  card: 10,
} as const;
