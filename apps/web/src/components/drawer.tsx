import { useEffect, useRef } from "react";

interface DrawerProps {
  open: boolean;
  onClose: () => void;
  side?: "left" | "right";
  /** Larghezza del pannello (classe Tailwind). Default: `w-[min(86vw,20rem)]`. */
  widthClassName?: string;
  "aria-label": string;
  /** Inoltrato al pannello (`role="dialog"`): es. target di un `aria-controls`. */
  id?: string;
  children: React.ReactNode;
}

/**
 * Pannello off-canvas riusabile (nav app-shell, albero/chat Docs). Mentre è
 * aperto: blocca lo scroll del body, chiude su Escape e su click del backdrop,
 * e porta il focus sul pannello (focus-trap di base). Resta montato anche da
 * chiuso per animare il translate, ma diventa non interattivo (`aria-hidden`).
 */
export function Drawer({
  open,
  onClose,
  side = "left",
  widthClassName = "w-[min(86vw,20rem)]",
  children,
  ...rest
}: DrawerProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden"; // blocca lo scroll del body
    panelRef.current?.focus();
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [open, onClose]);

  const translate = open
    ? "translate-x-0"
    : side === "left"
      ? "-translate-x-full"
      : "translate-x-full";
  const edge = side === "left" ? "left-0" : "right-0";
  return (
    <div className={open ? "" : "pointer-events-none"} aria-hidden={!open}>
      {/* backdrop */}
      <div
        data-drawer-backdrop
        className={`fixed inset-0 z-40 bg-black/60 transition-opacity ${open ? "opacity-100" : "opacity-0"}`}
        onClick={onClose}
      />
      <div
        ref={panelRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        className={`fixed inset-y-0 ${edge} z-50 ${widthClassName} border-line bg-ink-900 transition-transform duration-200 ${translate} ${side === "left" ? "border-r" : "border-l"}`}
        {...rest}
      >
        {children}
      </div>
    </div>
  );
}
