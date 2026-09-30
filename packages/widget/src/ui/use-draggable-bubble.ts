/**
 * Trascinamento della bolla. Pointer Events (mouse, touch e penna, un solo
 * codice): sotto DRAG_THRESHOLD px è un click normale; oltre è un trascinamento,
 * la bolla segue il puntatore e al rilascio si aggancia al bordo più vicino e
 * la posizione si salva per slug. Il click che il browser emette a fine
 * trascinamento va soppresso: `consumeClick()` lo dice a chi gestisce il click.
 *
 * I listener di move/up stanno su `window` e non sulla bolla: non servono
 * `setPointerCapture` (assente in alcuni ambienti) e il puntatore può uscire
 * dalla bolla durante un movimento veloce senza perdere il trascinamento.
 */
import { useEffect, useRef, useState } from "preact/hooks";
import { getPosition, setPosition, type BubblePosition } from "../core/storage.js";
import {
  BUBBLE,
  bubbleBox,
  clampBox,
  DEFAULT_POSITION,
  DRAG_THRESHOLD,
  snapPosition,
  type Box,
  type Viewport,
} from "./placement.js";

/** Viewport di layout (senza scrollbar); fallback su window per ambienti che danno 0. */
function readViewport(): Viewport {
  const el = document.documentElement;
  return {
    width: el.clientWidth || window.innerWidth,
    height: el.clientHeight || window.innerHeight,
  };
}

export function useDraggableBubble(slug: string) {
  const [position, setPos] = useState<BubblePosition>(() => getPosition(slug) ?? DEFAULT_POSITION);
  const [viewport, setViewport] = useState<Viewport>(readViewport);
  const [dragBox, setDragBox] = useState<Box | null>(null);
  // Ha mai spostato la bolla? Coincide con "c'è una posizione salvata": è ciò
  // che spegne la maniglia, senza un flag a parte.
  const [moved, setMoved] = useState(() => getPosition(slug) !== null);
  const suppressClick = useRef(false);
  const detach = useRef<(() => void) | null>(null);

  useEffect(() => {
    const onResize = () => setViewport(readViewport());
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      detach.current?.();
    };
  }, []);

  function onPointerDown(e: PointerEvent) {
    if (e.button !== 0) return;
    // Un click soppresso che il browser non ha poi emesso (succede col touch)
    // non deve mangiarsi il prossimo click vero.
    suppressClick.current = false;
    detach.current?.();
    const vp = readViewport();
    const origin = bubbleBox(position, vp);
    const startX = e.clientX;
    const startY = e.clientY;
    let moved = false;

    const boxAt = (ev: PointerEvent) =>
      clampBox({ left: origin.left + ev.clientX - startX, top: origin.top + ev.clientY - startY }, readViewport());

    const onMove = (ev: PointerEvent) => {
      if (!moved && Math.hypot(ev.clientX - startX, ev.clientY - startY) < DRAG_THRESHOLD) return;
      moved = true;
      setDragBox(boxAt(ev));
    };
    const onUp = (ev: PointerEvent) => {
      remove();
      if (!moved) return;
      const now = readViewport();
      const box = boxAt(ev);
      const next = snapPosition(box.left + BUBBLE / 2, box.top + BUBBLE / 2, now);
      suppressClick.current = true;
      setDragBox(null);
      setViewport(now);
      setPos(next);
      setMoved(true);
      setPosition(slug, next);
    };
    const remove = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      detach.current = null;
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    detach.current = remove;
  }

  /** True (una volta sola) se il click appena arrivato chiude un trascinamento. */
  function consumeClick(): boolean {
    const s = suppressClick.current;
    suppressClick.current = false;
    return s;
  }

  return {
    moved,
    viewport,
    bubble: dragBox ?? bubbleBox(position, viewport),
    dragging: dragBox !== null,
    onPointerDown,
    consumeClick,
  };
}
