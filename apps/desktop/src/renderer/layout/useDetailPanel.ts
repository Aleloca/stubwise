import {
  createElement,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";
import { useViewer } from "../data/viewer";
import { useMediaQuery } from "./useMediaQuery";

export type DetailPanelMode = "docked" | "overlay";

/** Da questa larghezza in su il pannello sta accanto all'area di lavoro. */
export const DOCKED_PANEL_QUERY = "(min-width: 1200px)";

/**
 * Le route in cui il pannello si apre sempre sovrapposto, a ogni larghezza:
 * Planning (progetto e trasversale), perché affiancato stringerebbe la
 * matrice (shape planning.md §6).
 */
export function forcesOverlay(pathname: string): boolean {
  return /^\/(p\/[^/]+\/)?planning\/?$/.test(pathname);
}

export const DETAIL_PANEL_MIN_WIDTH = 320;
export const DETAIL_PANEL_MAX_WIDTH = 640;
/** Larghezza di partenza, finché chi guarda non l'ha cambiata. */
const DEFAULT_WIDTH: Record<DetailPanelMode, number> = { docked: 360, overlay: 400 };
/** Passo delle frecce sul bordo. */
const KEY_STEP = 16;

/** La larghezza è di chi guarda (non della vista): una chiave per persona. */
export function detailPanelWidthKey(personId: string): string {
  return `stubwise.detailPanelWidth.${personId}`;
}

const clamp = (w: number) =>
  Math.min(DETAIL_PANEL_MAX_WIDTH, Math.max(DETAIL_PANEL_MIN_WIDTH, Math.round(w)));

// Lo storage può mancare o essere bloccato: il pannello funziona lo stesso,
// solo senza ricordare la larghezza.
function readWidth(key: string): number | null {
  try {
    const raw = window.localStorage.getItem(key);
    const n = raw === null ? NaN : Number(raw);
    return Number.isFinite(n) ? clamp(n) : null;
  } catch {
    return null;
  }
}

function writeWidth(key: string, width: number): void {
  try {
    window.localStorage.setItem(key, String(width));
  } catch {
    // Niente da fare: la larghezza vale per questa sessione.
  }
}

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
  docked: "relative h-full shrink-0 border-l border-rule bg-surface",
  overlay: "panel-enter fixed inset-y-0 right-0 z-40 max-w-[100vw] border-l border-rule-strong bg-surface",
};

/** Un dialogo modale aperto (la palette ⌘K) ha la precedenza su Esc. */
function modalOpen(): boolean {
  if (document.querySelector('[aria-modal="true"]')) return true;
  try {
    return document.querySelector("dialog:modal") !== null;
  } catch {
    return false;
  }
}

/**
 * Il contenitore del pannello: le aree successive ci mettono dentro il
 * dettaglio.
 *
 * - Esc chiude, ma solo se nessun altro l'ha già usato (`defaultPrevented`:
 *   un menu dentro il pannello, la palette) e nessun dialogo modale è aperto.
 * - Sovrapposto, all'apertura il fuoco entra nel pannello e alla chiusura
 *   torna all'elemento da cui si era partiti (se il fuoco non è nel
 *   frattempo andato altrove di proposito). Affiancato non ruba il fuoco: la
 *   vista accanto resta navigabile (J/K).
 * - Si ridimensiona trascinando il bordo sinistro, o col fuoco sul bordo con
 *   frecce/Home/End: 320–640 px, salvata per persona in `localStorage`.
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
  const { t } = useTranslation();
  const personId = useViewer().viewer.personId;
  const storageKey = detailPanelWidthKey(personId);
  const [stored, setStored] = useState<number | null>(() => readWidth(storageKey));
  const width = stored ?? DEFAULT_WIDTH[mode];
  const panel = useRef<HTMLElement>(null);
  const drag = useRef<{ x: number; width: number; pointerId: number } | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented || modalOpen()) return;
      e.preventDefault();
      onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Il fuoco, solo per la modalità con cui il pannello si è aperto: un cambio
  // di finestra a pannello aperto non lo sposta.
  const openedAs = useRef(mode);
  useLayoutEffect(() => {
    if (openedAs.current !== "overlay") return;
    const origin = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const el = panel.current;
    el?.focus();
    return () => {
      const active = document.activeElement;
      const focusLost = !active || active === document.body || (el?.contains(active) ?? false);
      if (focusLost && origin?.isConnected) origin.focus();
    };
  }, []);

  const resize = (next: number, save: boolean) => {
    const w = clamp(next);
    setStored(w);
    if (save) writeWidth(storageKey, w);
  };

  const onHandleKey = (e: ReactKeyboardEvent) => {
    // Il pannello sta a destra: allargarlo è spostare il bordo a sinistra.
    const next: Record<string, number> = {
      ArrowLeft: width + KEY_STEP,
      ArrowRight: width - KEY_STEP,
      Home: DETAIL_PANEL_MIN_WIDTH,
      End: DETAIL_PANEL_MAX_WIDTH,
    };
    if (!(e.key in next)) return;
    e.preventDefault();
    resize(next[e.key]!, true);
  };

  const onPointerDown = (e: ReactPointerEvent<HTMLElement>) => {
    drag.current = { x: e.clientX, width, pointerId: e.pointerId };
    e.currentTarget.setPointerCapture?.(e.pointerId);
    e.preventDefault();
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLElement>) => {
    const d = drag.current;
    if (!d) return;
    resize(d.width + (d.x - e.clientX), false);
  };
  const onPointerUp = (e: ReactPointerEvent<HTMLElement>) => {
    const d = drag.current;
    if (!d) return;
    drag.current = null;
    e.currentTarget.releasePointerCapture?.(d.pointerId);
    resize(d.width + (d.x - e.clientX), true);
  };

  const resizeLabel = t("taskUi.panel.resize");
  const handle = createElement("div", {
    role: "separator",
    "aria-orientation": "vertical",
    "aria-label": resizeLabel,
    title: resizeLabel,
    "aria-valuenow": width,
    "aria-valuemin": DETAIL_PANEL_MIN_WIDTH,
    "aria-valuemax": DETAIL_PANEL_MAX_WIDTH,
    tabIndex: 0,
    onKeyDown: onHandleKey,
    onPointerDown,
    onPointerMove,
    onPointerUp,
    onPointerCancel: onPointerUp,
    // Area di presa di 8 px a cavallo del filetto; la linea d'inchiostro
    // compare al passaggio, al trascinamento e al fuoco.
    className:
      "group absolute inset-y-0 -left-1 z-10 w-2 cursor-col-resize touch-none outline-none",
    children: createElement("span", {
      "aria-hidden": true,
      className:
        "absolute inset-y-0 left-[3px] w-0.5 bg-transparent transition-colors duration-[var(--duration-fast)] ease-out group-hover:bg-ink/25 group-focus-visible:bg-focus group-active:bg-ink/40",
    }),
  });

  return createElement(
    "section",
    {
      ref: panel,
      // Affiancato è una regione della pagina; sovrapposto copre il lavoro
      // (senza bloccarlo: non modale) e si annuncia come dialogo.
      role: mode === "overlay" ? "dialog" : undefined,
      "aria-label": label,
      "data-mode": mode,
      "data-detail-panel": "",
      tabIndex: -1,
      style: { width },
      className: `flex min-h-0 flex-col outline-none ${MODE_CLASS[mode]}`,
    },
    handle,
    createElement(
      "div",
      { className: "flex min-h-0 flex-1 flex-col overflow-auto" },
      children,
    ),
  );
}
