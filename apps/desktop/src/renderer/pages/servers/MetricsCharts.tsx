import { useState } from "react";
import { useTranslation } from "react-i18next";
import { now } from "../../data/dates";
import { useServerMetrics } from "../../data/queries";
import type { MetricRange, ServerDetail } from "../../data/servers";
import type { CheckSample, MetricPoint, ServerCheck } from "../../data/types";
import { smallSecondary } from "../task/parts";
import { bytes, clockLocal, count, dayLocal } from "./format";
import { Chart, MULTI_DAY, stats, type Band } from "./Chart";
import { CloseGlyph } from "./glyphs";
import { Part } from "./Part";

// I grafici di un server (shape servers.md §3, «Charts»): cinque grafici
// piccoli (CPU, memoria, disco, carico, rete) e, con un controllo
// selezionato, il suo tempo di risposta a tutta larghezza sopra (R-L1).
// SVG in linea, nessuna libreria. Ogni grafico ha il suo riassunto in
// parole (anche il testo accessibile); la soglia è una linea tratteggiata,
// gli episodi una fascia su tutti i grafici; il cursore è condiviso (al
// passaggio, o con ←/→ col fuoco sul grafico). Dal 9b anche 30d e 90d
// (shape admin-instance.md, «Dettaglio»): lì ogni punto è una media, e la
// riga sopra i grafici dice di quanto tempo (lo calcola il livello dati
// dall'intervallo); il picco si dice per giorno, non per un'ora che la media
// non dimostra.

export const RANGES: readonly MetricRange[] = ["1h", "24h", "7d", "30d", "90d"];

/** Gli intervalli in cui un punto è la media di ore: il picco si dice per giorno. */
const BY_DAY: ReadonlySet<MetricRange> = new Set(["30d", "90d"]);

/** «Each point averages about 2 hours.»: la durata di un punto, arrotondata. */
function averagesLine(seconds: number, t: ReturnType<typeof useTranslation>["t"]): string {
  const hours = Math.round(seconds / 3600);
  return hours >= 1
    ? t("servers.charts.averagesHours", { count: hours })
    : t("servers.charts.averagesMinutes", { count: Math.max(1, Math.round(seconds / 60)) });
}

const RANGE_MS: Record<MetricRange, number> = {
  "1h": 3_600_000,
  "24h": 24 * 3_600_000,
  "7d": 7 * 24 * 3_600_000,
  "30d": 30 * 24 * 3_600_000,
  "90d": 90 * 24 * 3_600_000,
};

/** Le fasce dei momenti in cui un controllo era giù: campioni giù consecutivi. */
function downBands(samples: CheckSample[]): Band[] {
  const out: Band[] = [];
  samples.forEach((s, i) => {
    if (s.status !== "down") return;
    const start = Date.parse(s.ts);
    const end = Date.parse(samples[i + 1]?.ts ?? s.ts);
    const last = out.at(-1);
    if (last && last.to >= start) last.to = end;
    else out.push({ from: start, to: end });
  });
  return out;
}

const pct = (v: number) => `${Math.round(v)}%`;

/** Il passo tondo più vicino sopra `v` (1–2–5 × 10ⁿ): 610 → 1000, 180 → 200. */
export function niceCeil(v: number): number {
  if (!(v > 0)) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  return ([1, 2, 5, 10].find((m) => m * p >= v) ?? 10) * p;
}

export function MetricsCharts({
  server,
  range,
  setRange,
  check,
  clearCheck,
}: {
  server: ServerDetail;
  range: MetricRange;
  setRange: (r: MetricRange) => void;
  check: ServerCheck | null;
  clearCheck: () => void;
}) {
  const { t, i18n } = useTranslation();
  const lang = i18n.language;
  const metrics = useServerMetrics(server.code, range, check?.id);
  const [cursor, setCursor] = useState<number | null>(null);
  const to = Date.parse(now());
  const from = to - RANGE_MS[range];
  const at = (ts: number) =>
    MULTI_DAY.has(range)
      ? `${dayLocal(new Date(ts).toISOString(), lang)} ${clockLocal(new Date(ts).toISOString(), lang)}`
      : clockLocal(new Date(ts).toISOString(), lang);

  // Gli episodi nell'intervallo: una fascia su tutti i grafici, «Memory · 14:02–16:10».
  const bands: Band[] = server.episodes
    .map((e) => ({
      e,
      start: Date.parse(e.startedAt),
      end: e.recoveredAt ? Date.parse(e.recoveredAt) : to,
    }))
    .filter(({ start, end }) => end >= from && start <= to)
    .map(({ e, start, end }) => ({
      from: Math.max(start, from),
      to: Math.min(end, to),
      label: t("servers.charts.episode", {
        reason: t(`servers.reasonShort.${e.reasons[0]?.kind ?? "agent_silent"}`),
        from: at(start),
        to: !e.recoveredAt
          ? t("servers.charts.now")
          : new Date(start).toDateString() === new Date(end).toDateString()
            ? clockLocal(new Date(end).toISOString(), lang)
            : at(end),
      }),
    }));

  const header = (
    <div className="flex flex-wrap items-center gap-2">
      {check && (
        <button
          type="button"
          className={`${smallSecondary} gap-1.5`}
          aria-label={t("servers.charts.deselect", { name: check.name })}
          onClick={clearCheck}
        >
          {check.name}
          <CloseGlyph />
        </button>
      )}
      {/* A 1024 il gruppo va a capo se non ci sta (shape admin-instance.md §6). */}
      <div
        role="group"
        aria-label={t("servers.charts.rangeLabel")}
        className="inline-flex flex-wrap rounded-md border border-rule-strong p-0.5"
      >
        {RANGES.map((r, i) => (
          <button
            key={r}
            type="button"
            aria-pressed={r === range}
            aria-keyshortcuts={String(i + 1)}
            onClick={() => setRange(r)}
            className="num h-6 rounded-[4px] px-2.5 text-sm font-medium text-ink-muted transition-colors duration-[var(--duration-fast)] ease-out hover:text-ink aria-pressed:bg-ink/10 aria-pressed:text-ink"
          >
            {r}
          </button>
        ))}
      </div>
    </div>
  );

  let body;
  if (metrics.isError) {
    body = (
      <div role="alert" className="flex items-center gap-3 border-t border-rule py-3 pl-3">
        <p className="text-md text-ink">{t("servers.errors.charts")}</p>
        <button type="button" className={smallSecondary} onClick={() => void metrics.refetch()}>
          {t("taskUi.states.retry")}
        </button>
      </div>
    );
  } else if (!metrics.data) {
    body = (
      <div aria-busy="true" className="skeleton-breathe grid gap-6 @min-[1100px]:grid-cols-2">
        <span role="status" className="sr-only">
          {t("taskUi.states.loading")}
        </span>
        {[0, 1, 2, 3, 4].map((i) => (
          <span key={i} className="h-[170px] rounded-md bg-ink/6" />
        ))}
      </div>
    );
  } else {
    const points: MetricPoint[] = metrics.data.points;
    const times = points.map((p) => Date.parse(p.ts));
    const th = server.thresholds;
    const byDay = BY_DAY.has(range);
    const day = (ts: number) => dayLocal(new Date(ts).toISOString(), lang);
    const summaryOf = (values: number[], format: (v: number) => string) => {
      const s = stats(values, times);
      if (!s) return t("servers.charts.noData");
      return byDay
        ? t("servers.charts.summaryDay", { avg: format(s.avg), peak: format(s.peak), day: day(s.at) })
        : t("servers.charts.summary", { avg: format(s.avg), peak: format(s.peak), time: at(s.at) });
    };
    const pctChart = (
      key: "cpu" | "memory" | "disk",
      field: "cpuPct" | "memPct" | "diskPct",
      limit: number | null,
    ) => {
      const values = points.map((p) => p[field]);
      return (
        <Chart
          key={key}
          dataKey={key}
          title={t(`servers.charts.${key}`)}
          subtitle={limit === null ? t("servers.charts.noAlert") : undefined}
          summary={summaryOf(values, pct)}
          series={[{ values }]}
          times={times}
          from={from}
          to={to}
          max={100}
          format={pct}
          threshold={
            limit === null
              ? null
              : { value: limit, label: t("servers.charts.alertAt", { value: limit }) }
          }
          bands={bands}
          cursor={cursor}
          setCursor={setCursor}
          range={range}
        />
      );
    };
    const load = points.map((p) => p.load1m);
    const rx = points.map((p) => p.netRxBytes);
    const tx = points.map((p) => p.netTxBytes);
    const netMax = Math.max(1024, ...rx, ...tx) * 1.1;
    const fmtBytes = (v: number) => bytes(v, lang);
    const netIn = stats(rx, times);
    const netOut = stats(tx, times);
    const samples = metrics.data.check?.samples ?? [];
    const latency = samples.map((s) => s.latencyMs);
    const lat = stats(
      latency,
      samples.map((s) => Date.parse(s.ts)),
    );
    const latMax = niceCeil(
      Math.max(50, ...latency.filter((v): v is number => v !== null)) * 1.15,
    );
    const ms = (v: number) => t("servers.checks.latency", { n: Math.round(v) });

    const averaged = metrics.data.averagedSeconds;
    body = (
      <div
        className={`flex flex-col gap-4 transition-opacity duration-150 ease-out ${metrics.isPlaceholderData ? "opacity-60" : ""}`}
      >
        {averaged !== null && (
          <p data-averages className="-mb-1 text-xs text-ink-muted">
            {averagesLine(averaged, t)}
          </p>
        )}
        {check && (
          <Chart
            dataKey="response"
            title={t("servers.charts.responseTime", { name: check.name })}
            summary={
              lat
                ? byDay
                  ? t("servers.charts.summaryLatencyDay", {
                      avg: ms(lat.avg),
                      peak: ms(lat.peak),
                      day: day(lat.at),
                    })
                  : t("servers.charts.summaryLatency", {
                      avg: ms(lat.avg),
                      peak: ms(lat.peak),
                      time: at(lat.at),
                    })
                : samples.length > 0
                  ? t("servers.charts.noLatency")
                  : t("servers.charts.noData")
            }
            series={[{ values: latency }]}
            times={samples.map((s) => Date.parse(s.ts))}
            from={from}
            to={to}
            max={latMax}
            format={ms}
            bands={downBands(samples).map((b) => ({ ...b, label: t("servers.charts.checkDown") }))}
            cursor={cursor}
            setCursor={setCursor}
            range={range}
          />
        )}
        {check && metrics.data.check?.truncated && (
          <p className="-mt-2 text-xs text-ink-faint">
            {t("servers.charts.reducedCheck", {
              points: count(samples.length, lang),
              samples: count(metrics.data.check.sampleCount ?? samples.length, lang),
            })}
          </p>
        )}
        <div className="grid gap-x-8 gap-y-4 @min-[1100px]:grid-cols-2">
          {pctChart("cpu", "cpuPct", th.cpuPct)}
          {pctChart("memory", "memPct", th.memPct)}
          {pctChart("disk", "diskPct", th.diskPct)}
          <Chart
            dataKey="load"
            title={t("servers.charts.load")}
            summary={summaryOf(load, (v) => v.toFixed(2))}
            series={[{ values: load }]}
            times={times}
            from={from}
            to={to}
            max={Math.max(1, Math.ceil(Math.max(0, ...load)))}
            format={(v) => (Number.isInteger(v) ? String(v) : v.toFixed(2))}
            bands={bands}
            cursor={cursor}
            setCursor={setCursor}
            range={range}
          />
          <Chart
            dataKey="network"
            title={t("servers.charts.network")}
            legend={[
              { label: t("servers.charts.in"), dashed: false },
              { label: t("servers.charts.out"), dashed: true },
            ]}
            summary={
              netIn && netOut
                ? t("servers.charts.summaryNet", {
                    inAvg: fmtBytes(netIn.avg),
                    inPeak: fmtBytes(netIn.peak),
                    outAvg: fmtBytes(netOut.avg),
                    outPeak: fmtBytes(netOut.peak),
                  })
                : t("servers.charts.noData")
            }
            series={[{ values: rx }, { values: tx, dashed: true }]}
            times={times}
            from={from}
            to={to}
            max={netMax}
            format={fmtBytes}
            bands={bands}
            cursor={cursor}
            setCursor={setCursor}
            range={range}
          />
        </div>
        {/* A 30d e 90d lo dice già la riga sopra i grafici. */}
        {metrics.data.truncated && averaged === null && (
          <p className="text-xs text-ink-faint">
            {t("servers.charts.reduced", {
              points: count(points.length, lang),
              samples: count(metrics.data.sampleCount, lang),
            })}
          </p>
        )}
      </div>
    );
  }

  return (
    <Part id="charts" title={t("servers.index.charts")} action={header}>
      {body}
    </Part>
  );
}
