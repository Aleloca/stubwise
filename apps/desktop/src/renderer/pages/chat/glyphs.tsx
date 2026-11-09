import type { ReactNode } from "react";

// I glifi della Chat fuori dal flusso: canale aperto («#»), privato
// (lucchetto), silenziato (campanella barrata), bozza (matita), «+». Stesso
// tratto delle icone del binario, su griglia 16, `currentColor`.

function Glyph({ size = 14, children }: { size?: number; children: ReactNode }) {
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

export const HashGlyph = ({ size }: { size?: number }) => (
  <Glyph size={size}>
    <path d="M6.2 2.5 5 13.5M11 2.5 9.8 13.5M2.8 6h11M2.2 10h11" />
  </Glyph>
);

export const LockGlyph = ({ size }: { size?: number }) => (
  <Glyph size={size}>
    <rect x="3.5" y="7" width="9" height="6.5" rx="1.5" />
    <path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" />
  </Glyph>
);

export const MutedGlyph = () => (
  <Glyph size={12}>
    <path d="M4.5 11.5h7l-1-1.5V7a2.5 2.5 0 0 0-4.6-1.4M4.8 7.2V10l-1.3 1.5M6.8 13.2a1.4 1.4 0 0 0 2.4 0M2.5 2.5l11 11" />
  </Glyph>
);

export const DraftGlyph = () => (
  <Glyph size={12}>
    <path d="m10.5 2.8 2.7 2.7-7.4 7.4-3.3.6.6-3.3 7.4-7.4Z" />
  </Glyph>
);

export const PlusGlyph = ({ size = 14 }: { size?: number }) => (
  <Glyph size={size}>
    <path d="M8 3v10M3 8h10" />
  </Glyph>
);

export const ComposeGlyph = () => (
  <Glyph size={14}>
    <path d="M12.5 8.5V13a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V4.5a1 1 0 0 1 1-1h4.5" />
    <path d="m11.3 2.2 2.5 2.5L8.5 10l-3 .5.5-3 5.3-5.3Z" />
  </Glyph>
);

/** La freccia di un gruppo che si apre e si chiude: giù aperto, a destra chiuso. */
export const DisclosureGlyph = ({ open }: { open: boolean }) => (
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
    className={`shrink-0 text-ink-faint transition-transform duration-[var(--duration-fast)] ease-out motion-reduce:transition-none ${open ? "" : "-rotate-90"}`}
  >
    <path d="m4.5 6.5 3.5 3.5 3.5-3.5" />
  </svg>
);
