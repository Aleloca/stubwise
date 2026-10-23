import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

const HOVER_DELAY_MS = 250;

/**
 * Etichetta che compare a destra del controllo, al passaggio del puntatore o
 * al fuoco da tastiera; Esc la chiude. È solo visiva: il nome accessibile
 * resta sul controllo (`aria-label`), così non si legge due volte.
 * Va in un portal, perché la zona delle tessere scorre e taglierebbe tutto
 * ciò che esce dai suoi bordi.
 */
export function Tooltip({
  label,
  shortcut,
  children,
}: {
  label: string;
  shortcut?: string;
  children: ReactNode;
}) {
  const anchor = useRef<HTMLSpanElement>(null);
  const timer = useRef<number | undefined>(undefined);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);
  // Un clic dà anche il fuoco: in quel caso il tooltip non deve ricomparire.
  const fromPointer = useRef(false);

  function show(delay: number) {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      const rect = anchor.current?.getBoundingClientRect();
      if (rect) setPosition({ left: rect.right + 8, top: rect.top + rect.height / 2 });
    }, delay);
  }

  function hide() {
    window.clearTimeout(timer.current);
    setPosition(null);
  }

  useEffect(() => () => window.clearTimeout(timer.current), []);

  useEffect(() => {
    if (!position) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setPosition(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [position]);

  return (
    <span
      ref={anchor}
      className="flex"
      onPointerEnter={() => show(HOVER_DELAY_MS)}
      onPointerLeave={hide}
      onFocus={() => {
        if (!fromPointer.current) show(0);
        fromPointer.current = false;
      }}
      onBlur={hide}
      onPointerDown={() => {
        fromPointer.current = true;
        hide();
      }}
    >
      {children}
      {position &&
        createPortal(
          <span
            role="tooltip"
            style={{ left: position.left, top: position.top }}
            className="pointer-events-none fixed z-50 flex max-w-80 -translate-y-1/2 items-baseline gap-3 rounded-md border border-rule-strong bg-surface px-2.5 py-1.5 text-sm text-ink shadow-[0_4px_16px_-4px_oklch(0_0_0/0.35)]"
          >
            <span>{label}</span>
            {shortcut && <kbd className="num font-sans text-xs text-ink-muted">{shortcut}</kbd>}
          </span>,
          document.body,
        )}
    </span>
  );
}
