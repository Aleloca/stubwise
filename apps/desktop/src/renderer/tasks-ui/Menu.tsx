import { useEffect, useLayoutEffect, useRef, type KeyboardEvent, type ReactNode } from "react";

// Menu a comparsa dei chip e delle righe (barra dei filtri, menu in riga,
// barra delle azioni in blocco): un solo comportamento da tastiera e un solo
// aspetto. Stava dentro `FilterBar`; ne è uscito quando l'hanno voluto anche
// le pagine delle task.

const ITEM_SELECTOR = '[role^="menuitem"]';

/**
 * Il menu di un chip: si apre sotto, prende il fuoco sul primo elemento,
 * frecce/Home/End scorrono, Esc lo chiude e rende il fuoco al chip — con
 * `preventDefault`, così pannelli e palette sotto non lo prendono per loro.
 * Tab o un clic fuori lo chiudono senza spostare il fuoco.
 */
export function Menu({
  label,
  onClose,
  align = "left",
  placement = "below",
  children,
}: {
  label: string;
  onClose: (restoreFocus: boolean) => void;
  align?: "left" | "right";
  /** Sopra il controllo quando sotto non c'è posto (la barra in fondo all'area). */
  placement?: "below" | "above";
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    ref.current?.querySelector<HTMLElement>(ITEM_SELECTOR)?.focus();
  }, []);

  useEffect(() => {
    const onPointer = (e: PointerEvent) => {
      const wrap = ref.current?.parentElement;
      if (wrap && !wrap.contains(e.target as Node)) onClose(false);
    };
    document.addEventListener("pointerdown", onPointer);
    return () => document.removeEventListener("pointerdown", onPointer);
  }, [onClose]);

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    const items = [...(ref.current?.querySelectorAll<HTMLElement>(ITEM_SELECTOR) ?? [])];
    const at = items.indexOf(document.activeElement as HTMLElement);
    const go = (i: number) => {
      e.preventDefault();
      items[(i + items.length) % items.length]?.focus();
    };
    switch (e.key) {
      case "ArrowDown":
        return go(at + 1);
      case "ArrowUp":
        return go(at - 1);
      case "Home":
        return go(0);
      case "End":
        return go(items.length - 1);
      case "Escape":
        e.preventDefault();
        onClose(true);
        return;
      case "Tab":
        onClose(false);
        return;
    }
  }

  return (
    <div
      ref={ref}
      role="menu"
      aria-label={label}
      onKeyDown={onKeyDown}
      className={`menu-enter absolute z-30 flex ${placement === "above" ? "bottom-full mb-1" : "top-full mt-1"} max-h-96 max-w-80 min-w-56 flex-col overflow-y-auto rounded-lg border border-rule-strong bg-surface p-1.5 shadow-[0_12px_32px_-8px_oklch(0_0_0/0.4)] ${align === "right" ? "right-0" : "left-0"}`}
    >
      {children}
    </div>
  );
}

export const itemClass =
  "flex min-h-8 w-full shrink-0 items-center gap-2.5 rounded-md px-2 py-1 text-left text-sm text-ink outline-none transition-colors duration-[var(--duration-fast)] ease-out hover:bg-ink/6 focus-visible:bg-ink/8";

export function CheckBox({ checked }: { checked: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={`grid size-3.5 shrink-0 place-items-center rounded-[3px] border ${checked ? "border-ink bg-ink text-ground" : "border-rule-strong"}`}
    >
      {checked && (
        <svg viewBox="0 0 16 16" width={10} height={10} fill="none" stroke="currentColor" strokeWidth={2.4}>
          <path d="m3.5 8.5 3 3 6-7" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      )}
    </span>
  );
}

export function RadioDot({ checked }: { checked: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={`grid size-3.5 shrink-0 place-items-center rounded-full border ${checked ? "border-ink" : "border-rule-strong"}`}
    >
      {checked && <span className="size-1.5 rounded-full bg-ink" />}
    </span>
  );
}

export function CheckItem({
  checked,
  onToggle,
  children,
}: {
  checked: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      role="menuitemcheckbox"
      aria-checked={checked}
      tabIndex={-1}
      onClick={onToggle}
      className={itemClass}
    >
      <CheckBox checked={checked} />
      {children}
    </button>
  );
}

export function RadioItem({
  checked,
  onSelect,
  children,
}: {
  checked: boolean;
  onSelect: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      role="menuitemradio"
      aria-checked={checked}
      tabIndex={-1}
      onClick={onSelect}
      className={itemClass}
    >
      <RadioDot checked={checked} />
      {children}
    </button>
  );
}

/** Un gruppo del menu con la sua intestazione (`heading-group`: è un'etichetta di gruppo). */
export function MenuGroup({ label, children }: { label?: string; children: ReactNode }) {
  return (
    <div role="group" aria-label={label} className="flex flex-col not-first:mt-1 not-first:border-t not-first:border-rule not-first:pt-1">
      {label && (
        <span aria-hidden="true" className="heading-group px-2 pt-1.5 pb-1">
          {label}
        </span>
      )}
      {children}
    </div>
  );
}

/** Una riga che spiega, non un'azione: resta raggiungibile con le frecce. */
export function MenuNote({ children }: { children: ReactNode }) {
  return (
    <span
      role="menuitem"
      aria-disabled="true"
      tabIndex={-1}
      className="block px-2 py-1.5 text-xs text-ink-muted outline-none focus-visible:bg-ink/6"
    >
      {children}
    </span>
  );
}


export function Chevron() {
  return (
    <svg
      viewBox="0 0 16 16"
      width={12}
      height={12}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      className="shrink-0 text-ink-faint"
    >
      <path d="m4.5 6.5 3.5 3.5 3.5-3.5" />
    </svg>
  );
}

