import { useMemo, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type uPlot from "uplot";
import type { ServerCheck, ServerDetail, ServerMetricsResponse } from "../../lib/api";
import { UPlotChart } from "./uplot-chart";

const GB = 1024 ** 3;
// Ampiezza di un bucket rollup 5m in secondi: i byte di rete del rollup sono
// somme sul bucket, quindi si dividono per 300 per ottenere i KB/s medi.
const ROLLUP_INTERVAL_SECONDS = 300;

// Palette dai token del tema terminal (styles.css): un colore per metrica.
const C_SIGNAL = "#f5a623"; // --color-signal (serie primaria)
const C_OK = "#4ad295"; // --color-ok (rete in ingresso)
const C_MUTED = "#98a1ac"; // --color-fg-muted (serie secondaria: load/max/tx)

/** ISO → secondi unix (dominio x di uPlot con `time: true`). */
function toSeconds(ts: string): number {
  return Math.floor(new Date(ts).getTime() / 1000);
}

function line(label: string, stroke: string): uPlot.Series {
  return { label, stroke, width: 1.5, points: { show: false } };
}

interface Panel {
  key: string;
  title: string;
  note?: string;
  data: uPlot.AlignedData;
  series: uPlot.Series[];
  yValues?: (v: number) => string;
  yRange?: [number, number];
}

/**
 * I 4 pannelli uPlot del dettaglio server (CPU, RAM, disco, rete). La response
 * è un'unione discriminata su `resolution`: un solo `if` restringe i punti alla
 * forma giusta (raw = campioni fini; 5m = rollup con avg/max e somme di rete).
 * Le percentuali e i GB si calcolano client-side da used/total.
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
    const pct = (v: number) => `${Math.round(v)}%`;
    const gb = (v: number) => v.toFixed(1);
    const kbs = (v: number) => `${Math.round(v)}`;
    const x = metrics.points.map((p) => toSeconds(p.ts));

    if (metrics.resolution === "raw") {
      const pts = metrics.points;
      // Byte di rete = DELTA per campione: KB/s = byte / intervallo / 1024.
      // Raw usa l'intervallo di campionamento del server.
      const interval = server.sampleIntervalSeconds;
      const memTotal = Math.max(1, ...pts.map((p) => p.memTotalBytes)) / GB;
      const diskTotal = Math.max(1, ...pts.map((p) => p.diskTotalBytes)) / GB;
      return [
        {
          key: "cpu",
          title: t("monitor:detail.charts.cpu"),
          data: [x, pts.map((p) => p.cpuPct), pts.map((p) => p.load1m)],
          series: [{}, line(t("monitor:detail.charts.cpu"), C_SIGNAL), line(t("monitor:detail.charts.load"), C_MUTED)],
          yValues: pct,
          yRange: [0, 100],
        },
        {
          key: "ram",
          title: t("monitor:detail.charts.ram"),
          note: t("monitor:detail.charts.ramTotalNote", { total: memTotal.toFixed(1) }),
          data: [x, pts.map((p) => p.memUsedBytes / GB)],
          series: [{}, line(t("monitor:detail.charts.ramUsed"), C_SIGNAL)],
          yValues: gb,
          yRange: [0, memTotal],
        },
        {
          key: "disk",
          title: t("monitor:detail.charts.disk"),
          note: t("monitor:detail.charts.diskTotalNote", { total: diskTotal.toFixed(1) }),
          data: [x, pts.map((p) => p.diskUsedBytes / GB)],
          series: [{}, line(t("monitor:detail.charts.diskUsed"), C_SIGNAL)],
          yValues: gb,
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
          series: [{}, line(t("monitor:detail.charts.rx"), C_OK), line(t("monitor:detail.charts.tx"), C_MUTED)],
          yValues: kbs,
        },
      ];
    }

    // resolution === "5m": rollup. CPU/RAM usano gli avg + il max come banda
    // (serie secondaria); la rete usa le somme sul bucket da 300s.
    const pts = metrics.points;
    const interval = ROLLUP_INTERVAL_SECONDS;
    const memTotal = Math.max(1, ...pts.map((p) => p.memTotalBytes)) / GB;
    const diskTotal = Math.max(1, ...pts.map((p) => p.diskTotalBytes)) / GB;
    return [
      {
        key: "cpu",
        title: t("monitor:detail.charts.cpu"),
        data: [x, pts.map((p) => p.cpuPctAvg), pts.map((p) => p.cpuPctMax)],
        series: [{}, line(t("monitor:detail.charts.cpu"), C_SIGNAL), line(t("monitor:detail.charts.cpuMax"), C_MUTED)],
        yValues: pct,
        yRange: [0, 100],
      },
      {
        key: "ram",
        title: t("monitor:detail.charts.ram"),
        note: t("monitor:detail.charts.ramTotalNote", { total: memTotal.toFixed(1) }),
        data: [x, pts.map((p) => p.memUsedBytesAvg / GB), pts.map((p) => p.memUsedBytesMax / GB)],
        series: [{}, line(t("monitor:detail.charts.ramUsed"), C_SIGNAL), line(t("monitor:detail.charts.ramMax"), C_MUTED)],
        yValues: gb,
        yRange: [0, memTotal],
      },
      {
        key: "disk",
        title: t("monitor:detail.charts.disk"),
        note: t("monitor:detail.charts.diskTotalNote", { total: diskTotal.toFixed(1) }),
        data: [x, pts.map((p) => p.diskUsedBytesAvg / GB)],
        series: [{}, line(t("monitor:detail.charts.diskUsed"), C_SIGNAL)],
        yValues: gb,
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
        series: [{}, line(t("monitor:detail.charts.rx"), C_OK), line(t("monitor:detail.charts.tx"), C_MUTED)],
        yValues: kbs,
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
    const points = metrics.checkPoints;
    if (!points || points.length === 0) return null;
    const x = points.map((p) => toSeconds(p.ts));
    if (metrics.resolution === "raw") {
      return {
        data: [x, metrics.checkPoints!.map((p) => p.latencyMs)],
        series: [{}, line(t("monitor:detail.charts.latency"), C_SIGNAL)],
      };
    }
    const rollup = metrics.checkPoints!;
    return {
      data: [x, rollup.map((p) => p.latencyMsAvg), rollup.map((p) => p.latencyMsMax)],
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
          yValues={(v) => `${Math.round(v)}`}
          ariaLabel={t("monitor:detail.checks.latencyTitle", { name: check.name })}
        />
      ) : (
        <NoData label={t("monitor:detail.noData")} />
      )}
    </ChartCard>
  );
}

function ChartCard({ title, note, children }: { title: string; note?: string; children: ReactNode }) {
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
      <span className="font-mono text-[11px] tracking-[0.12em] text-fg-faint uppercase">{label}</span>
    </div>
  );
}
