import { describe, expect, it } from "vitest";
import type { MetricPoint, ProjectEnvironment } from "../../data/model";
import {
  ANALYSIS_MAX_COST_USD,
  ANALYSIS_MAX_MINUTES,
  COMMAND_OUTPUT_MAX_LINES,
  METRIC_POINTS_MAX,
  RECOVERED_SHOWN_HOURS,
} from "./limits";
import { downsample } from "./metrics";
import { alertProjectsOf, analysisProjectOf } from "./projects";

// Limiti, metriche e progetti; salute, accessi, comandi e correzione hanno
// ciascuno il suo file di test accanto al sorgente.

describe("limiti", () => {
  it("sono quelli del piano", () => {
    expect(ANALYSIS_MAX_MINUTES).toBe(20);
    expect(ANALYSIS_MAX_COST_USD).toBe(2);
    expect(COMMAND_OUTPUT_MAX_LINES).toBe(40);
    expect(RECOVERED_SHOWN_HOURS).toBe(24);
    expect(METRIC_POINTS_MAX).toBe(300);
  });
});

const point = (i: number): MetricPoint => ({
  ts: new Date(Date.parse("2026-10-22T00:00:00Z") + i * 30_000).toISOString(),
  cpuPct: i % 2 === 0 ? 40 : 60,
  memPct: 50,
  diskPct: 80,
  load1m: 1,
  netRxBytes: 1000,
  netTxBytes: 2000,
});

describe("downsample", () => {
  it("20 160 punti → 300, troncato, primo e ultimo conservati", () => {
    const points = Array.from({ length: 20_160 }, (_, i) => point(i));
    const out = downsample(points);
    expect(out.truncated).toBe(true);
    expect(out.points).toHaveLength(METRIC_POINTS_MAX);
    expect(out.points[0]).toEqual(points[0]);
    expect(out.points.at(-1)).toEqual(points.at(-1));
    // Media per finestra: i valori costanti restano quelli, l'ordine è crescente.
    expect(out.points.every((p) => p.memPct === 50 && p.netTxBytes === 2000)).toBe(true);
    const ts = out.points.map((p) => Date.parse(p.ts));
    expect(ts.every((t, i) => i === 0 || t > ts[i - 1]!)).toBe(true);
    // La CPU alterna 40 e 60: la media di ogni finestra sta intorno a 50.
    const middle = out.points.slice(1, -1);
    expect(middle.every((p) => p.cpuPct > 49 && p.cpuPct < 51)).toBe(true);
  });

  it("sotto il massimo non tocca niente", () => {
    const points = Array.from({ length: 120 }, (_, i) => point(i));
    expect(downsample(points)).toEqual({ points, truncated: false });
    expect(downsample([])).toEqual({ points: [], truncated: false });
  });
});

const env = (
  id: string,
  projectId: string,
  kind: ProjectEnvironment["kind"],
  codes: string[],
): ProjectEnvironment => ({
  id,
  projectId,
  name: id,
  kind,
  url: null,
  servers: codes.map((serverCode, i) => ({
    repositoryId: i === 0 ? null : `repo-${i}`,
    serverCode,
    reportedSha: null,
    reportedAt: null,
  })),
});

describe("alertProjectsOf e analysisProjectOf", () => {
  const envs = [
    env("e1", "p-a", "staging", ["SRV-1"]),
    env("e2", "p-b", "production", ["SRV-2", "SRV-1"]),
    env("e3", "p-c", "production", ["SRV-1"]),
    env("e4", "p-d", "production", ["SRV-3"]),
  ];

  it("solo le produzioni che usano il server, una volta per progetto", () => {
    expect(alertProjectsOf("SRV-1", envs)).toEqual(["p-b", "p-c"]);
    expect(alertProjectsOf("SRV-9", envs)).toEqual([]);
  });

  it("due produzioni: il principale se c'è, altrimenti il primo", () => {
    expect(analysisProjectOf("SRV-1", envs, "p-c")).toBe("p-c");
    expect(analysisProjectOf("SRV-1", envs, "p-a")).toBe("p-b");
    expect(analysisProjectOf("SRV-1", envs, null)).toBe("p-b");
  });

  it("solo staging → null (niente analisi)", () => {
    const staging = [env("e1", "p-a", "staging", ["SRV-5"])];
    expect(alertProjectsOf("SRV-5", staging)).toEqual([]);
    expect(analysisProjectOf("SRV-5", staging, "p-a")).toBeNull();
  });
});
