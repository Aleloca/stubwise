import type { ServerRow } from "../../data/servers";
import type { ServerCheck } from "../../data/types";
import { Glyph } from "../automations/glyphs";

// I glifi della sezione Servers (shape servers.md §3): sempre accanto alla
// parola, mai da soli (`aria-hidden`); il colore solo di stato.

const Check = ({ className }: { className: string }) => (
  <Glyph className={className}>
    <path d="m4 8.5 2.5 2.5L12 5.5" />
  </Glyph>
);

export const TroubleGlyph = () => (
  <Glyph className="text-warning">
    <path d="M8 3 13.5 12.5h-11z" />
    <path d="M8 7v2.5M8 11h.01" />
  </Glyph>
);

/** ● pieno con la croce: «non risponde», «giù». */
export const DownGlyph = () => (
  <svg
    viewBox="0 0 16 16"
    width={16}
    height={16}
    aria-hidden="true"
    focusable="false"
    className="text-critical"
  >
    <circle cx="8" cy="8" r="6" fill="currentColor" />
    <path
      d="m5.8 5.8 4.4 4.4m0-4.4-4.4 4.4"
      stroke="var(--color-ground)"
      strokeWidth={1.5}
      strokeLinecap="round"
    />
  </svg>
);

export function HealthGlyph({ health }: { health: ServerRow["health"]["health"] }) {
  switch (health) {
    case "healthy":
      return <Check className="text-ink-muted" />;
    case "recovered":
      return <Check className="text-positive" />;
    case "trouble":
      return <TroubleGlyph />;
    case "down":
      return <DownGlyph />;
    case "never_connected":
      return (
        <Glyph className="text-ink-faint">
          <circle cx="8" cy="8" r="5" />
        </Glyph>
      );
  }
}

export function CheckGlyph({ status }: { status: ServerCheck["status"] }) {
  if (status === "up") return <Check className="text-positive" />;
  if (status === "down") return <DownGlyph />;
  return (
    <Glyph className="text-ink-faint">
      <circle cx="8" cy="8" r="5" />
    </Glyph>
  );
}

export function CloseGlyph() {
  return (
    <Glyph size={12}>
      <path d="m4 4 8 8m0-8-8 8" />
    </Glyph>
  );
}

/** La freccia dell'ordinamento di una colonna. */
export function SortGlyph({ up }: { up: boolean }) {
  return (
    <Glyph size={12}>
      <path d={up ? "M8 12.5v-9M4.5 7 8 3.5 11.5 7" : "M8 3.5v9M4.5 9 8 12.5 11.5 9"} />
    </Glyph>
  );
}

export function CopyGlyph() {
  return (
    <Glyph size={14}>
      <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" />
      <path d="M10.5 5.5v-2a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2" />
    </Glyph>
  );
}

/** L'escursione minima del mini-grafico, in punti percentuali: un server fermo resta piatto. */
export const SPARK_MIN_SPAN = 10;

/**
 * La scala del mini-grafico: il campo dei valori (min–max), allargato
 * attorno al centro fino a `SPARK_MIN_SPAN` punti e tenuto dentro 0–100.
 */
export function sparkScale(values: number[]): { lo: number; hi: number } {
  const clamped = values.map((v) => Math.min(100, Math.max(0, v)));
  let lo = Math.min(...clamped);
  let hi = Math.max(...clamped);
  if (hi - lo < SPARK_MIN_SPAN) {
    const mid = (lo + hi) / 2;
    lo = Math.max(0, Math.min(100 - SPARK_MIN_SPAN, mid - SPARK_MIN_SPAN / 2));
    hi = lo + SPARK_MIN_SPAN;
  }
  return { lo, hi };
}

/**
 * Mini-grafico della CPU recente (96×20, decorativo: la salute è già in
 * parole). Scalato sul campo dei valori, così l'andamento si legge anche con
 * la CPU bassa invece di restare un filetto sul fondo.
 */
export function Sparkline({ values }: { values: number[] }) {
  if (values.length < 2) return <span aria-hidden="true" className="inline-block h-5 w-24" />;
  const { lo, hi } = sparkScale(values);
  const points = values
    .map((v, i) => {
      const f = (Math.min(100, Math.max(0, v)) - lo) / (hi - lo);
      return `${((i / (values.length - 1)) * 96).toFixed(1)},${(19 - f * 18).toFixed(1)}`;
    })
    .join(" ");
  return (
    <svg
      viewBox="0 0 96 20"
      width={96}
      height={20}
      aria-hidden="true"
      focusable="false"
      data-sparkline
      className="shrink-0 text-ink-muted"
    >
      <polyline
        points={points}
        fill="none"
        stroke="currentColor"
        strokeWidth={1.25}
        strokeLinejoin="round"
      />
    </svg>
  );
}
