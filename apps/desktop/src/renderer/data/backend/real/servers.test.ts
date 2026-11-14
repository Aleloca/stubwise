import { ApiError } from "@stubwise/api-client";
import {
  serverDetailSchema,
  serverMetricsResponseSchema,
  serverViewSchema,
} from "@stubwise/shared";
import { describe, expect, it } from "vitest";
import { createRealServers, type ServersApi } from "./servers";

// Area 8, F4a: i Server della build app sulle rotte vere, con le firme del
// prototipo. Salute, ambienti, `orphan` li dice il server; un server senza
// codice non si mostra (la sua pagina si apre per codice); nulla della F4b.

const NOW = "2026-11-14T12:00:00.000Z";
const S1 = "11111111-1111-4111-8111-111111111111";
const S2 = "22222222-2222-4222-8222-222222222222";
const PRJ = "33333333-3333-4333-8333-333333333333";
const ENV = "44444444-4444-4444-8444-444444444444";
const REPO_A = "55555555-5555-4555-8555-555555555555";
const REPO_B = "66666666-6666-4666-8666-666666666666";
const EP = "77777777-7777-4777-8777-777777777777";
const CHK = "88888888-8888-4888-8888-888888888888";

/** Una vista come la manda il server F4a (passata dal parse vero, coi default). */
const view = (over: Record<string, unknown> = {}) =>
  serverViewSchema.parse({
    id: S1,
    name: "acq-prod-01",
    hostname: "acq-prod-01",
    status: "online",
    sampleIntervalSeconds: 30,
    agentVersion: "1.2.0",
    alertThresholds: { cpuPct: 95, memPct: 90, diskPct: 90, sustainedMinutes: 5 },
    lastSeenAt: NOW,
    createdAt: "2026-10-01T09:00:00.000Z",
    projects: [{ id: PRJ, name: "Acquedotto" }],
    checksUp: 1,
    checksDown: 0,
    recentCpu: [10, 20],
    code: "SRV-1",
    health: {
      health: "trouble",
      since: "2026-11-14T11:00:00.000Z",
      reasons: [{ kind: "cpu", valuePct: 97, thresholdPct: 95 }],
    },
    environments: [
      {
        projectId: PRJ,
        projectCode: "ACQ",
        environmentId: ENV,
        name: "Production",
        kind: "production",
        repositoryId: REPO_A,
        repositoryName: "acq-web",
      },
      {
        projectId: PRJ,
        projectCode: "ACQ",
        environmentId: ENV,
        name: "Production",
        kind: "production",
        repositoryId: REPO_B,
        repositoryName: "acq-api",
      },
    ],
    ...over,
  });

const detail = (over: Record<string, unknown> = {}) =>
  serverDetailSchema.parse({
    ...view(),
    services: [
      {
        source: "docker",
        name: "web",
        state: "running",
        cpuPct: 3,
        memBytes: 100,
        restarts: null,
        image: "acme/web:1",
      },
      {
        source: "pm2_fallback",
        name: "worker",
        state: "online",
        cpuPct: null,
        memBytes: null,
        restarts: 2,
      },
    ],
    disks: [{ mount: "/", usedBytes: 10, totalBytes: 100 }],
    metricsAt: NOW,
    checks: [
      {
        id: CHK,
        serverId: S1,
        type: "http",
        name: "Portal",
        target: "https://acq.test/health",
        hasDsn: false,
        intervalSeconds: 60,
        enabled: true,
        lastStatus: "up",
        lastCheckedAt: NOW,
        lastLatencyMs: 120,
        lastError: null,
        downSince: null,
        createdAt: NOW,
      },
    ],
    episodes: [
      {
        id: EP,
        severity: "trouble",
        reasons: [{ kind: "cpu", valuePct: 97, thresholdPct: 95 }],
        startedAt: "2026-11-14T11:00:00.000Z",
        recoveredAt: null,
      },
    ],
    productionProjects: [{ id: PRJ, code: "ACQ", name: "Acquedotto" }],
    canManage: true,
    ...over,
  });

function fakeApi(over: Partial<ServersApi> = {}): ServersApi {
  return {
    list: async () => [view()],
    byCode: async () => detail(),
    metrics: async () =>
      serverMetricsResponseSchema.parse({ resolution: "raw", truncated: false, points: [] }),
    ...over,
  };
}

describe("i Server dal server (area 8, F4a)", () => {
  it("la riga: salute del server, un ambiente per ambiente, niente della F4b", async () => {
    const [row] = await createRealServers(fakeApi(), () => NOW).listProjectServers(PRJ);
    expect(row).toEqual({
      code: "SRV-1",
      name: "acq-prod-01",
      hostname: "acq-prod-01",
      status: "online",
      health: {
        health: "trouble",
        since: "2026-11-14T11:00:00.000Z",
        reasons: [{ kind: "cpu", valuePct: 97, thresholdPct: 95 }],
      },
      work: "none",
      workTaskCode: null,
      access: "not_linked",
      environments: [{ projectCode: "ACQ", name: "Production", kind: "production" }],
      primaryProjectCode: null,
      analysisProject: null,
      recentCpu: [10, 20],
    });
  });

  it("un server di prima della F4a: senza codice non si mostra; senza salute la si deriva con la regola di shared", async () => {
    const old = serverViewSchema.parse({
      id: S2,
      name: "old",
      hostname: null,
      status: "offline",
      sampleIntervalSeconds: 30,
      agentVersion: null,
      alertThresholds: {},
      lastSeenAt: "2026-11-14T10:00:00.000Z",
      createdAt: NOW,
      projects: [],
      checksUp: 0,
      checksDown: 0,
      recentCpu: [],
    });
    const servers = createRealServers(
      fakeApi({ list: async () => [old, { ...old, code: "SRV-2" }] }),
      () => NOW,
    );
    const rows = await servers.listProjectServers(PRJ);
    expect(rows.map((r) => r.code)).toEqual(["SRV-2"]);
    expect(rows[0]!.health).toEqual({
      health: "down",
      since: "2026-11-14T10:00:00.000Z",
      reasons: [{ kind: "agent_silent", since: "2026-11-14T10:00:00.000Z" }],
    });
  });

  it("tutti i server: in ordine di numero, i progetti per codice dagli ambienti, orfano e solo archiviati", async () => {
    const api = fakeApi({
      list: async () => [
        view({ id: S2, code: "SRV-10", environments: [], projects: [], orphan: true }),
        view({ inArchivedOnly: false }),
      ],
    });
    const rows = await createRealServers(api, () => NOW).listAllServers();
    expect(rows.map((r) => [r.code, r.projects, r.orphan])).toEqual([
      ["SRV-1", [{ code: "ACQ", name: "Acquedotto" }], false],
      ["SRV-10", [], true],
    ]);
  });

  it("il dettaglio: servizi (PM2 dal file è PM2), dischi, controlli senza DSN, episodi senza analisi, canManage del server", async () => {
    const d = await createRealServers(fakeApi(), () => NOW).getServer("SRV-1");
    expect(d.services.map((x) => [x.name, x.source])).toEqual([
      ["web", "docker"],
      ["worker", "pm2"],
    ]);
    expect(d.checks).toEqual([
      {
        id: CHK,
        serverCode: "SRV-1",
        name: "Portal",
        type: "http",
        target: "https://acq.test/health",
        intervalSeconds: 60,
        enabled: true,
        status: "up",
        latencyMs: 120,
        lastError: null,
      },
    ]);
    expect(d.episodes).toEqual([
      expect.objectContaining({
        id: EP,
        serverCode: "SRV-1",
        severity: "trouble",
        recoveredAt: null,
        analysis: null,
        taskCode: null,
      }),
    ]);
    expect(d.thresholds).toEqual({ cpuPct: 95, memPct: 90, diskPct: 90, sustainedMinutes: 5 });
    expect(d.productionProjects).toEqual([{ id: PRJ, code: "ACQ", name: "Acquedotto" }]);
    expect(d.canManage).toBe(true);
    expect(d.access.state).toBe("not_linked");
  });

  it("un server invisibile o inesistente è `not_found` (R-G5)", async () => {
    const api = fakeApi({
      byCode: async () => {
        throw new ApiError(404, "not_found", "not_found");
      },
    });
    await expect(createRealServers(api, () => NOW).getServer("SRV-9")).rejects.toThrow("not_found");
  });

  it("le metriche: l'intervallo all'indietro da adesso, le percentuali dai byte, grezze o aggregate", async () => {
    const asked: unknown[] = [];
    const api = fakeApi({
      metrics: async (id, range) => {
        asked.push([id, range]);
        return serverMetricsResponseSchema.parse({
          resolution: "1h",
          truncated: false,
          points: [
            {
              ts: "2026-11-01T00:00:00.000Z",
              cpuPct: 40,
              load1m: 1,
              memUsedBytes: 50,
              memTotalBytes: 200,
              swapUsedBytes: 0,
              diskUsedBytes: 30,
              diskTotalBytes: 100,
              netRxBytes: 5,
              netTxBytes: 6,
            },
            {
              ts: "2026-11-01T01:00:00.000Z",
              cpuPctAvg: 20,
              cpuPctMax: 90,
              load1mAvg: 0.5,
              load1mMax: 2,
              memUsedBytesAvg: 100,
              memUsedBytesMax: 150,
              memTotalBytes: 200,
              diskUsedBytesAvg: 40,
              diskUsedBytesMax: 45,
              diskTotalBytes: 100,
              netRxBytesSum: 7,
              netTxBytesSum: 8,
            },
          ],
          checkPoints: [
            { ts: "2026-11-01T00:00:00.000Z", status: "up", latencyMs: 100 },
            {
              ts: "2026-11-01T01:00:00.000Z",
              upCount: 50,
              downCount: 2,
              latencyMsAvg: 120.4,
              latencyMsMax: 900,
            },
          ],
        });
      },
    });
    const servers = createRealServers(api, () => NOW);
    await servers.getServer("SRV-1");
    const m = await servers.getServerMetrics("SRV-1", "30d", CHK);
    expect(asked).toEqual([[S1, { from: "2026-10-15T12:00:00.000Z", to: NOW, checkId: CHK }]]);
    expect(m.points).toEqual([
      {
        ts: "2026-11-01T00:00:00.000Z",
        cpuPct: 40,
        memPct: 25,
        diskPct: 30,
        load1m: 1,
        netRxBytes: 5,
        netTxBytes: 6,
      },
      {
        ts: "2026-11-01T01:00:00.000Z",
        cpuPct: 20,
        memPct: 50,
        diskPct: 40,
        load1m: 0.5,
        netRxBytes: 7,
        netTxBytes: 8,
      },
    ]);
    // Un'ora per punto: la nota sotto i grafici lo dice.
    expect(m.averagedSeconds).toBe(3_600);
    expect(m.check!.samples).toEqual([
      { ts: "2026-11-01T00:00:00.000Z", status: "up", latencyMs: 100 },
      // Giù almeno una volta nel passo: giù.
      { ts: "2026-11-01T01:00:00.000Z", status: "down", latencyMs: 120 },
    ]);
  });

  it("le metriche grezze non dicono una media; senza controllo nessun campione", async () => {
    const m = await createRealServers(fakeApi(), () => NOW).getServerMetrics("SRV-1", "24h");
    expect(m.averagedSeconds).toBeNull();
    expect(m.check).toBeNull();
  });
});
