import { describe, expect, it } from "vitest";
import type { AIJob, AIJobStatus, RepoGraph } from "./api";
import {
  graphKeys,
  inboxKeys,
  repoGraphRefetchInterval,
  ticketJobsRefetchInterval,
} from "./queries";

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

/** Job "concluso" minimale: la base da cui derivare i casi vivi. */
function job(status: AIJobStatus): AIJob {
  return {
    id: `job-${status}`,
    ticketId: "t1",
    status,
    log: "",
    prUrl: null,
    error: null,
    createdAt: "2026-08-31T10:00:00.000Z",
    startedAt: null,
    finishedAt: null,
    providerLabel: null,
    providerKind: null,
  };
}

describe("ticketJobsRefetchInterval", () => {
  it("nessun dato in cache (primo fetch) o ticket senza job: niente polling", () => {
    expect(ticketJobsRefetchInterval(undefined)).toBe(false);
    expect(ticketJobsRefetchInterval([])).toBe(false);
  });

  it("ultimo job vivo (queued/triaging/fixing): polling a 5s", () => {
    expect(ticketJobsRefetchInterval([job("queued")])).toBe(5_000);
    expect(ticketJobsRefetchInterval([job("triaging")])).toBe(5_000);
    expect(ticketJobsRefetchInterval([job("fixing")])).toBe(5_000);
  });

  it("ultimo job concluso: niente polling", () => {
    expect(ticketJobsRefetchInterval([job("pr_opened")])).toBe(false);
    expect(ticketJobsRefetchInterval([job("failed")])).toBe(false);
    expect(ticketJobsRefetchInterval([job("pr_merged")])).toBe(false);
  });

  it("stati d'attesa di una PERSONA: polling lento a 20s (a sbloccarli è un ALTRO)", () => {
    // Chi guarda può non essere chi decide (l'operatore aspetta un maintainer):
    // senza polling resterebbe sullo stato d'attesa anche dopo l'approvazione.
    expect(ticketJobsRefetchInterval([job("held")])).toBe(20_000);
    expect(ticketJobsRefetchInterval([job("awaiting_plan_approval")])).toBe(20_000);
  });

  it("guarda solo il PRIMO elemento: la lista è dal più recente al più vecchio", () => {
    // Un tentativo vecchio ancora "fixing" in coda alla lista non deve tenere
    // acceso il polling se l'ultimo job è concluso.
    expect(ticketJobsRefetchInterval([job("pr_opened"), job("fixing")])).toBe(false);
    expect(ticketJobsRefetchInterval([job("fixing"), job("failed")])).toBe(5_000);
  });
});

describe("inboxKeys", () => {
  it("ogni combinazione di filtri è una lista a sé, sotto lists()", () => {
    expect(inboxKeys.list({ status: "open" })).not.toEqual(inboxKeys.list({ status: "handled" }));
    const list = inboxKeys.list({ status: "open" });
    expect(list.slice(0, inboxKeys.lists().length)).toEqual(inboxKeys.lists());
  });

  it("il contatore è una chiave distinta dalle liste", () => {
    expect(inboxKeys.unread()).not.toEqual(inboxKeys.lists());
  });
});
