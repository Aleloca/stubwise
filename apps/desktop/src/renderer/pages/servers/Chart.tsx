import { useId, useState, type KeyboardEvent, type MouseEvent } from "react";
import { useTranslation } from "react-i18next";
import type { MetricRange } from "../../data/servers";
import { clockLocal, dayLocal } from "./format";

/** Gli intervalli di più giorni: l'asse e il cursore dicono anche il giorno. */
export const MULTI_DAY: ReadonlySet<MetricRange> = new Set(["7d", "30d", "90d"]);

// Un grafico piccolo dei server (shape servers.md §3, «Charts»): SVG in
// linea, nessuna libreria. Il riassunto in parole è sempre visibile ed è il
// testo accessibile; la soglia è una linea tratteggiata, gli episodi una
// fascia; il cursore è condiviso fra i grafici (al passaggio, o con ←/→
// col fuoco sul grafico). Senza dati: «No data in this range».

const W = 1000;
const H = 120;

/**
 * Da che parte della fascia va l'etichetta di un episodio: dove le linee,
 * dentro la fascia, lasciano più spazio (sopra il loro massimo o sotto il
 * loro minimo). Senza valori nella fascia: sopra.
 */
export function bandLabelSide(
  band: Band,
  times: number[],
  series: { values: (number | null)[] }[],
  max: number,
): "top" | "bottom" {
  const inside: number[] = [];
  times.forEach((ts, i) => {
    if (ts < band.from || ts > band.to) return;
    for (const s of series) {
      const v = s.values[i];
      if (v !== null && v !== undefined) inside.push(Math.min(1, Math.max(0, v / max)));
    }
  });
  if (inside.length === 0) return "top";
  const above = 1 - Math.max(...inside);
  const below = Math.min(...inside);
  return above >= below ? "top" : "bottom";
}

export interface Band {
  from: number;
  to: number;
  label?: string;
}

interface Series {
  values: (number | null)[];
  dashed?: boolean;
}

/** La media e il picco (con l'istante) di una serie, saltando i buchi. */
export function stats(values: (number | null)[], times: number[]) {
  let sum = 0;
  let n = 0;
  let peak = -Infinity;
  let at = 0;
  values.forEach((v, i) => {
    if (v === null) return;
    sum += v;
    n++;
    if (v > peak) {
      peak = v;
      at = times[i]!;
    }
  });
  return n === 0 ? null : { avg: sum / n, peak, at };
}

function pathOf(values: (number | null)[], xs: number[], max: number): string {
  let d = "";
  let open = false;
  values.forEach((v, i) => {
    if (v === null) {
      open = false;
      return;
    }
    const y = H - (Math.min(v, max) / max) * H;
    d += `${open ? "L" : "M"}${xs[i]!.toFixed(1)},${y.toFixed(1)}`;
    open = true;
  });
  return d;
}

export function Chart({
  title,
  subtitle,
  summary,
  series,
  times,
  from,
  to,
  max,
  format,
  threshold,
  bands,
  cursor,
  setCursor,
  legend,
  range,
  dataKey,
}: {
  title: string;
  subtitle?: string;
  summary: string;
  series: Series[];
  times: number[];
  from: number;
  to: number;
  max: number;
  format: (v: number) => string;
  threshold?: { value: number; label: string } | null;
  bands: Band[];
  cursor: number | null;
  setCursor: (ts: number | null) => void;
  legend?: { label: string; dashed: boolean }[];
  range: MetricRange;
  dataKey: string;
}) {
  const { t, i18n } = useTranslation();
  const titleId = useId();
  const summaryId = useId();
  // L'etichetta del cursore si annuncia solo quando la si muove da tastiera
  // (←/→): al passaggio del mouse sarebbe un annuncio a ogni pixel.
  const [byKeys, setByKeys] = useState(false);
  const span = to - from;
  const frac = (ts: number) => Math.min(1, Math.max(0, (ts - from) / span));
  const xs = times.map((ts) => frac(ts) * W);
  const empty = series.every((s) => s.values.every((v) => v === null));
  // Il punto più vicino al cursore, per l'etichetta.
  const near =
    cursor === null || times.length === 0
      ? -1
      : times.reduce(
          (best, ts, i) => (Math.abs(ts - cursor) < Math.abs(times[best]! - cursor) ? i : best),
          0,
        );
  const tick = (ts: number) =>
    MULTI_DAY.has(range)
      ? dayLocal(new Date(ts).toISOString(), i18n.language)
      : clockLocal(new Date(ts).toISOString(), i18n.language);
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => from + f * span);
  // L'etichetta della soglia sta in alto a destra quando la soglia è alta: un
  // episodio che arriva al bordo destro (ancora aperto; a 30d e 90d è una
  // fascia sottile lì) mette la sua etichetta sotto, invece di sovrapporsi.
  const labelSide = (b: Band): "top" | "bottom" => {
    const side = bandLabelSide(b, times, series, max);
    const thresholdTop = !!threshold && threshold.value / max > 0.8;
    return side === "top" && thresholdTop && frac(b.to) > 0.9 ? "bottom" : side;
  };

  const onMove = (e: MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    if (rect.width === 0) return;
    setByKeys(false);
    setCursor(from + ((e.clientX - rect.left) / rect.width) * span);
  };
  const onKey = (e: KeyboardEvent<HTMLElement>) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    if (times.length === 0) return;
    e.preventDefault();
    setByKeys(true);
    const at = near === -1 ? times.length - 1 : near + (e.key === "ArrowLeft" ? -1 : 1);
    setCursor(times[Math.min(times.length - 1, Math.max(0, at))]!);
  };
  const cursorValue =
    near === -1
      ? null
      : series
          .map((s) => s.values[near])
          .filter((v): v is number => v !== null && v !== undefined)
          .map(format)
          .join(" · ");

  return (
    <figure
      role="group"
      aria-labelledby={titleId}
      aria-describedby={summaryId}
      tabIndex={0}
      data-chart={dataKey}
      onKeyDown={onKey}
      onFocus={() => times.length > 0 && cursor === null && setCursor(times.at(-1)!)}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setCursor(null);
      }}
      className="flex min-w-0 flex-col gap-1.5 rounded-md py-2"
    >
      <figcaption className="flex flex-wrap items-baseline gap-x-2">
        <span id={titleId} className="text-md font-semibold text-ink">
          {title}
        </span>
        {subtitle && <span className="text-xs text-ink-muted">{subtitle}</span>}
        {legend && (
          <span className="ml-auto flex items-center gap-3 text-xs text-ink-muted">
            {legend.map((l) => (
              <span key={l.label} className="flex items-center gap-1">
                <svg width="16" height="4" aria-hidden="true">
                  <line
                    x1="0"
                    y1="2"
                    x2="16"
                    y2="2"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeDasharray={l.dashed ? "3 2" : undefined}
                  />
                </svg>
                {l.label}
              </span>
            ))}
          </span>
        )}
      </figcaption>
      {!empty && (
        <p id={summaryId} className="num text-sm text-ink-muted">
          {summary}
        </p>
      )}
      <div className="flex gap-2">
        <div
          className="num flex w-10 shrink-0 flex-col justify-between py-0 text-right text-xs text-ink-faint"
          style={{ height: H }}
          aria-hidden="true"
        >
          <span>{format(max)}</span>
          <span>{format(0)}</span>
        </div>
        <div className="min-w-0 flex-1">
          <div
            className="relative border-b border-l border-rule"
            style={{ height: H }}
            onMouseMove={onMove}
            onMouseLeave={() => setCursor(null)}
          >
            <svg
              viewBox={`0 0 ${W} ${H}`}
              preserveAspectRatio="none"
              aria-hidden="true"
              focusable="false"
              className="absolute inset-0 h-full w-full overflow-visible text-ink"
            >
              {bands.map((b, i) => (
                <rect
                  key={i}
                  data-band
                  x={frac(b.from) * W}
                  y={0}
                  width={Math.max(2, (frac(b.to) - frac(b.from)) * W)}
                  height={H}
                  fill="currentColor"
                  fillOpacity={0.06}
                />
              ))}
              {threshold && (
                <line
                  data-threshold
                  x1={0}
                  x2={W}
                  y1={H - (threshold.value / max) * H}
                  y2={H - (threshold.value / max) * H}
                  stroke="var(--rule-strong)"
                  strokeWidth={1}
                  strokeDasharray="4 3"
                  vectorEffect="non-scaling-stroke"
                />
              )}
              {!empty &&
                series.map((s, i) => {
                  const line = pathOf(s.values, xs, max);
                  const area = i === 0 && !s.dashed && line ? areaOf(s.values, xs, max) : null;
                  return (
                    <g key={i}>
                      {area && (
                        <path d={area} fill="currentColor" fillOpacity={0.06} stroke="none" />
                      )}
                      <path
                        d={line}
                        fill="none"
                        stroke="currentColor"
                        strokeWidth={1.5}
                        strokeLinejoin="round"
                        strokeDasharray={s.dashed ? "4 3" : undefined}
                        vectorEffect="non-scaling-stroke"
                      />
                    </g>
                  );
                })}
            </svg>
            {/* L'etichetta di un episodio sta dalla parte della fascia dove la linea
                lascia più spazio (`bandLabelSide`): sopra una CPU bassa, sotto un
                disco al 92%. Verso l'interno del grafico vicino al bordo destro. */}
            {bands.map((b, i) =>
              b.label ? (
                <span
                  key={i}
                  data-band-label
                  data-side={labelSide(b)}
                  className={`num pointer-events-none absolute max-w-[60%] truncate rounded-sm bg-ground/85 px-1 text-xs text-ink-muted ${labelSide(b) === "top" ? "top-1" : "bottom-1"}`}
                  style={
                    frac(b.from) > 0.55
                      ? { right: `calc(${(1 - frac(b.to)) * 100}% + 4px)` }
                      : { left: `calc(${frac(b.from) * 100}% + 4px)` }
                  }
                >
                  {b.label}
                </span>
              ) : null,
            )}
            {threshold && (
              <span
                className="num pointer-events-none absolute right-1 rounded-sm bg-ground/85 px-1 text-xs text-ink-muted"
                style={
                  threshold.value / max > 0.8
                    ? { top: `calc(${(1 - threshold.value / max) * 100}% + 2px)` }
                    : { top: `calc(${(1 - threshold.value / max) * 100}% - 18px)` }
                }
              >
                {threshold.label}
              </span>
            )}
            {empty && (
              <p
                id={summaryId}
                className="absolute inset-0 grid place-items-center text-sm text-ink-muted"
              >
                {t("servers.charts.noData")}
              </p>
            )}
            {near !== -1 && !empty && (
              <>
                <span
                  aria-hidden="true"
                  className="pointer-events-none absolute top-0 bottom-0 w-px bg-ink/40"
                  style={{ left: `${frac(times[near]!) * 100}%` }}
                />
                <span
                  aria-live={byKeys ? "polite" : "off"}
                  data-cursor-label
                  className="num pointer-events-none absolute top-1 z-[1] rounded-sm bg-surface px-1 text-xs text-ink shadow-[0_0_0_1px_var(--rule)]"
                  style={
                    frac(times[near]!) > 0.7
                      ? { right: `calc(${(1 - frac(times[near]!)) * 100}% + 6px)` }
                      : { left: `calc(${frac(times[near]!) * 100}% + 6px)` }
                  }
                >
                  {t("servers.charts.cursor", {
                    time: (MULTI_DAY.has(range) ? [dayLocal, clockLocal] : [clockLocal])
                      .map((f) => f(new Date(times[near]!).toISOString(), i18n.language))
                      .join(" "),
                    value: cursorValue || t("servers.charts.gap"),
                  })}
                </span>
              </>
            )}
          </div>
          <div className="num mt-1 flex justify-between text-xs text-ink-faint" aria-hidden="true">
            {ticks.map((ts, i) => (
              <span key={i}>{i === ticks.length - 1 ? t("servers.charts.now") : tick(ts)}</span>
            ))}
          </div>
        </div>
      </div>
    </figure>
  );
}

function areaOf(values: (number | null)[], xs: number[], max: number): string | null {
  const pts = values.flatMap((v, i) =>
    v === null ? [] : [[xs[i]!, H - (Math.min(v, max) / max) * H] as const],
  );
  if (pts.length < 2) return null;
  return `M${pts[0]![0]},${H} ${pts.map(([x, y]) => `L${x.toFixed(1)},${y.toFixed(1)}`).join(" ")} L${pts.at(-1)![0]},${H} Z`;
}
