import { useLayoutEffect, useRef, useState } from "react";
import uPlot from "uplot";
import "uplot/dist/uPlot.min.css";

// Colori del tema terminal (vedi styles.css). Assi/griglia sono neutri; i colori
// delle serie li decide il chiamante (uno per metrica) via `series[].stroke`.
const AXIS_STROKE = "#5c6671"; // --color-fg-faint
const GRID_STROKE = "#1d242d"; // --color-line
// Larghezza di ripiego quando il container non ha ancora un layout (primo
// mount prima del ResizeObserver, e ambiente di test happy-dom dove
// clientWidth è 0): così il grafico si crea comunque e non resta a 0px.
const FALLBACK_WIDTH = 600;

export interface UPlotChartProps {
  /** Dati allineati uPlot: `[x, ...serie]`, x in secondi unix. */
  data: uPlot.AlignedData;
  /** Config delle serie; `series[0]` è l'asse x (tempo). */
  series: uPlot.Series[];
  height?: number;
  /** Formattatore dei tick dell'asse y (es. "12%", "3.4"). */
  yValues?: (value: number) => string;
  /** Range fisso dell'asse y (es. [0,100] per una percentuale). */
  yRange?: [number, number];
  ariaLabel?: string;
}

/**
 * Wrapper React su uPlot: crea l'istanza in un `useLayoutEffect` e la
 * distrugge sempre in cleanup (nessun leak al remount/unmount). La larghezza
 * segue il container via `ResizeObserver`; l'altezza è fissa. Ricrea il grafico
 * quando cambiano dati/serie/dimensioni — non c'è stato di zoom da preservare,
 * e il chiamante memoizza gli input così la ricreazione avviene solo a un vero
 * cambio (refetch al minuto), non a ogni render.
 *
 * Nei test happy-dom il modulo `uplot` è mockato (`vi.mock("uplot")`): qui si
 * verifica solo che mount/unmount non lancino.
 */
export function UPlotChart({
  data,
  series,
  height = 180,
  yValues,
  yRange,
  ariaLabel,
}: UPlotChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);

  // Traccia la larghezza del container. `ResizeObserver` può mancare (happy-dom):
  // in quel caso resta la misura iniziale e si cade sul FALLBACK_WIDTH.
  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    setWidth(el.clientWidth);
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const w = width > 0 ? width : FALLBACK_WIDTH;
    const axis = {
      stroke: AXIS_STROKE,
      grid: { stroke: GRID_STROKE, width: 1 },
      ticks: { stroke: GRID_STROKE, width: 1 },
    };
    const opts: uPlot.Options = {
      width: w,
      height,
      series,
      scales: { x: { time: true }, y: yRange ? { range: [yRange[0], yRange[1]] } : {} },
      axes: [
        axis,
        {
          ...axis,
          size: 60,
          values: yValues ? (_self, ticks) => ticks.map((v) => yValues(v)) : undefined,
        },
      ],
      legend: { show: false },
      cursor: { points: { size: 4 } },
      padding: [10, 8, 0, 4],
    };
    const plot = new uPlot(opts, data, el);
    return () => plot.destroy();
  }, [data, series, width, height, yValues, yRange]);

  return (
    <div ref={containerRef} className="w-full" style={{ height }} role="img" aria-label={ariaLabel} />
  );
}
