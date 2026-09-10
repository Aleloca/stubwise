/**
 * Colore per casella nella griglia del calendario (fase 9, Task 6, design
 * §5): **l'accento ambra resta UNO**. Niente tinte nuove per le caselle —
 * solo luminosità e saturazione diverse sulla STESSA tonalità ambra
 * (`--color-signal`, hue ≈ 36°): una casella si distingue dall'altra, ma
 * resta "della famiglia ambra", mai un blu o un verde accanto a lei.
 *
 * Deterministico sull'INDICE della casella (l'ordine in cui compare nella
 * lista caselle dell'utente), non sul suo id: lo stesso indice dà sempre lo
 * stesso colore nella stessa sessione, e il primo account (quello quasi
 * sempre presente) prende la tonalità più vicina al segnale "vero".
 */
const AMBER_HUE = 36;

interface HueVariant {
  saturation: number;
  lightness: number;
}

/** Cinque varianti sulla stessa tonalità: bastano per il numero di caselle che un utente collega davvero. */
const VARIANTS: HueVariant[] = [
  { saturation: 74, lightness: 52 }, // vicino a --color-signal
  { saturation: 55, lightness: 66 },
  { saturation: 88, lightness: 40 },
  { saturation: 40, lightness: 58 },
  { saturation: 65, lightness: 32 },
];

export interface AccountColor {
  /** Testo/bordo pieno (badge, bollino). */
  solid: string;
  /** Bordo tenue (contorno di un evento). */
  border: string;
  /** Sfondo tenue (superficie di un evento). */
  background: string;
}

export function accountColorForIndex(index: number): AccountColor {
  const variant = VARIANTS[index % VARIANTS.length]!;
  const { saturation, lightness } = variant;
  return {
    solid: `hsl(${AMBER_HUE} ${saturation}% ${Math.min(lightness + 18, 88)}%)`,
    border: `hsl(${AMBER_HUE} ${saturation}% ${lightness}% / 0.55)`,
    background: `hsl(${AMBER_HUE} ${saturation}% ${lightness}% / 0.16)`,
  };
}
