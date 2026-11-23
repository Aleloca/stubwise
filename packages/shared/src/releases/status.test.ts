import { describe, expect, it } from "vitest";
import {
  countedReleaseRuns,
  NO_PIPELINE_AFTER_MIN,
  releaseStatusOf,
  sameCommit,
  type ReleaseRunLike,
  type ReleaseStatusInput,
} from "./status.js";

// Area 8, F1: lo stato di un rilascio DERIVATO, in un posto per prototipo,
// server e worker (era `domain/releases/releaseStatus.ts` del prototipo).

const SHA = "4be1f0c27a9d3e5b6c8f0a1d2e3b4c5d6e7f8091";
const MERGED = "2026-10-28T10:00:00Z";
const later = (min: number) => new Date(Date.parse(MERGED) + min * 60_000).toISOString();
const run = (over: Partial<ReleaseRunLike> = {}): ReleaseRunLike => ({
  name: "deploy",
  status: "success",
  startedAt: "2026-10-28T10:01:00Z",
  endedAt: "2026-10-28T10:05:00Z",
  ...over,
});
const input = (over: Partial<ReleaseStatusInput> = {}): ReleaseStatusInput => ({
  runs: [],
  mergedAt: MERGED,
  mergeSha: SHA,
  seenInProductionAt: null,
  now: later(5),
  pipeline: { mode: "auto" },
  production: { hasServers: true, server: { reportedSha: null, reportedAt: null } },
  ...over,
});

describe("sameCommit", () => {
  it("per prefisso di almeno 7 caratteri, maiuscole comprese", () => {
    expect(sameCommit(SHA, SHA.slice(0, 7).toUpperCase())).toBe(true);
    expect(sameCommit(SHA, SHA.slice(0, 6))).toBe(false);
    expect(sameCommit(SHA, null)).toBe(false);
  });
});

describe("releaseStatusOf — run lette", () => {
  it("una fallita → failed; una in corso → running; tutte riuscite → succeeded", () => {
    expect(
      releaseStatusOf(
        input({ runs: [run({ status: "failed" }), run({ status: "running", endedAt: null })] }),
      ).kind,
    ).toBe("failed");
    expect(
      releaseStatusOf(input({ runs: [run(), run({ status: "running", endedAt: null })] })).kind,
    ).toBe("running");
    expect(releaseStatusOf(input({ runs: [run({ endedAt: later(7) }), run()] }))).toEqual({
      kind: "succeeded",
      since: later(7),
    });
  });
  it("con la pipeline per nome contano solo le run nominate", () => {
    const runs = [run({ name: "lint", status: "failed" }), run()];
    expect(
      releaseStatusOf(input({ runs, pipeline: { mode: "named", names: ["deploy"] } })).kind,
    ).toBe("succeeded");
    expect(releaseStatusOf(input({ runs, pipeline: null })).kind).toBe("failed");
  });
});

describe("releaseStatusOf — run rilanciate (registro, A8 r.744)", () => {
  it("una run con lo stesso nome partita DOPO sostituisce quella di prima: rilanciata e verde → succeeded", () => {
    const failed = run({ status: "failed", startedAt: later(1), endedAt: later(3) });
    const rerun = run({ startedAt: later(10), endedAt: later(14) });
    expect(releaseStatusOf(input({ runs: [failed, rerun], now: later(15) }))).toEqual({ kind: "succeeded", since: later(14) });
    expect(releaseStatusOf(input({ runs: [failed, run({ status: "running", startedAt: later(10), endedAt: null })], now: later(15) })).kind).toBe("running");
    // Un nome diverso non sostituisce niente.
    expect(releaseStatusOf(input({ runs: [failed, run({ name: "lint", startedAt: later(10), endedAt: later(14) })], now: later(15) })).kind).toBe("failed");
  });

  it("revisione del lotto 2, I6: due job con lo stesso nome di workflow DIVERSI non si sostituiscono; nello stesso workflow il rilancio sì", () => {
    const failedA = run({ name: "test", group: "github:suite:1", status: "failed", startedAt: later(1), endedAt: later(3) });
    const okB = run({ name: "test", group: "github:suite:2", startedAt: later(10), endedAt: later(14) });
    expect(releaseStatusOf(input({ runs: [failedA, okB], now: later(15) })).kind).toBe("failed");
    const rerunA = run({ name: "test", group: "github:suite:1", startedAt: later(10), endedAt: later(14) });
    expect(releaseStatusOf(input({ runs: [failedA, rerunA], now: later(15) }))).toEqual({ kind: "succeeded", since: later(14) });
  });

  it("revisione 3bbe2ddc6..444b8b773, I-1 e I-2: un gruppo assente fa da jolly — una run salvata prima (null) la sostituisce un rilancio col gruppo; su Bitbucket (null) due key diverse col nome uguale: la più nuova sostituisce", () => {
    const legacyFailed = run({ name: "test", group: null, status: "failed", startedAt: later(1), endedAt: later(3) });
    const grouped = run({ name: "test", group: "github:suite:1", startedAt: later(10), endedAt: later(14) });
    expect(releaseStatusOf(input({ runs: [legacyFailed, grouped], now: later(15) })).kind).toBe("succeeded");
    const bbFailed = run({ name: "Pipeline", status: "failed", startedAt: later(1), endedAt: later(3) });
    const bbRerun = run({ name: "Pipeline", startedAt: later(10), endedAt: later(14) });
    expect(releaseStatusOf(input({ runs: [bbFailed, bbRerun], now: later(15) })).kind).toBe("succeeded");
  });

  it("revisione del lotto 2, I6: `countedReleaseRuns` dà le run che contano, quelle da cui si legge la run fallita", () => {
    const failedOld = run({ name: "test", group: "g1", status: "failed", startedAt: later(1), endedAt: later(3) });
    const rerun = run({ name: "test", group: "g1", startedAt: later(10), endedAt: later(14) });
    const lint = run({ name: "lint", group: "g2", status: "failed", startedAt: later(2), endedAt: later(4) });
    expect(countedReleaseRuns([failedOld, rerun, lint], { mode: "auto" }).filter((r) => r.status === "failed").map((r) => r.name)).toEqual(["lint"]);
    expect(countedReleaseRuns([failedOld, rerun, lint], { mode: "named", names: ["test"] }).map((r) => r.name)).toEqual(["test"]);
  });
});

describe("releaseStatusOf — lettura illeggibile (`unknown`, mai «riuscito»)", () => {
  it("senza altri fatti lo stato è `unknown`, anche oltre la soglia", () => {
    expect(releaseStatusOf(input({ runs: "unknown" }))).toEqual({ kind: "unknown", since: null });
    expect(releaseStatusOf(input({ runs: "unknown", now: later(600) })).kind).toBe("unknown");
  });
  it("non diventa «non ancora in produzione» né «senza pipeline»", () => {
    const s = releaseStatusOf(input({ runs: "unknown", now: later(60), production: null }));
    expect(s.kind).toBe("unknown");
  });
  it("un fatto già osservato resta: visto in produzione, o il commit sul server", () => {
    expect(releaseStatusOf(input({ runs: "unknown", seenInProductionAt: later(40) }))).toEqual({
      kind: "in_production",
      since: later(40),
    });
    const onServer = input({
      runs: "unknown",
      production: {
        hasServers: true,
        server: { reportedSha: SHA.slice(0, 9), reportedAt: later(50) },
      },
    });
    expect(releaseStatusOf(onServer)).toEqual({ kind: "in_production", since: later(50) });
  });
});

describe("releaseStatusOf — senza run", () => {
  it(`entro ${NO_PIPELINE_AFTER_MIN} minuti → running, oltre → non ancora in produzione`, () => {
    expect(releaseStatusOf(input({ now: later(29) }))).toEqual({ kind: "running", since: MERGED });
    expect(releaseStatusOf(input({ now: later(30) }))).toEqual({
      kind: "not_in_production",
      since: MERGED,
    });
  });
  it("il server della repository riporta il commit → in_production", () => {
    const c = input({
      now: later(60),
      production: { hasServers: true, server: { reportedSha: SHA, reportedAt: later(50) } },
    });
    expect(releaseStatusOf(c)).toEqual({ kind: "in_production", since: later(50) });
  });
  it("senza produzione, senza server, o senza server per la repository → unavailable col perché", () => {
    expect(releaseStatusOf(input({ now: later(60), production: null }))).toEqual({
      kind: "unavailable",
      since: null,
      reason: "no_production_env",
    });
    expect(
      releaseStatusOf(input({ now: later(60), production: { hasServers: false, server: null } }))
        .reason,
    ).toBe("no_server");
    expect(
      releaseStatusOf(input({ now: later(60), production: { hasServers: true, server: null } }))
        .reason,
    ).toBe("no_server_for_repository");
  });
});
