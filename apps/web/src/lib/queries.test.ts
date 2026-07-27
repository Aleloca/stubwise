import { describe, expect, it } from "vitest";
import type { RepoGraph } from "./api";
import { graphKeys, repoGraphRefetchInterval } from "./queries";

/** Stato "grafo pronto e fermo": la base da cui derivare i casi vivi. */
function graph(overrides: Partial<RepoGraph> = {}): RepoGraph {
  return {
    enabled: true,
    status: "done",
    commitSha: "abc1234",
    nodeCount: 10,
    edgeCount: 20,
    communityCount: 3,
    labeled: true,
    generatedAt: "2026-07-27T10:00:00.000Z",
    setupPrUrl: null,
    error: null,
    jobPending: false,
    setupPrJobPending: false,
    setupPrError: null,
    ...overrides,
  };
}

describe("repoGraphRefetchInterval", () => {
  it("nessun dato in cache (primo fetch): niente polling", () => {
    expect(repoGraphRefetchInterval(undefined)).toBe(false);
  });

  it("grafo fermo (done/failed/none senza job): niente polling", () => {
    expect(repoGraphRefetchInterval(graph())).toBe(false);
    expect(repoGraphRefetchInterval(graph({ status: "failed", error: "boom" }))).toBe(false);
    expect(repoGraphRefetchInterval(graph({ status: "none", enabled: false }))).toBe(false);
  });

  it("build in coda o in corso: polling a 10s", () => {
    expect(repoGraphRefetchInterval(graph({ status: "queued" }))).toBe(10_000);
    expect(repoGraphRefetchInterval(graph({ status: "running" }))).toBe(10_000);
  });

  it("job accodato prima che la riga esista (status none + jobPending): polling", () => {
    expect(repoGraphRefetchInterval(graph({ status: "none", jobPending: true }))).toBe(10_000);
  });

  it("PR di setup in corso su un grafo done: polling comunque", () => {
    // La PR avanza senza toccare `status`: senza questo ramo la UI resterebbe
    // ferma su "apertura in corso" fino a un refresh manuale.
    expect(repoGraphRefetchInterval(graph({ setupPrJobPending: true }))).toBe(10_000);
  });
});

describe("graphKeys", () => {
  it("il report è figlio del dettaglio: invalidare il dettaglio li prende entrambi", () => {
    expect(graphKeys.report("r1").slice(0, graphKeys.detail("r1").length)).toEqual(
      graphKeys.detail("r1"),
    );
  });
});
