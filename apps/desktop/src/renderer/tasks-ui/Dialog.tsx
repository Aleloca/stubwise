import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Un dialogo modale (nuova task, richiesta di decisione): fondo scurito come
 * la palette, superficie che fluttua (bordo forte e ombra morbida: è l'unica
 * cosa sopra la pagina in quel momento). In un portal, così nessun
 * contenitore che scorre lo taglia.
 *
 * - All'apertura il fuoco va sul primo campo (`data-autofocus` se c'è), alla
 *   chiusura torna dove era.
 * - Tab gira dentro il dialogo.
 * - Esc chiude, ma solo se nessuno l'ha già usato (un menu aperto dentro il
 *   dialogo chiude prima sé stesso). `aria-modal` dice al pannello di
 *   dettaglio di non prendersi l'Esc.
 * - Con `confirmDiscard` (il chiamante lo passa solo quando c'è testo scritto)
 *   Esc e il clic fuori non chiudono: il piede chiede se buttare la bozza.
 *   «Keep editing» (o un altro Esc) torna al modulo; il bottone di chiusura
 *   esplicito del chiamante resta immediato.
 */
export function Dialog({
  title,
  description,
  onClose,
  width = 520,
  footer,
  confirmDiscard,
  children,
}: {
  title: string;
  description?: string;
  onClose: () => void;
  width?: number;
  footer?: ReactNode;
  confirmDiscard?: { message: string; keep: string; discard: string };
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [confirming, setConfirming] = useState(false);
  const keepRef = useRef<HTMLButtonElement>(null);
  const asking = confirming && confirmDiscard !== undefined;
  const dismiss = () => (confirmDiscard ? setConfirming(true) : onClose());

  useEffect(() => {
    if (asking) keepRef.current?.focus();
  }, [asking]);
  const titleId = useId();
  const descriptionId = useId();

  useLayoutEffect(() => {
    const origin = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const el = ref.current;
    const first =
      el?.querySelector<HTMLElement>("[data-autofocus]") ??
      el?.querySelector<HTMLElement>(FOCUSABLE);
    first?.focus();
    return () => {
      if (origin?.isConnected) origin.focus();
    };
  }, []);

  // Il clic fuori chiude solo se è cominciato fuori (una selezione di testo
  // trascinata oltre il bordo non chiude il dialogo).
  const downOnBackdrop = useRef(false);

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key === "Escape") {
      if (e.defaultPrevented) return;
      e.preventDefault();
      e.stopPropagation();
      if (asking) setConfirming(false);
      else dismiss();
      return;
    }
    if (e.key !== "Tab") return;
    const items = [...(ref.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])].filter(
      (item) => !item.closest('[role="menu"]'),
    );
    if (items.length === 0) return;
    const first = items[0]!;
    const last = items.at(-1)!;
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }

  return createPortal(
    <div
      className="palette-backdrop fixed inset-0 z-50 overflow-y-auto bg-[var(--scrim)] px-4"
      onMouseDown={(e) => {
        downOnBackdrop.current = e.target === e.currentTarget;
      }}
      onClick={(e) => {
        if (downOnBackdrop.current && e.target === e.currentTarget) dismiss();
      }}
    >
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descriptionId : undefined}
        onKeyDown={onKeyDown}
        style={{ width }}
        className="palette-enter mx-auto my-[10vh] flex max-w-full flex-col rounded-xl border border-rule-strong bg-surface text-ink shadow-[0_24px_48px_-16px_oklch(0_0_0/0.45)]"
      >
        <header className="flex flex-col gap-1 px-5 pt-5 pb-4">
          <h2 id={titleId} className="text-lg font-semibold text-ink">
            {title}
          </h2>
          {description && (
            <p id={descriptionId} className="text-sm text-ink-muted">
              {description}
            </p>
          )}
        </header>
        <div className="flex flex-col gap-4 px-5 pb-5">{children}</div>
        {asking ? (
          <footer
            role="group"
            aria-label={confirmDiscard.message}
            className="flex flex-wrap items-center justify-end gap-2 border-t border-rule px-5 py-3"
          >
            <p className="mr-auto text-sm text-ink">{confirmDiscard.message}</p>
            <button
              ref={keepRef}
              type="button"
              className={secondaryClass}
              onClick={() => setConfirming(false)}
            >
              {confirmDiscard.keep}
            </button>
            <button type="button" className={primaryClass} onClick={onClose}>
              {confirmDiscard.discard}
            </button>
          </footer>
        ) : (
          footer && (
            <footer className="flex items-center justify-end gap-2 border-t border-rule px-5 py-3">
              {footer}
            </footer>
          )
        )}
      </div>
    </div>,
    document.body,
  );
}

// Gli stessi bottoni di `pages/tasks/controls` (qui non si importa dalle pagine).
const primaryClass =
  "inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md bg-ink px-3 text-sm font-semibold text-ground transition-opacity duration-[var(--duration-fast)] ease-out hover:opacity-90 active:opacity-80";
const secondaryClass =
  "inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md border border-rule-strong px-3 text-sm font-medium text-ink transition-colors duration-[var(--duration-fast)] ease-out hover:bg-ink/6 active:bg-ink/10";

/** Etichetta e controllo di un campo di dialogo, uno sopra l'altro. */
export function DialogField({
  label,
  htmlFor,
  hint,
  children,
}: {
  label: string;
  htmlFor?: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      {htmlFor ? (
        <label htmlFor={htmlFor} className="text-sm font-medium text-ink">
          {label}
        </label>
      ) : (
        <span className="text-sm font-medium text-ink">{label}</span>
      )}
      {children}
      {hint && <span className="text-xs text-ink-muted">{hint}</span>}
    </div>
  );
}

/** Campo di testo dei dialoghi e del pannello: filetto forte, fuoco blu (l'anello di sistema). */
export const inputClass =
  "w-full min-w-0 rounded-md border border-rule-strong bg-transparent px-2.5 py-1.5 text-md text-ink placeholder:text-ink-faint transition-colors duration-[var(--duration-fast)] ease-out hover:border-ink/40 focus-visible:border-transparent";

/** Il bottone che apre un menu dentro un modulo: come un campo, con la freccia. */
export const selectButtonClass =
  "flex h-8 w-full min-w-0 items-center gap-2 rounded-md border border-rule-strong px-2.5 text-left text-md text-ink transition-colors duration-[var(--duration-fast)] ease-out hover:border-ink/40 aria-expanded:border-ink/40";
