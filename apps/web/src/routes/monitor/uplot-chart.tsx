import { useLayoutEffect, useMemo, useRef } from "react";
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
 * sull'istanza corrente.
 *
 * I NUOVI DATI (refetch: nuovo campione) NON ricreano il grafico — vengono
 * applicati in-place con `plot.setData()`. La ricreazione avviene solo a un
 * cambio STRUTTURALE (serie/scala/range/altezza), riassunto da `structKey`.
 * Senza questa separazione il chiamante — che ricalcola `data` E `series` a
 * ogni refetch — farebbe distruggere/ricreare l'istanza a ogni ping, e il
 * canvas svuotato per un frame apparirebbe come uno sfarfallio.
 *
 * La legenda uPlot resta attiva (default): label delle serie + valori al
 * cursore, indispensabile nei pannelli multi-serie; eredita font e colore dal
 * container.
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
  // Dati correnti letti alla creazione senza entrare nelle deps dell'effetto:
  // gli aggiornamenti passano da `setData` (effetto dedicato sotto).
  const dataRef = useRef(data);
  dataRef.current = data;

  // Firma della sola STRUTTURA del grafico (serie, range, asse destro, altezza,
  // formattatore). Cambia a un vero cambio di configurazione, non quando arriva
  // un nuovo campione (i valori vivono in `data`, fuori da qui). Le funzioni si
  // normalizzano perché contano per identità di struttura, non di riferimento.
  const structKey = useMemo(
    () =>
      JSON.stringify({ series, yRange, rightAxis, height, yValues }, (_k, v) =>
        typeof v === "function" ? "fn" : v,
      ),
    [series, yRange, rightAxis, height, yValues],
  );

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
    const plot = new uPlot(opts, dataRef.current, el);
    plotRef.current = plot;
    return () => {
      plot.destroy();
      plotRef.current = null;
    };
    // Ricrea solo a cambio strutturale: `structKey` riassume series/yRange/
    // rightAxis/height/yValues; i dati correnti si leggono da `dataRef` e gli
    // aggiornamenti passano dall'effetto `setData` sotto.
  }, [structKey]);

  // Nuovi dati (refetch) applicati in-place: nessuna ricreazione, niente
  // sfarfallio. Un cambio strutturale ricrea già l'istanza sopra con i dati
  // aggiornati (via dataRef), quindi questo setData è al più ridondante.
  useLayoutEffect(() => {
    plotRef.current?.setData(data);
  }, [data]);

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
