import { useLayoutEffect, useRef, type ReactNode } from "react";
import { usePeople } from "../../../data/queries";
import { now } from "../../../data/dates";

// Pezzi comuni della conversazione: l'ora di un evento, il nome di una
// persona, le icone (tratto 1.4 su griglia 16, come il binario) e i bottoni.

/** «10:41» oggi; «Oct 21, 10:41» un altro giorno (orologio del prototipo). */
export function clock(iso: string, language: string): string {
  const sameDay = iso.slice(0, 10) === now().slice(0, 10);
  return new Intl.DateTimeFormat(language, {
    ...(sameDay ? {} : { month: "short", day: "numeric" }),
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "UTC",
  }).format(new Date(iso));
}

/**
 * Una scheda che si risolve (risposta, decisione, esito) smonta il bottone
 * che aveva il fuoco: il fuoco va alla riga che ne prende il posto
 * (`tabIndex={-1}`), se era nella scheda o è finito sul `body` — mai se chi
 * guarda è altrove.
 */
export function useFocusWhenResolved<T extends HTMLElement>(resolved: boolean) {
  const ref = useRef<T>(null);
  const was = useRef(resolved);
  useLayoutEffect(() => {
    if (resolved && !was.current) {
      const active = document.activeElement;
      const lost = !active || active === document.body || ref.current?.contains(active);
      if (lost) ref.current?.focus();
    }
    was.current = resolved;
  }, [resolved]);
  return ref;
}

/** Il nome di una persona (o niente finché le persone non sono lette). */
export function usePersonName(personId: string | null | undefined): string {
  const people = usePeople().data;
  return people?.find((p) => p.id === personId)?.name ?? "";
}

export function Glyph({ children, size = 16 }: { children: ReactNode; size?: number }) {
  return (
    <svg
      viewBox="0 0 16 16"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.4}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      className="shrink-0"
    >
      {children}
    </svg>
  );
}

export const CheckGlyph = ({ size }: { size?: number }) => (
  <Glyph size={size}>
    <path d="m3.5 8.5 3 3 6-7" />
  </Glyph>
);
export const CrossGlyph = ({ size }: { size?: number }) => (
  <Glyph size={size}>
    <path d="m4.5 4.5 7 7m0-7-7 7" />
  </Glyph>
);
/** «Annullata»: la freccia che torna indietro (↺). */
export const UndoneGlyph = ({ size }: { size?: number }) => (
  <Glyph size={size}>
    <path d="M4 3.5v3.5h3.5" />
    <path d="M4.3 7A4.6 4.6 0 1 1 5 11.6" />
  </Glyph>
);
/** Le righe dei motivi di una scheda (area 10a): avvisa, automazione, non si annulla, codice. */
export const BellGlyph = () => (
  <Glyph>
    <path d="M4.5 10.8V7.3a3.5 3.5 0 0 1 7 0v3.5l1 1.2h-9z" />
    <path d="M6.8 13.5a1.3 1.3 0 0 0 2.4 0" />
  </Glyph>
);
export const AutomationGlyph = () => (
  <Glyph>
    <path d="M9 1.8 4 9h4l-1 5.2L12 7H8z" />
  </Glyph>
);
export const IrreversibleGlyph = () => (
  <Glyph>
    <circle cx="8" cy="8" r="5.5" />
    <path d="m4.1 11.9 7.8-7.8" />
  </Glyph>
);
export const LockGlyph = () => (
  <Glyph>
    <rect x="3.5" y="7" width="9" height="6.5" rx="1.2" />
    <path d="M5.5 7V5.3a2.5 2.5 0 0 1 5 0V7" />
  </Glyph>
);
export const DisclosureGlyph = ({ open }: { open: boolean }) => (
  <span
    aria-hidden="true"
    className={`inline-grid transition-transform duration-[var(--duration-fast)] ease-out motion-reduce:transition-none ${open ? "rotate-90" : ""}`}
  >
    <Glyph size={12}>
      <path d="m6 3.5 4.5 4.5L6 12.5" />
    </Glyph>
  </span>
);
export const PaperclipGlyph = () => (
  <Glyph>
    <path d="M10.5 4.5 5.6 9.4a1.4 1.4 0 0 0 2 2l5-5a2.8 2.8 0 0 0-4-4l-5 5a4.2 4.2 0 0 0 6 6l4.4-4.4" />
  </Glyph>
);
export const FileGlyph = () => (
  <Glyph>
    <path d="M4 1.8h5l3 3v9.4H4z" />
    <path d="M9 1.8v3h3" />
  </Glyph>
);
export const StopGlyph = () => (
  <Glyph size={12}>
    <rect x="4" y="4" width="8" height="8" rx="1" fill="currentColor" stroke="none" />
  </Glyph>
);
export const SendGlyph = () => (
  <Glyph size={14}>
    <path d="M8 13V3m0 0L3.8 7.2M8 3l4.2 4.2" />
  </Glyph>
);
export const ArrowDownGlyph = () => (
  <Glyph size={12}>
    <path d="M8 3v10m0 0 4-4m-4 4-4-4" />
  </Glyph>
);
export const HashGlyph = () => (
  <Glyph size={14}>
    <path d="M6 2.5 4.8 13.5M11.2 2.5 10 13.5M3 6h10.5M2.5 10H13" />
  </Glyph>
);
export const AtGlyph = () => (
  <Glyph size={14}>
    <circle cx="8" cy="8" r="2.5" />
    <path d="M10.5 8v1a1.8 1.8 0 0 0 3.5 0V8a6 6 0 1 0-2.4 4.8" />
  </Glyph>
);
export const SlashGlyph = () => (
  <Glyph size={14}>
    <path d="M10.5 2.5 5.5 13.5" />
  </Glyph>
);

/** L'anello tratteggiato di Claude (che pulsa mentre è in corso, fermo con movimento ridotto). */
export function WorkingRing({ label, size = 12 }: { label?: string; size?: number }) {
  return (
    <span
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      style={{ width: size, height: size }}
      className="rail-pulse inline-block shrink-0 rounded-full border-[1.5px] border-dashed border-claude"
    />
  );
}

/** Bottoni delle schede: primario (inchiostro pieno), secondario (contorno), quieto (solo testo). */
export const primaryButton =
  "inline-flex h-8 shrink-0 items-center justify-center gap-1.5 rounded-md bg-ink px-3 text-sm font-semibold text-ground transition-opacity duration-[var(--duration-fast)] ease-out hover:opacity-90 active:opacity-80 disabled:opacity-40";
export const secondaryButton =
  "inline-flex h-8 shrink-0 items-center justify-center gap-1.5 rounded-md border border-rule-strong px-3 text-sm font-medium text-ink transition-colors duration-[var(--duration-fast)] ease-out hover:bg-ink/6 active:bg-ink/10 disabled:opacity-40";
export const quietButton =
  "inline-flex h-8 shrink-0 items-center justify-center gap-1.5 rounded-md px-2.5 text-sm font-medium text-ink-muted transition-colors duration-[var(--duration-fast)] ease-out hover:bg-ink/6 hover:text-ink active:bg-ink/10 disabled:opacity-40";

/** Il contorno delle schede di decisione: l'unico del flusso (1px rule-strong, 8px, nessuna ombra). */
export const cardClass = "event-enter flex min-w-0 flex-col rounded-lg border border-rule-strong";
