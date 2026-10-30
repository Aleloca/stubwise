// I segni delle Preferenze → Notifiche: ⓘ accanto a Phone, la freccia dei
// gruppi, i tre punti del menu del gruppo.

export function InfoGlyph() {
  return (
    <svg
      viewBox="0 0 16 16"
      width={13}
      height={13}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.4}
      strokeLinecap="round"
      aria-hidden="true"
      focusable="false"
    >
      <circle cx="8" cy="8" r="6.25" />
      <path d="M8 7.25v4M8 4.75h.01" />
    </svg>
  );
}

export function ChevronGlyph({ open }: { open: boolean }) {
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
      className={`shrink-0 text-ink-muted transition-transform duration-[var(--duration-fast)] ease-out ${open ? "rotate-90" : ""}`}
    >
      <path d="m6 3.5 4.5 4.5L6 12.5" />
    </svg>
  );
}

export function MoreGlyph() {
  return (
    <svg
      viewBox="0 0 16 16"
      width={16}
      height={16}
      fill="currentColor"
      aria-hidden="true"
      focusable="false"
    >
      <circle cx="3.5" cy="8" r="1.25" />
      <circle cx="8" cy="8" r="1.25" />
      <circle cx="12.5" cy="8" r="1.25" />
    </svg>
  );
}

// I segni delle Preferenze personali (area 9a): la spunta di «On», il
// cerchio vuoto di «Off» e dei requisiti, il triangolo d'avviso.

const STROKE = {
  viewBox: "0 0 16 16",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.5,
  strokeLinecap: "round",
  strokeLinejoin: "round",
  "aria-hidden": true,
  focusable: false,
} as const;

export function CheckGlyph({ size = 16 }: { size?: number }) {
  return (
    <svg {...STROKE} width={size} height={size} strokeWidth={1.75}>
      <path d="m3.5 8.25 3 3 6-6.5" />
    </svg>
  );
}

export function OpenCircleGlyph({ size = 14 }: { size?: number }) {
  return (
    <svg {...STROKE} width={size} height={size}>
      <circle cx="8" cy="8" r="5.75" />
    </svg>
  );
}

export function TriangleGlyph({ size = 14 }: { size?: number }) {
  return (
    <svg {...STROKE} width={size} height={size}>
      <path d="M8 2.5 14 13H2L8 2.5Z" />
      <path d="M8 6.75v2.75M8 11.25h.01" />
    </svg>
  );
}
