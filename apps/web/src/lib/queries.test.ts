import { describe, expect, it } from "vitest";
import type { AIJob, AIJobStatus, Plugin, PluginRegistry, RepoGraph } from "./api";
import {
  graphKeys,
  inboxKeys,
  pluginsRefetchInterval,
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
    requestedByUserId: null,
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
    // La domanda dell'agente aspetta una PERSONA come il gate del piano: chi
    // guarda può non essere chi risponde, e senza polling resterebbe fermo
    // sulla domanda anche dopo che un collega l'ha già chiusa.
    expect(ticketJobsRefetchInterval([job("awaiting_input")])).toBe(20_000);
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

/** Plugin del registro fermo e materializzato: la base dei casi con job vivi. */
function plugin(overrides: Partial<Plugin> = {}): Plugin {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    slug: "superpowers",
    name: "superpowers",
    sourceUrl: "https://github.com/obra/superpowers",
    sourceSubdir: null,
    ref: "v4.0.3",
    resolvedSha: "a".repeat(40),
    status: "ready",
    inventory: null,
    error: null,
    smokeStatus: "passed",
    smokeError: null,
    pendingJobKind: null,
    materializedAt: "2026-09-01T10:00:00.000Z",
    createdAt: "2026-09-01T09:00:00.000Z",
    updatedAt: "2026-09-01T10:00:00.000Z",
    ...overrides,
  };
}

function registry(plugins: Plugin[]): PluginRegistry {
  return { plugins, recommendations: {} };
}

describe("pluginsRefetchInterval", () => {
  it("nessun dato in cache (primo fetch) o registro vuoto: niente polling", () => {
    expect(pluginsRefetchInterval(undefined)).toBe(false);
    expect(pluginsRefetchInterval(registry([]))).toBe(false);
  });

  it("registro fermo (ready/failed senza job): niente polling", () => {
    expect(pluginsRefetchInterval(registry([plugin()]))).toBe(false);
    expect(
      pluginsRefetchInterval(registry([plugin({ status: "failed", error: "fetch KO" })])),
    ).toBe(false);
  });

  it("job in volo su un plugin: polling a 2s", () => {
    expect(pluginsRefetchInterval(registry([plugin({ pendingJobKind: "materialize" })]))).toBe(
      2_000,
    );
    expect(pluginsRefetchInterval(registry([plugin({ pendingJobKind: "smoke" })]))).toBe(2_000);
  });

  it("appena registrato (status none) con il job ancora da claimare: polling comunque", () => {
    // È la finestra che una condizione su `status` sbaglierebbe: il plugin resta
    // `none` finché il worker non claima, e senza polling sembrerebbe fermo.
    expect(
      pluginsRefetchInterval(
        registry([
          plugin({
            status: "none",
            resolvedSha: null,
            smokeStatus: "idle",
            materializedAt: null,
            pendingJobKind: "materialize",
          }),
        ]),
      ),
    ).toBe(2_000);
  });

  it("aggiornamento accodato su un plugin ancora ready: polling comunque", () => {
    // Dopo il 202 di /update il plugin resta `ready` fino al claim: l'altra
    // finestra che una condizione su `status` mancherebbe.
    expect(
      pluginsRefetchInterval(
        registry([plugin({ status: "ready", pendingJobKind: "materialize" })]),
      ),
    ).toBe(2_000);
  });

  it("basta UN plugin con un job in volo perché tutto il registro polli", () => {
    expect(
      pluginsRefetchInterval(
        registry([
          plugin(),
          plugin({ id: "22222222-2222-4222-8222-222222222222", pendingJobKind: "smoke" }),
        ]),
      ),
    ).toBe(2_000);
  });
});
