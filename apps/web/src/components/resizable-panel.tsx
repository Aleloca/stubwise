import { useEffect, useRef, useState } from "react";

/**
 * Colonna laterale ridimensionabile trascinando il proprio bordo interno.
 * Usata dalle due colonne dello spazio Docs (albero a sinistra, chat a destra):
 * quale sia lo spazio "giusto" dipende dal repo e da cosa si sta facendo, quindi
 * lo decide chi legge. La larghezza è ricordata in `localStorage` sotto
 * `storageKey` (tipicamente per-repository) e il doppio click sull'handle
 * ripristina il default.
 *
 * Pensata per il desktop: su mobile le stesse superfici vivono in un drawer e
 * questo componente non viene montato.
 */
export function ResizablePanel({
  storageKey,
  side,
  defaultWidth,
  minWidth,
  maxWidth,
  label,
  className = "",
  children,
}: {
  storageKey: string;
  /** Lato della pagina occupato dal pannello: determina dove sta l'handle. */
  side: "left" | "right";
  defaultWidth: number;
  minWidth: number;
  maxWidth: number;
  /** Nome accessibile dell'handle di trascinamento. */
  label: string;
  className?: string;
  children: React.ReactNode;
}) {
  const [width, setWidth] = useState(() => {
    const stored = Number(globalThis.localStorage?.getItem(storageKey));
    return Number.isFinite(stored) && stored >= minWidth && stored <= maxWidth
      ? stored
      : defaultWidth;
  });
  const [dragging, setDragging] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!dragging) return;
    const clamp = (value: number) => Math.min(maxWidth, Math.max(minWidth, value));
    const onMove = (event: MouseEvent) => {
      const rect = panelRef.current?.getBoundingClientRect();
      if (!rect) return;
      // A sinistra il bordo mobile è quello destro (e viceversa): la larghezza è
      // sempre la distanza tra il puntatore e il bordo ANCORATO del pannello.
      setWidth(clamp(side === "left" ? event.clientX - rect.left : rect.right - event.clientX));
    };
    const onUp = () => setDragging(false);
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    // Durante il drag il cursore resta quello del resize anche fuori dall'handle
    // e il testo non si seleziona.
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
  }, [dragging, side, minWidth, maxWidth]);

  // Persiste solo a drag finito: niente scritture a ogni pixel.
  useEffect(() => {
    if (dragging) return;
    globalThis.localStorage?.setItem(storageKey, String(width));
  }, [dragging, width, storageKey]);

  return (
    <div ref={panelRef} style={{ width }} className={`relative shrink-0 ${className}`}>
      {children}
      {/* Handle sul bordo interno: la fascia invisibile di 8px rende il bersaglio
          comodo senza spostare il bordo visibile. */}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label={label}
        onMouseDown={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDoubleClick={() => setWidth(defaultWidth)}
        className={`absolute inset-y-0 z-10 w-2 cursor-col-resize transition-colors hover:bg-signal/30 ${
          side === "left" ? "-right-1" : "-left-1"
        } ${dragging ? "bg-signal/40" : ""}`}
      />
    </div>
  );
}
