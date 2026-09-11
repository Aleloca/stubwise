import { designColors, designRadii } from "@stubwise/shared";

/**
 * Token di colore e raggio del design (canvas Claude Design "Stubwise
 * Mobile", `designs/app-design.zip`): gli stessi valori della web app — v1 è
 * SOLO dark, non c'è un tema chiaro da switchare (vedi §2 del design doc di
 * fase 4).
 *
 * App M1 (11 set 2026): i valori vengono ora da `@stubwise/shared`
 * (`designColors`), che li tiene allineati a `apps/web/src/styles.css` con
 * un test di parità (`apps/web/src/theme-parity.test.ts`) — prima venivano
 * ricopiati qui a mano, e ne mancavano cinque: `ink850`, `ink700`,
 * `lineStrong`, `signalBright`, `signalDim`. Sono quelli che sul sito creano
 * la profondità (superfici rialzate, bordi degli elementi interattivi,
 * l'ambra viva contro quella spenta) e ora l'app li ha, usati in
 * `GhostButton`, `CardShell`/`CardFooter`, `PrimaryButton` e altrove — vedi
 * i commenti su ciascun uso.
 */
export const colors = {
  /** Sfondo primario (schermo). */
  ink950: designColors["ink-950"],
  /** Sfondo delle card e delle superfici rialzate. */
  ink900: designColors["ink-900"],
  /** Sfondo rialzato di un livello ulteriore (riga premuta/selezionata). */
  ink850: designColors["ink-850"],
  /** Sfondo rialzato di un livello ulteriore ancora. */
  ink800: designColors["ink-800"],
  /** Bordo di un elemento interattivo in evidenza. */
  ink700: designColors["ink-700"],
  /** Bordi e separatori. */
  line: designColors.line,
  /** Bordo "forte", per gli elementi interattivi (bottoni, campi). */
  lineStrong: designColors["line-strong"],
  /** Testo primario. */
  fg: designColors.fg,
  /** Testo secondario. */
  muted: designColors["fg-muted"],
  /** Testo terziario / annotazioni mono (`// commenti`). */
  faint: designColors["fg-faint"],
  /** Colore di richiamo: cursore del wordmark, bottoni primari, badge. */
  signal: designColors.signal,
  /**
   * Ambra viva. Verificato sul sito (fix di review, Task 4, 11 set 2026 —
   * la motivazione precedente reggeva solo a metà): OGNI bottone primario di
   * `apps/web` usa la coppia `hover:bg-signal-bright active:bg-signal-dim`
   * (grep su ~15 componenti, mai un'eccezione). `signal-bright` è quindi
   * SEMPRE l'hover, MAI il tap/click attivo — che è `signal-dim`, la stessa
   * ambra spenta già usata qui per lo stato premuto (`PrimaryButton.tsx`,
   * `CardShell.tsx`). Il touch non ha hover: non è che l'equivalente
   * touch-di-hover abbia preso il colore sbagliato — è che `signal-bright`
   * non ha proprio un equivalente touch, e resta apposta senza uso qui.
   */
  signalBright: designColors["signal-bright"],
  /** Ambra spenta — bordo/sfondo tenue di un elemento di segnale, e stato "premuto" di un bottone pieno. */
  signalDim: designColors["signal-dim"],
  /** Errori, card "lavoro fallito". */
  danger: designColors.danger,
  /** Successo, PR pronta, rilasciato. */
  ok: designColors.ok,
  // I due seguenti NON sono sul tema del sito (nessun --color-sky/--color-
  // violet in styles.css, quindi fuori da `designColors` e dal test di
  // parità): riprendono Tailwind sky-400/violet-400 per convenzione, solo
  // per i badge di stato dei job (in esecuzione / in review) di questa app.
  /** Job in esecuzione. */
  sky: "#38bdf8",
  /** Job in review. */
  violet: "#a78bfa",
} as const;

export type ColorToken = keyof typeof colors;

/** Raggi degli angoli: 8 per i controlli, 10 per le card — vedi il docblock su `designRadii` in `@stubwise/shared` per perché NON c'è (ancora) parità col sito. */
export const radii = designRadii;
