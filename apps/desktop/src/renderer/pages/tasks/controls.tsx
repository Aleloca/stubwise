import { useRef, useState, type ReactNode } from "react";
import { Chevron, Menu } from "../../tasks-ui/Menu";

// Controlli comuni della pagina Tasks: i bottoni della barra dei comandi e
// un bottone che apre un menu (raggruppamento, menu in riga, azioni in blocco).

/** Azione primaria della pagina («New task»): l'inchiostro pieno, una sola per pagina. */
export const primaryButton =
  "inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md bg-ink px-3 text-sm font-semibold text-ground transition-opacity duration-[var(--duration-fast)] ease-out hover:opacity-90 active:opacity-80";

/** Azione secondaria: contorno forte, testo d'inchiostro. */
export const secondaryButton =
  "inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md border border-rule-strong px-3 text-sm font-medium text-ink transition-colors duration-[var(--duration-fast)] ease-out hover:bg-ink/6 active:bg-ink/10";

/**
 * Un bottone che apre un menu sotto (o sopra) di sé. Il menu rende il fuoco
 * al bottone quando si chiude con Esc o con una scelta; con un clic fuori o
 * Tab lo lascia dov'è. `children` riceve `close` per chiudere dopo la scelta.
 */
export function MenuButton({
  label,
  menuLabel,
  className,
  placement,
  align,
  title,
  ariaLabel,
  wrapperClassName = "inline-flex min-w-0",
  disabled = false,
  children,
}: {
  /** Il contenuto del bottone (ne è anche il nome, se `ariaLabel` manca). */
  label: ReactNode;
  /** Il nome accessibile del menu. */
  menuLabel: string;
  className: string;
  placement?: "below" | "above";
  align?: "left" | "right";
  title?: string;
  ariaLabel?: string;
  /** Il contenitore del bottone e del menu (di base si stringe sul contenuto). */
  wrapperClassName?: string;
  disabled?: boolean;
  children: (close: () => void) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const close = (restore = true) => {
    setOpen(false);
    if (restore) button.current?.focus();
  };
  return (
    <span className={`relative ${wrapperClassName}`}>
      <button
        ref={button}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={ariaLabel}
        title={title}
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
        className={className}
      >
        {label}
      </button>
      {open && (
        <Menu label={menuLabel} onClose={close} placement={placement} align={align}>
          {children(() => close())}
        </Menu>
      )}
    </span>
  );
}

export { Chevron };
