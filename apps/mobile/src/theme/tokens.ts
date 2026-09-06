/**
 * Token di colore e raggio del design (canvas Claude Design "Stubwise
 * Mobile", `designs/app-design.zip`): gli stessi valori della web app — v1 è
 * SOLO dark, non c'è un tema chiaro da switchare (vedi §2 del design doc di
 * fase 4).
 */
export const colors = {
  /** Sfondo primario (schermo). */
  ink950: "#0a0d10",
  /** Sfondo delle card e delle superfici rialzate. */
  ink900: "#0f1318",
  /** Sfondo rialzato di un livello ulteriore (es. header di sezione). */
  ink800: "#181f28",
  /** Bordi e separatori. */
  line: "#1d242d",
  /** Testo primario. */
  fg: "#e9e6df",
  /** Testo secondario. */
  muted: "#98a1ac",
  /** Testo terziario / annotazioni mono (`// commenti`). */
  faint: "#5c6671",
  /** Colore di richiamo: cursore del wordmark, bottoni primari, badge. */
  signal: "#f5a623",
  /** Errori, card "lavoro fallito". */
  danger: "#ff6b6e",
  /** Successo, PR pronta, rilasciato. */
  ok: "#4ad295",
  /** Job in esecuzione. */
  sky: "#38bdf8",
  /** Job in review. */
  violet: "#a78bfa",
} as const;

export type ColorToken = keyof typeof colors;

/** Raggi degli angoli: 8 per i controlli, 10 per le card. */
export const radii = {
  control: 8,
  card: 10,
} as const;
