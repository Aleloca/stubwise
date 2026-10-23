import { createElement, useCallback, useEffect, useState, type ReactNode } from "react";
import { useMediaQuery } from "./useMediaQuery";

export type DetailPanelMode = "docked" | "overlay";

/** Da questa larghezza in su il pannello sta accanto all'area di lavoro. */
export const DOCKED_PANEL_QUERY = "(min-width: 1200px)";

export interface DetailPanelState {
  isOpen: boolean;
  mode: DetailPanelMode;
  open(): void;
  close(): void;
  toggle(): void;
}

/**
 * Apertura del pannello di dettaglio e la sua modalità: affiancato
 * (`docked`) da 1200 px di larghezza, sovrapposto (`overlay`) sotto. La
 * modalità segue la finestra mentre il pannello è aperto.
 */
export function useDetailPanel(initialOpen = false): DetailPanelState {
  const [isOpen, setOpen] = useState(initialOpen);
  const docked = useMediaQuery(DOCKED_PANEL_QUERY);
  const open = useCallback(() => setOpen(true), []);
  const close = useCallback(() => setOpen(false), []);
  const toggle = useCallback(() => setOpen((v) => !v), []);
  return { isOpen, mode: docked ? "docked" : "overlay", open, close, toggle };
}

const MODE_CLASS: Record<DetailPanelMode, string> = {
  docked: "h-full w-[360px] shrink-0 border-l border-rule bg-surface",
  overlay:
    "fixed inset-y-0 right-0 z-40 w-[min(400px,100vw)] border-l border-rule-strong bg-surface",
};

/**
 * Il contenitore del pannello: le aree successive ci mettono dentro il
 * dettaglio. Esc chiude in entrambe le modalità.
 */
export function DetailPanel({
  mode,
  label,
  onClose,
  children,
}: {
  mode: DetailPanelMode;
  label: string;
  onClose: () => void;
  children: ReactNode;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return createElement(
    "section",
    {
      // Affiancato è una regione della pagina; sovrapposto copre il lavoro
      // (senza bloccarlo: non modale) e si annuncia come dialogo.
      role: mode === "overlay" ? "dialog" : undefined,
      "aria-label": label,
      "data-mode": mode,
      className: `flex min-h-0 flex-col overflow-auto ${MODE_CLASS[mode]}`,
    },
    children,
  );
}
