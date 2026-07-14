import { useLayoutEffect, useRef } from "react";
import uPlot from "uplot";
import "uplot/dist/uPlot.min.css";

// Colori del tema terminal (vedi styles.css). Assi/griglia sono neutri; i colori
// delle serie li decide il chiamante (uno per metrica) via `series[].stroke`.
const AXIS_STROKE = "#5c6671"; // --color-fg-faint
const GRID_STROKE = "#1d242d"; // --color-line
// Larghezza di ripiego quando il container non ha ancora un layout (creazione
// prima del primo resize, e ambiente di test happy-dom dove clientWidth è 0):
// così il grafico si crea comunque e il ResizeObserver lo corregge al volo.
const FALLBACK_WIDTH = 600;

/** Asse y secondario (destro) su una scala dedicata (es. load accanto a CPU%). */
export interface UPlotRightAxis {
  /** Chiave della scala uPlot; le serie che la usano dichiarano `scale` uguale. */
  scale: string;
  /** Formattatore dei tick dell'asse destro. */
  values?: (value: number) => string;
}

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
  /** Asse destro opzionale su scala dedicata (serie con `scale` corrispondente). */
  rightAxis?: UPlotRightAxis;
  ariaLabel?: string;
}

/**
 * Wrapper React su uPlot: crea l'istanza in un `useLayoutEffect` e la
 * distrugge sempre in cleanup (nessun leak al remount/unmount). Il resize NON
 * ricrea il grafico: un `ResizeObserver` separato chiama `plot.setSize()`
 * sull'istanza corrente. La ricreazione avviene solo quando cambiano dati/
 * serie/opzioni — il chiamante memoizza gli input così succede solo a un vero
 * cambio (refetch al minuto), non a ogni render. La legenda uPlot resta attiva
 * (default): label delle serie + valori al cursore, indispensabile nei pannelli
 * multi-serie; eredita font e colore dal container.
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
  rightAxis,
  ariaLabel,
}: UPlotChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const plotRef = useRef<uPlot | null>(null);

  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    // Larghezza letta direttamente qui (niente state → nessuna doppia
    // creazione al mount); un layout non ancora misurato cade sul fallback.
    const width = el.clientWidth > 0 ? el.clientWidth : FALLBACK_WIDTH;
    const axis = {
      stroke: AXIS_STROKE,
      grid: { stroke: GRID_STROKE, width: 1 },
      ticks: { stroke: GRID_STROKE, width: 1 },
    };
    const scales: uPlot.Scales = {
      x: { time: true },
      y: yRange ? { range: [yRange[0], yRange[1]] } : {},
    };
    const axes: uPlot.Axis[] = [
      axis,
      {
        ...axis,
        size: 60,
        values: yValues ? (_self, ticks) => ticks.map((v) => yValues(v)) : undefined,
      },
    ];
    if (rightAxis) {
      // Scala dedicata (auto-range) con asse sul lato destro; niente griglia
      // propria per non sovrapporla a quella dell'asse sinistro.
      scales[rightAxis.scale] = {};
      axes.push({
        ...axis,
        side: 1,
        scale: rightAxis.scale,
        size: 50,
        grid: { show: false },
        values: rightAxis.values
          ? (_self, ticks) => ticks.map((v) => rightAxis.values!(v))
          : undefined,
      });
    }
    const opts: uPlot.Options = {
      width,
      height,
      series,
      scales,
      axes,
      cursor: { points: { size: 4 } },
      padding: [10, 8, 0, 4],
    };
    const plot = new uPlot(opts, data, el);
    plotRef.current = plot;
    return () => {
      plot.destroy();
      plotRef.current = null;
    };
  }, [data, series, height, yValues, yRange, rightAxis]);

  // Resize: segue la larghezza del container con `setSize()` sull'istanza viva
  // (niente destroy/recreate). `ResizeObserver` può mancare (happy-dom): in quel
  // caso resta la larghezza di creazione.
  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      const width = el.clientWidth;
      if (width > 0) plotRef.current?.setSize({ width, height });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [height]);

  return (
    <div
      ref={containerRef}
      className="w-full font-mono text-[11px] text-fg-muted"
      role="img"
      aria-label={ariaLabel}
    />
  );
}
