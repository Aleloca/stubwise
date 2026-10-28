import { describe, expect, it } from "vitest";
import type { CiRun, ProjectEnvironment, Release } from "../../data/model";
import { NO_PIPELINE_AFTER_MIN, releaseStatus, sameCommit } from "./releaseStatus";

const SHA = "4be1f0c27a9d3e5b6c8f0a1d2e3b4c5d6e7f8091";
const MERGED = "2026-10-28T10:00:00Z";

const run = (over: Partial<CiRun>): CiRun => ({
  id: "run-x",
  name: "deploy",
  status: "success",
  url: "https://ci.example/run",
  failedStep: null,
  log: null,
  startedAt: "2026-10-28T10:01:00Z",
  endedAt: "2026-10-28T10:05:00Z",
  ...over,
});

const release = (over: Partial<Release> = {}): Release => ({
  id: "rel-x",
  code: "AUD-V1",
  projectId: "prj-aud",
  repositoryId: "repo-aud",
  pr: { repo: "audin/audin-app", number: 1 },
  title: "x",
  mergeSha: SHA,
  mergedAt: MERGED,
  mergedById: null,
  mergedGitName: "x",
  viaStubwise: true,
  runs: [],
  seenInProductionAt: null,
  fixTaskId: null,
  ...over,
});

const production = (over: Partial<ProjectEnvironment> = {}): ProjectEnvironment => ({
  id: "env-prod",
  projectId: "prj-aud",
  name: "Production",
  kind: "production",
  url: null,
  serverCode: "SRV-1",
  reportedSha: null,
  reportedAt: null,
  ...over,
});

const later = (min: number) => new Date(Date.parse(MERGED) + min * 60_000).toISOString();
const ctx = (over: Partial<Parameters<typeof releaseStatus>[1]> = {}) => ({
  now: later(5),
  production: production(),
  pipeline: { mode: "auto" } as const,
  ...over,
});

describe("sameCommit (forma di release.ts)", () => {
  it("combacia per prefisso, maiuscole comprese", () => {
    expect(sameCommit(SHA, SHA.slice(0, 7))).toBe(true);
    expect(sameCommit(SHA.toUpperCase(), SHA.slice(0, 12))).toBe(true);
  });
  it("sotto i 7 caratteri o con uno assente non combacia", () => {
    expect(sameCommit(SHA, SHA.slice(0, 6))).toBe(false);
    expect(sameCommit(SHA, null)).toBe(false);
    expect(sameCommit("", "")).toBe(false);
  });
  it("prefissi diversi non combaciano", () => {
    expect(sameCommit(SHA, "0a2c4e6b8d0f")).toBe(false);
  });
});

describe("releaseStatus — con run", () => {
  it("una fallita e una in corso → failed", () => {
    const r = release({
      runs: [
        run({ id: "a", status: "running", endedAt: null }),
        run({ id: "b", status: "failed", endedAt: "2026-10-28T10:04:00Z" }),
      ],
    });
    expect(releaseStatus(r, ctx())).toEqual({ kind: "failed", since: "2026-10-28T10:04:00Z" });
  });
  it("una in corso e le altre riuscite → running", () => {
    const r = release({
      runs: [run({ id: "a" }), run({ id: "b", status: "running", endedAt: null })],
    });
    expect(releaseStatus(r, ctx()).kind).toBe("running");
  });
  it("tutte riuscite → succeeded, dall'ultima fine", () => {
    const r = release({
      runs: [run({ id: "a", endedAt: "2026-10-28T10:07:00Z" }), run({ id: "b" })],
    });
    expect(releaseStatus(r, ctx())).toEqual({ kind: "succeeded", since: "2026-10-28T10:07:00Z" });
  });
  it("con pipeline per nome contano solo le run nominate", () => {
    const r = release({
      runs: [run({ id: "a", name: "lint", status: "failed" }), run({ id: "b", name: "deploy" })],
    });
    expect(releaseStatus(r, ctx({ pipeline: { mode: "named", names: ["deploy"] } })).kind).toBe(
      "succeeded",
    );
    expect(releaseStatus(r, ctx({ pipeline: { mode: "auto" } })).kind).toBe("failed");
    // Senza impostazione: automatica.
    expect(releaseStatus(r, ctx({ pipeline: undefined })).kind).toBe("failed");
  });
  it("le run lette contano anche oltre la soglia", () => {
    const r = release({ runs: [run({ status: "running", endedAt: null })] });
    expect(releaseStatus(r, ctx({ now: later(120) })).kind).toBe("running");
  });
});

describe("releaseStatus — senza run", () => {
  it(`entro ${NO_PIPELINE_AFTER_MIN} minuti dal merge → running`, () => {
    expect(NO_PIPELINE_AFTER_MIN).toBe(30);
    expect(releaseStatus(release(), ctx({ now: later(29) }))).toEqual({
      kind: "running",
      since: MERGED,
    });
  });
  it("oltre la soglia → senza pipeline: non ancora in produzione", () => {
    expect(releaseStatus(release(), ctx({ now: later(30) }))).toEqual({
      kind: "not_in_production",
      since: MERGED,
    });
  });
  it("run solo con nomi non scelti = nessuna run", () => {
    const r = release({ runs: [run({ name: "lint", status: "failed" })] });
    const c = ctx({ now: later(45), pipeline: { mode: "named", names: ["deploy"] } });
    expect(releaseStatus(r, c).kind).toBe("not_in_production");
  });
  it("commit comparso in produzione → in_production con l'ora", () => {
    const c = ctx({
      now: later(60),
      production: production({ reportedSha: SHA.slice(0, 7), reportedAt: later(50) }),
    });
    expect(releaseStatus(release({ seenInProductionAt: later(40) }), c)).toEqual({
      kind: "in_production",
      since: later(40),
    });
    // Senza l'ora salvata sul rilascio: quella del campione dell'agente.
    expect(releaseStatus(release(), c)).toEqual({ kind: "in_production", since: later(50) });
  });
  it("sha in maiuscolo combacia, di 6 caratteri no", () => {
    const upper = ctx({
      now: later(60),
      production: production({ reportedSha: SHA.toUpperCase(), reportedAt: later(50) }),
    });
    expect(releaseStatus(release(), upper).kind).toBe("in_production");
    const short = ctx({
      now: later(60),
      production: production({ reportedSha: SHA.slice(0, 6), reportedAt: later(50) }),
    });
    expect(releaseStatus(release(), short).kind).toBe("not_in_production");
  });
  it("ambiente di produzione senza server → unavailable/no_server", () => {
    const c = ctx({ now: later(60), production: production({ serverCode: null }) });
    expect(releaseStatus(release(), c)).toEqual({
      kind: "unavailable",
      since: null,
      reason: "no_server",
    });
  });
  it("nessun ambiente di produzione → unavailable/no_production_env", () => {
    const c = ctx({ now: later(60), production: null });
    expect(releaseStatus(release(), c)).toEqual({
      kind: "unavailable",
      since: null,
      reason: "no_production_env",
    });
  });
});
