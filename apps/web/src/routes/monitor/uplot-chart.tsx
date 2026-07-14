import { useLayoutEffect, useMemo, useRef, useState } from "react";
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

/** Orario locale HH:MM:SS dal timestamp unix (x della legenda). */
function formatTime(seconds: number): string {
  const d = new Date(seconds * 1000);
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** Valore di serie formattato; `null`/gap → `--` (come faceva la legenda uPlot). */
function formatValue(value: number | null | undefined, fmt?: (v: number) => string): string {
  if (value == null || !Number.isFinite(value)) return "--";
  return fmt ? fmt(value) : String(value);
}

/**
 * Ultimo valore FINITO di una serie a partire da `fromIdx` andando all'indietro
 * (`null` a riposo → walk-back). Serve alla legenda a cursore inattivo: una serie
 * con coda di `null` — es. latenza di un check giù o bucket vuoto — deve mostrare
 * l'ultima misura reale, non `--`. `null` se la serie è tutta vuota.
 */
function lastFiniteValue(
  values: (number | null)[] | undefined,
  fromIdx: number,
): number | null {
  if (!values) return null;
  for (let i = Math.min(fromIdx, values.length - 1); i >= 0; i--) {
    const v = values[i];
    if (v != null && Number.isFinite(v)) return v;
  }
  return null;
}

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
 * La legenda uPlot NATIVA è disattivata (`legend.show=false`): la sua riga
 * resta a `--` quando il cursore è fuori dal grafico. Al suo posto renderizziamo
 * una legenda React sotto il canvas che mostra, per ogni serie, il valore
 * all'indice del cursore durante l'hover e l'ULTIMO campione a riposo (mouse
 * fuori) — mai `--`. L'indice del cursore arriva dall'hook uPlot `setCursor`
 * (`u.cursor.idx`, `null` a riposo); i valori si leggono dai `data` (React
 * ri-renderizza da sé a ogni nuovo campione, aggiornando l'ultimo valore).
 *
 * Nei test happy-dom il modulo `uplot` è mockato (`vi.mock("uplot")`): qui si
 * verifica solo che mount/unmount non lancino e la legenda a riposo/hover.
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
  // Indice sotto il cursore: `null` a riposo (mouse fuori) → la legenda cade
  // sull'ultimo campione. Aggiornato dall'hook `setCursor` di uPlot.
  const [cursorIdx, setCursorIdx] = useState<number | null>(null);
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
      // Legenda nativa spenta: la sostituisce quella React sotto (mostra sempre
      // un valore, anche a riposo). `setCursor` fa da ponte: `u.cursor.idx` è
      // `null` quando il cursore esce → la legenda ripiega sull'ultimo campione.
      legend: { show: false },
      hooks: { setCursor: [(u) => setCursorIdx(u.cursor.idx ?? null)] },
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

  // Regime della legenda: `hoverIdx` è l'indice sotto il cursore (o `null` a
  // riposo). Il timestamp segue quell'indice durante l'hover e cade sull'ultimo
  // punto a riposo. Ricalcolato a ogni render → segue sia i nuovi `data` sia il
  // cursore.
  const xs = data[0] ?? [];
  const lastIdx = xs.length - 1;
  const hoverIdx =
    cursorIdx != null && cursorIdx >= 0 && cursorIdx < xs.length ? cursorIdx : null;
  const xIdx = hoverIdx ?? lastIdx;
  const xValue = xIdx >= 0 ? (xs[xIdx] as number | undefined) : undefined;

  return (
    <div className="w-full">
      <div ref={containerRef} className="w-full" role="img" aria-label={ariaLabel} />
      {lastIdx >= 0 && (
        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 font-mono text-[11px] text-fg-muted">
          <span className="text-fg-faint tabular-nums">
            {xValue != null ? formatTime(xValue) : "--"}
          </span>
          {series.slice(1).map((s, i) => {
            // `series.slice(1)` salta la serie x: la colonna dati corrispondente
            // è `data[i + 1]`.
            const values = data[i + 1] as (number | null)[] | undefined;
            // Hover: il valore ESATTO sotto il cursore (null → "--": l'utente sta
            // guardando quel punto). Riposo: l'ultimo valore REALE della serie
            // (walk-back), non il valore a `lastIdx` che può essere `null`.
            const value =
              hoverIdx != null ? values?.[hoverIdx] : lastFiniteValue(values, lastIdx);
            // Il load vive sulla scala destra → formattatore suo; fallback a
            // `yValues` se l'asse destro non ne ha uno.
            const fmt =
              (rightAxis && s.scale === rightAxis.scale ? rightAxis.values : yValues) ??
              yValues;
            const stroke = typeof s.stroke === "string" ? s.stroke : undefined;
            // `label` uPlot può essere un HTMLElement: nella legenda usiamo solo
            // le label stringa (le nostre serie lo sono sempre).
            const label = typeof s.label === "string" ? s.label : undefined;
            return (
              <span key={label ?? i} className="inline-flex items-center gap-1">
                <span
                  className="inline-block h-2 w-2 shrink-0 rounded-[1px]"
                  style={{ backgroundColor: stroke }}
                  aria-hidden
                />
                {label && <span className="text-fg-faint">{label}</span>}
                <span className="text-fg-default tabular-nums">
                  {formatValue(value, fmt)}
                </span>
              </span>
            );
          })}
        </div>
      )}
    </div>
  );
}
