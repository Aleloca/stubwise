import type { MetricPoint } from "../../data/model";
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
  const inner = points.slice(1, -1);
  const buckets = Math.max(0, max - 2);
  const middle: MetricPoint[] = [];
  for (let b = 0; b < buckets; b++) {
    const from = Math.floor((b * inner.length) / buckets);
    const to = Math.floor(((b + 1) * inner.length) / buckets);
    if (to > from) middle.push(average(inner.slice(from, to)));
  }
  return { points: [points[0]!, ...middle, points.at(-1)!], truncated: true };
}
