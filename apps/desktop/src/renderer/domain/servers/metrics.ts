import type { CheckSample, MetricPoint } from "../../data/model";
import { METRIC_POINTS_MAX } from "./limits";

type Numeric = Exclude<keyof MetricPoint, "ts">;
const FIELDS: readonly Numeric[] = [
  "cpuPct",
  "memPct",
  "diskPct",
  "load1m",
  "netRxBytes",
  "netTxBytes",
];

function average(window: MetricPoint[]): MetricPoint {
  const out = { ts: window[Math.floor(window.length / 2)]!.ts } as MetricPoint;
  for (const field of FIELDS) {
    out[field] = window.reduce((sum, p) => sum + p[field], 0) / window.length;
  }
  return out;
}

/**
 * Una serie ridotta a non più di `max` punti per il grafico: il primo e
 * l'ultimo restano quelli veri, i punti in mezzo diventano la media di
 * finestre consecutive (con l'ora del punto centrale della finestra).
 */
export function downsample(
  points: MetricPoint[],
  max = METRIC_POINTS_MAX,
): { points: MetricPoint[]; truncated: boolean } {
  if (points.length <= max) return { points, truncated: false };
  const middle = windows(points.slice(1, -1), Math.max(0, max - 2)).map(average);
  return { points: [points[0]!, ...middle, points.at(-1)!], truncated: true };
}

/** Le finestre consecutive in cui `downsample` divide i punti interni. */
function windows<T>(inner: T[], buckets: number): T[][] {
  const out: T[][] = [];
  for (let b = 0; b < buckets; b++) {
    const from = Math.floor((b * inner.length) / buckets);
    const to = Math.floor(((b + 1) * inner.length) / buckets);
    if (to > from) out.push(inner.slice(from, to));
  }
  return out;
}

/**
 * I campioni di un controllo ridotti come `downsample` (R-L1, il grafico
 * «Response time»): primo e ultimo veri, in mezzo una finestra per punto.
 * Una finestra con un solo campione giù è giù, così le fasce dei momenti
 * giù non spariscono nella media; la latenza è la media dei campioni su che
 * ne hanno una, `null` se nessuno (un controllo di processo, o tutta giù).
 */
export function downsampleSamples(
  samples: CheckSample[],
  max = METRIC_POINTS_MAX,
): { samples: CheckSample[]; truncated: boolean } {
  if (samples.length <= max) return { samples, truncated: false };
  const middle = windows(samples.slice(1, -1), Math.max(0, max - 2)).map((w): CheckSample => {
    const ts = w[Math.floor(w.length / 2)]!.ts;
    if (w.some((s) => s.status === "down")) return { ts, status: "down", latencyMs: null };
    const latencies = w.flatMap((s) => (s.latencyMs === null ? [] : [s.latencyMs]));
    const latencyMs = latencies.length
      ? latencies.reduce((sum, l) => sum + l, 0) / latencies.length
      : null;
    return { ts, status: "up", latencyMs };
  });
  return { samples: [samples[0]!, ...middle, samples.at(-1)!], truncated: true };
}
