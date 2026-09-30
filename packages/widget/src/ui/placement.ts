/**
 * Geometria del widget: dove sta la bolla e dove si apre il pannello. Tutte
 * funzioni PURE su numeri (viewport e box in px, coordinate `left`/`top` di un
 * elemento `position: fixed`), così la regola si testa senza DOM. Il widget le
 * applica come variabili CSS: vedi `styles.ts`.
 */
import type { BubblePosition } from "../core/storage.js";

export const EDGE = 20;
export const BUBBLE = 56;
export const GAP = 12;
export const PANEL_WIDTH = 380;
export const PANEL_MAX_HEIGHT = 600;
/** Sotto questa altezza disponibile il pannello non si apre sopra/sotto ma di fianco. */
export const PANEL_MIN_HEIGHT = 360;
/** Spostamento (px) oltre il quale un pointerdown è un trascinamento e non un click. */
export const DRAG_THRESHOLD = 5;

/** Default: in basso a destra (y = 1, clampato a 20px dal fondo), come prima del trascinamento. */
export const DEFAULT_POSITION: BubblePosition = { side: "right", y: 1 };

export interface Viewport { width: number; height: number }
export interface Box { left: number; top: number }
export interface PanelBox extends Box { width: number; height: number }

const clamp = (v: number, min: number, max: number) => Math.min(Math.max(v, min), Math.max(min, max));

/** Centro verticale della bolla dentro i margini. */
function clampCenterY(centerY: number, vp: Viewport): number {
  return clamp(centerY, EDGE + BUBBLE / 2, vp.height - EDGE - BUBBLE / 2);
}

/** Box della bolla agganciata al bordo, dalla posizione salvata. */
export function bubbleBox(pos: BubblePosition, vp: Viewport): Box {
  const left = pos.side === "left" ? EDGE : vp.width - EDGE - BUBBLE;
  return { left, top: clampCenterY(pos.y * vp.height, vp) - BUBBLE / 2 };
}

/** Box della bolla DURANTE il trascinamento: segue il puntatore, ma resta a schermo. */
export function clampBox(box: Box, vp: Viewport): Box {
  return {
    left: clamp(box.left, 0, vp.width - BUBBLE),
    top: clamp(box.top, EDGE, vp.height - EDGE - BUBBLE),
  };
}

/** Posizione da salvare al rilascio: lato più vicino al centro, y come frazione. */
export function snapPosition(centerX: number, centerY: number, vp: Viewport): BubblePosition {
  return {
    side: centerX < vp.width / 2 ? "left" : "right",
    y: clampCenterY(centerY, vp) / vp.height,
  };
}

/**
 * Dove si apre il pannello rispetto alla bolla `b`. Stesso lato della bolla
 * (dedotto dal suo centro, così vale anche mentre la si trascina); sopra se la
 * bolla è nella metà bassa, sotto se in quella alta; di fianco, verso
 * l'interno, se in quella direzione non restano PANEL_MIN_HEIGHT px.
 */
export function placePanel(b: Box, vp: Viewport): PanelBox {
  const onLeft = b.left + BUBBLE / 2 < vp.width / 2;
  const centerY = b.top + BUBBLE / 2;
  const below = centerY < vp.height / 2;
  const space = below ? vp.height - (b.top + BUBBLE + GAP) - EDGE : b.top - GAP - EDGE;

  if (space >= PANEL_MIN_HEIGHT) {
    const width = Math.min(PANEL_WIDTH, vp.width - 2 * EDGE);
    const height = Math.min(PANEL_MAX_HEIGHT, space);
    return {
      left: onLeft ? EDGE : vp.width - EDGE - width,
      top: below ? b.top + BUBBLE + GAP : b.top - GAP - height,
      width,
      height,
    };
  }

  // Di fianco: il pannello parte oltre la bolla, verso l'interno della pagina.
  const inset = EDGE + BUBBLE + GAP;
  const width = Math.min(PANEL_WIDTH, vp.width - inset - EDGE);
  const height = Math.min(PANEL_MAX_HEIGHT, vp.height - 2 * EDGE);
  return {
    left: onLeft ? inset : vp.width - inset - width,
    top: clamp(centerY - height / 2, EDGE, vp.height - EDGE - height),
    width,
    height,
  };
}
