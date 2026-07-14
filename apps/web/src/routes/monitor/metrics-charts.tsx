import { useMemo, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type uPlot from "uplot";
import type { ServerCheck, ServerDetail, ServerMetricsResponse } from "../../lib/api";
import { UPlotChart, type UPlotRightAxis } from "./uplot-chart";

const GB = 1024 ** 3;
// Ampiezza di un bucket rollup 5m in secondi: i byte di rete del rollup sono
// somme sul bucket, quindi si dividono per 300 per ottenere i KB/s medi.
const ROLLUP_INTERVAL_SECONDS = 300;

// Palette dai token del tema terminal (styles.css): un colore per metrica.
const C_SIGNAL = "#f5a623"; // --color-signal (serie primaria)
const C_DIM = "#b97d1a"; // --color-signal-dim (banda max della primaria)
const C_OK = "#4ad295"; // --color-ok (rete in ingresso)
const C_MUTED = "#98a1ac"; // --color-fg-muted (serie secondaria: load/tx)

// Formattatori dei tick: COSTANTI di modulo, mai lambda inline — sono nelle
// dipendenze dell'effect di creazione del wrapper, una lambda per render
// ricreerebbe l'istanza uPlot a ogni render.
const FMT_PCT = (v: number): string => `${Math.round(v)}%`;
const FMT_GB = (v: number): string => v.toFixed(1);
const FMT_INT = (v: number): string => `${Math.round(v)}`;
const FMT_LOAD = (v: number): string => v.toFixed(1);

// Il load ha un dominio suo (non 0-100): vive su una scala uPlot dedicata con
// asse destro, così non resta schiacciato sull'asse delle percentuali. Stessa
// soluzione in raw e in 5m (load1m / load1mAvg).
const LOAD_SCALE = "load";
const LOAD_AXIS: UPlotRightAxis = { scale: LOAD_SCALE, values: FMT_LOAD };

/** ISO → secondi unix (dominio x di uPlot con `time: true`). */
function toSeconds(ts: string): number {
  return Math.floor(new Date(ts).getTime() / 1000);
}

function line(label: string, stroke: string, scale?: string): uPlot.Series {
  return { label, stroke, width: 1.5, points: { show: false }, ...(scale ? { scale } : {}) };
}

interface Panel {
  key: string;
  title: string;
  note?: string;
  data: uPlot.AlignedData;
  series: uPlot.Series[];
  yValues?: (v: number) => string;
  yRange?: [number, number];
  rightAxis?: UPlotRightAxis;
}

/**
 * I 4 pannelli uPlot del dettaglio server (CPU+load, RAM, disco, rete). La
 * response è un'unione discriminata su `resolution`: un solo `if` restringe i
 * punti alla forma giusta (raw = campioni fini; 5m = rollup con avg/max e somme
 * di rete). Le percentuali e i GB si calcolano client-side da used/total.
 *
 * Deviazioni accettate rispetto ai campi disponibili:
 * - swap NON plottata: il rollup 5m non ha campi swap, e un pannello presente
 *   solo in raw cambierebbe layout al cambio range — coerenza tra risoluzioni.
 * - rete raw: i delta si dividono per il `sampleIntervalSeconds` CORRENTE del
 *   server; per campioni storici raccolti con un intervallo diverso i KB/s
 *   sono approssimati (l'intervallo per-campione non è nella response).
 */
export function MetricsCharts({
  server,
  metrics,
}: {
  server: ServerDetail;
  metrics: ServerMetricsResponse;
}) {
  const { t } = useTranslation();

  const panels = useMemo<Panel[]>(() => {
    const x = metrics.points.map((p) => toSeconds(p.ts));

    if (metrics.resolution === "raw") {
      const pts = metrics.points;
      // Byte di rete = DELTA per campione: KB/s = byte / intervallo / 1024.
      // Raw usa l'intervallo di campionamento del server (vedi nota sopra).
      const interval = server.sampleIntervalSeconds;
      const memTotal = Math.max(1, ...pts.map((p) => p.memTotalBytes)) / GB;
      const diskTotal = Math.max(1, ...pts.map((p) => p.diskTotalBytes)) / GB;
      return [
        {
          key: "cpu",
          title: t("monitor:detail.charts.cpu"),
          data: [x, pts.map((p) => p.cpuPct), pts.map((p) => p.load1m)],
          series: [
            {},
            line(t("monitor:detail.charts.cpu"), C_SIGNAL),
            line(t("monitor:detail.charts.load"), C_MUTED, LOAD_SCALE),
          ],
          yValues: FMT_PCT,
          yRange: [0, 100],
          rightAxis: LOAD_AXIS,
        },
        {
          key: "ram",
          title: t("monitor:detail.charts.ram"),
          note: t("monitor:detail.charts.ramTotalNote", { total: memTotal.toFixed(1) }),
          data: [x, pts.map((p) => p.memUsedBytes / GB)],
          series: [{}, line(t("monitor:detail.charts.ramUsed"), C_SIGNAL)],
          yValues: FMT_GB,
          yRange: [0, memTotal],
        },
        {
          key: "disk",
          title: t("monitor:detail.charts.disk"),
          note: t("monitor:detail.charts.diskTotalNote", { total: diskTotal.toFixed(1) }),
          data: [x, pts.map((p) => p.diskUsedBytes / GB)],
          series: [{}, line(t("monitor:detail.charts.diskUsed"), C_SIGNAL)],
          yValues: FMT_GB,
          yRange: [0, diskTotal],
        },
        {
          key: "net",
          title: t("monitor:detail.charts.network"),
          data: [
            x,
            pts.map((p) => p.netRxBytes / interval / 1024),
            pts.map((p) => p.netTxBytes / interval / 1024),
          ],
          series: [
            {},
            line(t("monitor:detail.charts.rx"), C_OK),
            line(t("monitor:detail.charts.tx"), C_MUTED),
          ],
          yValues: FMT_INT,
        },
      ];
    }

    // resolution === "5m": rollup. CPU usa avg + max come banda e il load avg
    // sulla scala dedicata; la rete usa le somme sul bucket da 300s.
    const pts = metrics.points;
    const interval = ROLLUP_INTERVAL_SECONDS;
    const memTotal = Math.max(1, ...pts.map((p) => p.memTotalBytes)) / GB;
    const diskTotal = Math.max(1, ...pts.map((p) => p.diskTotalBytes)) / GB;
    return [
      {
        key: "cpu",
        title: t("monitor:detail.charts.cpu"),
        data: [
          x,
          pts.map((p) => p.cpuPctAvg),
          pts.map((p) => p.cpuPctMax),
          pts.map((p) => p.load1mAvg),
        ],
        series: [
          {},
          line(t("monitor:detail.charts.cpu"), C_SIGNAL),
          line(t("monitor:detail.charts.cpuMax"), C_DIM),
          line(t("monitor:detail.charts.load"), C_MUTED, LOAD_SCALE),
        ],
        yValues: FMT_PCT,
        yRange: [0, 100],
        rightAxis: LOAD_AXIS,
      },
      {
        key: "ram",
        title: t("monitor:detail.charts.ram"),
        note: t("monitor:detail.charts.ramTotalNote", { total: memTotal.toFixed(1) }),
        data: [x, pts.map((p) => p.memUsedBytesAvg / GB), pts.map((p) => p.memUsedBytesMax / GB)],
        series: [
          {},
          line(t("monitor:detail.charts.ramUsed"), C_SIGNAL),
          line(t("monitor:detail.charts.ramMax"), C_DIM),
        ],
        yValues: FMT_GB,
        yRange: [0, memTotal],
      },
      {
        key: "disk",
        title: t("monitor:detail.charts.disk"),
        note: t("monitor:detail.charts.diskTotalNote", { total: diskTotal.toFixed(1) }),
        data: [x, pts.map((p) => p.diskUsedBytesAvg / GB)],
        series: [{}, line(t("monitor:detail.charts.diskUsed"), C_SIGNAL)],
        yValues: FMT_GB,
        yRange: [0, diskTotal],
      },
      {
        key: "net",
        title: t("monitor:detail.charts.network"),
        data: [
          x,
          pts.map((p) => p.netRxBytesSum / interval / 1024),
          pts.map((p) => p.netTxBytesSum / interval / 1024),
        ],
        series: [
          {},
          line(t("monitor:detail.charts.rx"), C_OK),
          line(t("monitor:detail.charts.tx"), C_MUTED),
        ],
        yValues: FMT_INT,
      },
    ];
  }, [metrics, server.sampleIntervalSeconds, t]);

  const hasData = metrics.points.length > 0;

  return (
    <div className="grid gap-3 lg:grid-cols-2">
      {panels.map((panel) => (
        <ChartCard key={panel.key} title={panel.title} note={panel.note}>
          {hasData ? (
            <UPlotChart
              data={panel.data}
              series={panel.series}
              yValues={panel.yValues}
              yRange={panel.yRange}
              rightAxis={panel.rightAxis}
              ariaLabel={panel.title}
            />
          ) : (
            <NoData label={t("monitor:detail.noData")} />
          )}
        </ChartCard>
      ))}
    </div>
  );
}

/**
 * Pannello latenza di un check selezionato. Raw = `latencyMs` (una serie), 5m =
 * `latencyMsAvg`/`Max` (due serie). I `null` (campione senza latenza, es. check
 * giù) restano buchi nella linea. NON esiste altra metrica DB per-check
 * nell'endpoint: si mostra solo la latenza.
 */
export function CheckLatencyChart({
  metrics,
  check,
}: {
  metrics: ServerMetricsResponse;
  check: ServerCheck;
}) {
  const { t } = useTranslation();

  const panel = useMemo<{ data: uPlot.AlignedData; series: uPlot.Series[] } | null>(() => {
    // Il narrowing di `checkPoints` segue quello di `metrics` (unione
    // discriminata): la variabile locale va presa DENTRO ogni ramo.
    if (metrics.resolution === "raw") {
      const points = metrics.checkPoints;
      if (!points || points.length === 0) return null;
      return {
        data: [points.map((p) => toSeconds(p.ts)), points.map((p) => p.latencyMs)],
        series: [{}, line(t("monitor:detail.charts.latency"), C_SIGNAL)],
      };
    }
    const points = metrics.checkPoints;
    if (!points || points.length === 0) return null;
    return {
      data: [
        points.map((p) => toSeconds(p.ts)),
        points.map((p) => p.latencyMsAvg),
        points.map((p) => p.latencyMsMax),
      ],
      series: [
        {},
        line(t("monitor:detail.charts.latency"), C_SIGNAL),
        line(t("monitor:detail.charts.latencyMax"), C_MUTED),
      ],
    };
  }, [metrics, t]);

  return (
    <ChartCard title={t("monitor:detail.checks.latencyTitle", { name: check.name })}>
      {panel ? (
        <UPlotChart
          data={panel.data}
          series={panel.series}
          yValues={FMT_INT}
          ariaLabel={t("monitor:detail.checks.latencyTitle", { name: check.name })}
        />
      ) : (
        <NoData label={t("monitor:detail.noData")} />
      )}
    </ChartCard>
  );
}

function ChartCard({
  title,
  note,
  children,
}: {
  title: string;
  note?: string;
  children: ReactNode;
}) {
  return (
    <section className="rounded-sm border border-line bg-ink-900 p-3">
      <div className="mb-2 flex items-baseline justify-between gap-2">
        <h3 className="font-mono text-[11px] tracking-[0.14em] text-fg-muted uppercase">{title}</h3>
        {note && <span className="font-mono text-[10px] text-fg-faint">{note}</span>}
      </div>
      {children}
    </section>
  );
}

function NoData({ label }: { label: string }) {
  return (
    <div className="grid h-[180px] place-items-center">
      <span className="font-mono text-[11px] tracking-[0.12em] text-fg-faint uppercase">
        {label}
      </span>
    </div>
  );
}
