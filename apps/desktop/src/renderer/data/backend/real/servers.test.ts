import { ApiError } from "@stubwise/api-client";
import {
  serverAnalysisViewSchema,
  serverCheckViewSchema,
  serverSshAccessViewSchema,
  serverDetailSchema,
  serverMetricsResponseSchema,
  serverViewSchema,
  serverWithKeySchema,
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

const USER = "99999999-9999-4999-8999-999999999999";
const AN = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SESSION = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const analysis = (over: Record<string, unknown> = {}) =>
  serverAnalysisViewSchema.parse({
    id: AN,
    serverId: S1,
    episodeId: null,
    status: "running",
    startedAt: "2026-11-14T11:30:00.000Z",
    ...over,
  });

const ssh = (over: Record<string, unknown> = {}) =>
  serverSshAccessViewSchema.parse({ status: "none", canManage: true, ...over });
const KEYS = {
  publicKey: "ssh-ed25519 AAAAC3Nz stubwise-read",
  fingerprint: "SHA256:abc",
  authorizedKeysLine: "restrict ssh-ed25519 AAAAC3Nz stubwise-read",
  setupCommand: "sudo useradd --create-home stubwise-read && echo …",
};
const VERIFIED = {
  verifiedAt: NOW,
  verifyResult: { groups: ["stubwise-read", "adm"], sudo: false, docker: false, journal: true, ok: true },
};

const calls: unknown[][] = [];

function fakeApi(over: Partial<ServersApi> = {}): ServersApi {
  calls.length = 0;
  const log =
    <T>(name: string, out: T) =>
    async (...args: unknown[]) => {
      calls.push([name, ...args]);
      return out;
    };
  const withKey = serverWithKeySchema.parse({
    ...view({ code: "SRV-3" }),
    key: "sk_new",
    ingestUrl: null,
  });
  const check = serverCheckViewSchema.parse({
    id: CHK,
    serverId: S1,
    type: "tcp",
    name: "DB",
    target: "db:5432",
    hasDsn: false,
    intervalSeconds: 30,
    enabled: true,
    lastStatus: "unknown",
    lastCheckedAt: null,
    lastLatencyMs: null,
    lastError: null,
    downSince: null,
    createdAt: NOW,
  });
  return {
    list: async () => [view()],
    byCode: async () => detail(),
    metrics: async () =>
      serverMetricsResponseSchema.parse({ resolution: "raw", truncated: false, points: [] }),
    create: log("create", withKey),
    update: log("update", view({ name: "renamed" })),
    setThresholds: log(
      "setThresholds",
      view({ alertThresholds: { cpuPct: 80, memPct: 85, diskPct: 90, sustainedMinutes: 10 } }),
    ),
    regenerateKey: log("regenerateKey", { ...withKey, ingestUrl: "https://stubwise.acme.test" }),
    delete: log("delete", undefined),
    createCheck: log("createCheck", check),
    updateCheck: log("updateCheck", check),
    deleteCheck: log("deleteCheck", undefined),
    analyses: async () => ({ analyses: [] }),
    ssh: async () => ssh(),
    connectSsh: log("connectSsh", ssh({ status: "pending", ...KEYS })),
    verifySsh: log("verifySsh", ssh({ status: "verified", usable: true, ...KEYS, ...VERIFIED })),
    regenerateSsh: log("regenerateSsh", ssh({ status: "pending", ...KEYS })),
    commandKey: log("commandKey", { publicKey: "ssh-ed25519 AAAAREAL stubwise-commands" }),
    revokeSsh: log(
      "revokeSsh",
      ssh({ status: "revoked", revokedAt: NOW, removeCommand: "sudo userdel --remove stubwise-read" }),
    ),
    startAnalysis: log("startAnalysis", analysis({ startedBy: { id: USER, name: "Marco" } })),
    search: log("search", [{ code: "SRV-2", name: "prod-web-1", projectCode: "AUD" }]),
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
      alerting: true,
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
        // Review F4a, M2: byte al secondo, il grezzo sul campionamento (30 s).
        netRxBytes: 5 / 30,
        netTxBytes: 6 / 30,
      },
      {
        ts: "2026-11-01T01:00:00.000Z",
        cpuPct: 20,
        memPct: 50,
        diskPct: 40,
        load1m: 0.5,
        // …e l'aggregato sul passo (1 h).
        netRxBytes: 7 / 3600,
        netTxBytes: 8 / 3600,
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

  it("review F4a, M1: la media è quella vera dopo la riduzione a 300 punti; a 7 giorni la nota dei punti ridotti", async () => {
    const raw = (i: number) => ({
      ts: new Date(Date.parse(NOW) - (2000 - i) * 30_000).toISOString(),
      cpuPct: 1,
      load1m: 0,
      memUsedBytes: 1,
      memTotalBytes: 2,
      swapUsedBytes: 0,
      diskUsedBytes: 1,
      diskTotalBytes: 2,
      netRxBytes: 0,
      netTxBytes: 0,
    });
    const series = (n: number) => async () =>
      serverMetricsResponseSchema.parse({
        resolution: "5m",
        truncated: false,
        points: Array.from({ length: n }, (_, i) => raw(i)),
      });
    const many = createRealServers(fakeApi({ metrics: series(2000) }), () => NOW);
    // A 7 giorni (passo del server 5 min, 2000 punti ridotti a 300): nessuna
    // «media di 5 minuti», la UI dice «300 punti medi di 2000 campioni».
    const week = await many.getServerMetrics("SRV-1", "7d");
    expect(week.averagedSeconds).toBeNull();
    expect(week.sampleCount).toBe(2000);
    // A 30 giorni la finestra vera dopo la riduzione, non il passo.
    expect((await many.getServerMetrics("SRV-1", "30d")).averagedSeconds).toBe(
      Math.round((30 * 86_400) / (300 - 2)),
    );
    // Pochi punti: la media è il passo del server.
    const few = createRealServers(fakeApi({ metrics: series(1) }), () => NOW);
    expect((await few.getServerMetrics("SRV-1", "30d")).averagedSeconds).toBe(300);
  });

  it("le metriche grezze non dicono una media; senza controllo nessun campione", async () => {
    const m = await createRealServers(fakeApi(), () => NOW).getServerMetrics("SRV-1", "24h");
    expect(m.averagedSeconds).toBeNull();
    expect(m.check).toBeNull();
  });

  it("le scritture: per id dal codice, le soglie intere", async () => {
    const servers = createRealServers(
      fakeApi(),
      () => NOW,
      async () => "https://desk.acme.test",
    );
    await servers.getServer("SRV-1");
    expect(
      (await servers.updateServer("SRV-1", { name: "renamed" })).name,
    ).toBe("renamed");
    const t = { cpuPct: 80, memPct: 85, diskPct: 90, sustainedMinutes: 10 };
    expect(await servers.setThresholds("SRV-1", t)).toEqual(t);
    await servers.deleteServer("SRV-1");
    expect(calls).toEqual([
      ["update", S1, { name: "renamed" }],
      ["setThresholds", S1, t],
      ["delete", S1],
    ]);
  });

  it("la chiave UNA volta, con l'indirizzo per il comando: quello del server, o l'istanza scelta", async () => {
    const servers = createRealServers(
      fakeApi(),
      () => NOW,
      async () => "https://desk.acme.test",
    );
    const created = await servers.createServer({ name: "new", environmentId: null });
    expect(created).toMatchObject({
      server: { code: "SRV-3" },
      agentKey: "sk_new",
      instanceUrl: "https://desk.acme.test",
    });
    expect(calls[0]).toEqual(["create", { name: "new" }]);
    await servers.getServer("SRV-1");
    expect(await servers.regenerateAgentKey("SRV-1")).toEqual({
      agentKey: "sk_new",
      instanceUrl: "https://stubwise.acme.test",
    });
  });

  it("creare dentro un ambiente (decisione c): l'ambiente senza repository = tutto il progetto", async () => {
    const servers = createRealServers(fakeApi(), () => NOW, async () => "https://desk.acme.test");
    await servers.createServer({ name: "edge", environmentId: ENV });
    expect(calls).toEqual([["create", { name: "edge", environment: { environmentId: ENV } }]]);
  });

  it("i controlli: per server e controllo; un controllo mai letto è not_found", async () => {
    const servers = createRealServers(fakeApi(), () => NOW);
    await expect(servers.deleteCheck(CHK)).rejects.toThrow("not_found");
    await servers.getServer("SRV-1");
    const input = {
      name: "DB",
      type: "tcp" as const,
      target: "db:5432",
      intervalSeconds: 30,
      enabled: true,
    };
    expect((await servers.createCheck("SRV-1", input)).serverCode).toBe("SRV-1");
    await servers.updateCheck(CHK, { enabled: false });
    await servers.deleteCheck(CHK);
    expect(calls).toEqual([
      ["createCheck", S1, input],
      ["updateCheck", S1, CHK, { enabled: false }],
      ["deleteCheck", S1, CHK],
    ]);
  });

  it("F4b: l'analisi dell'episodio e l'ultima a mano, nelle forme del prototipo (`serverOps.analyses`)", async () => {
    const api = fakeApi({
      analyses: async () => ({
        analyses: [
          analysis({
            id: AN,
            startedBy: { id: USER, name: "Marco" },
            status: "done",
            attribution: { kind: "undetermined", reason: "no_containers" },
            canViewDiagnosis: true,
            sessionId: SESSION,
            diagnosis: "Memory grows",
            finishedAt: "2026-11-14T11:40:00.000Z",
          }),
          analysis({
            id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
            episodeId: EP,
            status: "done",
            attribution: { kind: "attributed", projectCode: "ACQ" },
            taskCode: "ACQ-9",
            startedAt: "2026-11-14T11:01:00.000Z",
          }),
        ],
      }),
    });
    const d = await createRealServers(api, () => NOW).getServer("SRV-1");
    expect(d.episodes[0]).toMatchObject({
      taskCode: "ACQ-9",
      analysis: {
        episodeId: EP,
        outcome: "diagnosed",
        attribution: { kind: "attributed", projectCode: "ACQ" },
        sessionId: null,
        canViewDiagnosis: false,
        diagnosis: null,
        startedBy: null,
      },
    });
    expect(d.manualAnalysis).toEqual({
      id: AN,
      serverCode: "SRV-1",
      episodeId: null,
      outcome: "diagnosed",
      startedBy: { id: USER, name: "Marco" },
      startedAt: "2026-11-14T11:30:00.000Z",
      endedAt: "2026-11-14T11:40:00.000Z",
      canViewDiagnosis: true,
      sessionId: SESSION,
      attribution: { kind: "undetermined", reason: "no_containers" },
      diagnosis: "Memory grows",
      taskCode: null,
    });
  });

  it("F4b: una bloccata all'allarme diventa `analysisBlocked` dell'episodio, senza analisi", async () => {
    const api = fakeApi({
      analyses: async () => ({
        analyses: [analysis({ episodeId: EP, status: "blocked", blockedBy: "monthly_budget" })],
      }),
    });
    const d = await createRealServers(api, () => NOW).getServer("SRV-1");
    expect(d.episodes[0]).toMatchObject({ analysis: null, analysisBlocked: "monthly_budget" });
  });

  it("F4b: avviare l'analisi a mano per codice; una in corso è `invalid: analysis_running`", async () => {
    const real = createRealServers(fakeApi(), () => NOW);
    await real.getServer("SRV-1");
    const v = await real.startServerAnalysis("SRV-1");
    expect(calls).toContainEqual(["startAnalysis", S1]);
    expect(v).toMatchObject({ outcome: "running", startedBy: { id: USER, name: "Marco" } });
    const busy = createRealServers(
      fakeApi({
        startAnalysis: async () => {
          throw new ApiError(409, "conflict", "analysis_running");
        },
      }),
      () => NOW,
    );
    await busy.getServer("SRV-1");
    await expect(busy.startServerAnalysis("SRV-1")).rejects.toThrow("invalid: analysis_running");
  });

  it("F4b: `canStartAnalysis` lo dice il server; `endedBy: time` è il tempo scaduto", async () => {
    const api = fakeApi({
      byCode: async () => detail({ canStartAnalysis: true }),
      analyses: async () => ({
        analyses: [
          analysis({
            startedBy: { id: USER, name: "Marco" },
            status: "done",
            endedBy: "time",
          }),
        ],
      }),
    });
    const d = await createRealServers(api, () => NOW).getServer("SRV-1");
    expect(d.canStartAnalysis).toBe(true);
    expect(d.manualAnalysis?.outcome).toBe("timed_out");
    const off = await createRealServers(fakeApi(), () => NOW).getServer("SRV-1");
    expect(off.canStartAnalysis).toBe(false);
  });

  describe("F4b: l'accesso SSH nelle forme del prototipo", () => {
    const real = async (over: Partial<ServersApi> = {}) => {
      const r = createRealServers(fakeApi(over), () => NOW);
      await r.getServer("SRV-1");
      return r;
    };

    it("gli stati del server diventano quelli del prototipo", async () => {
      const stateOf = async (v: ReturnType<typeof ssh>) =>
        (await (await real({ ssh: async () => v })).getServer("SRV-1")).access;
      expect((await stateOf(ssh())).state).toBe("not_linked");
      const pending = await stateOf(ssh({ status: "pending", ...KEYS }));
      expect(pending).toMatchObject({ state: "awaiting_command", key: null, usable: false });
      expect(pending.pending).toMatchObject({ publicKey: KEYS.publicKey, fingerprint: "SHA256:abc" });
      const ok = await stateOf(
        ssh({ status: "verified", usable: true, lastUsedAt: NOW, ...KEYS, ...VERIFIED }),
      );
      expect(ok).toMatchObject({ state: "verified", usable: true, journal: true, pending: null });
      expect(ok.key).toMatchObject({ fingerprint: "SHA256:abc" });
      expect(ok.verification).toMatchObject({ login: "ok", groups: ["stubwise-read", "adm"], ok: true });
      // L'ultimo uso c'è, ma il server non dice con quale analisi o task.
      expect(ok.lastUse).toEqual({ at: NOW, label: null, sessionId: null });
      // Entrato con più della lettura: la verifica fallisce col risultato.
      const priv = await stateOf(
        ssh({
          status: "failed",
          ...KEYS,
          verifiedAt: NOW,
          verifyResult: { groups: ["sudo"], sudo: true, docker: false, journal: false, ok: false },
        }),
      );
      expect(priv.state).toBe("privileged");
      // Fallita senza risultato (connessione, comando, host key): verify_failed.
      expect((await stateOf(ssh({ status: "failed", ...KEYS }))).state).toBe("verify_failed");
      const revoked = await stateOf(ssh({ status: "revoked", revokedAt: NOW }));
      expect(revoked).toMatchObject({ state: "revoked", revokedAt: NOW, key: null });
    });

    it("chi non gestisce l'SSH (403): lo stato dal riassunto del dettaglio, senza chiavi né azioni", async () => {
      const r = await real({
        byCode: async () => detail({ ssh: { status: "verified", usable: true } }),
        ssh: async () => {
          throw new ApiError(403, "forbidden", "forbidden");
        },
      });
      const a = (await r.getServer("SRV-1")).access;
      expect(a).toMatchObject({
        state: "verified",
        usable: true,
        canManage: false,
        key: null,
        pending: null,
        verification: null,
      });
    });

    it("collega (host di base: quello dell'agente), verifica, rigenera, revoca", async () => {
      const r = await real();
      expect(await r.linkSshAccess("SRV-1")).toEqual({ command: KEYS.setupCommand });
      expect(calls).toContainEqual(["connectSsh", S1, {}]);
      expect((await r.verifySshAccess("SRV-1")).state).toBe("verified");
      expect(await r.regenerateSshAccess("SRV-1")).toEqual({ command: KEYS.setupCommand });
      expect(await r.revokeSshAccess("SRV-1")).toEqual({
        removalCommand: "sudo userdel --remove stubwise-read",
      });
    });

    it("i comandi da rivedere: quello d'installazione e quello di rimozione", async () => {
      const r = await real({ ssh: async () => ssh({ status: "pending", ...KEYS }) });
      expect(await r.getInstallCommand("SRV-1")).toEqual({ command: KEYS.setupCommand });
      await expect(r.getRemovalCommand("SRV-1")).rejects.toThrow("invalid: state");
      const gone = await real({
        ssh: async () => ssh({ status: "revoked", revokedAt: NOW, removeCommand: "sudo userdel x" }),
      });
      expect(await gone.getRemovalCommand("SRV-1")).toEqual({ command: "sudo userdel x" });
    });

    it("senza un hostname dall'agente il collegamento chiede l'host: `invalid: host_required`", async () => {
      const r = await real({
        connectSsh: async () => {
          throw new ApiError(400, "bad_request", "host_required");
        },
      });
      await expect(r.linkSshAccess("SRV-1")).rejects.toThrow("invalid: host_required");
    });
  });

  it("R3: la chiave dei comandi dal server", async () => {
    const r = createRealServers(fakeApi(), () => NOW);
    expect(await r.getCommandKey()).toEqual({ publicKey: "ssh-ed25519 AAAAREAL stubwise-commands" });
    expect(calls).toContainEqual(["commandKey"]);
  });
});

// ⌘K (rimandi, lotto 5, voce 1; 72, a7557fe21): la forma del prototipo,
// col progetto da cui aprirlo calcolato dal server.
describe("la ricerca ⌘K dei server", () => {
  it("i server trovati dal server, la domanda senza spazi; vuota, niente chiamata", async () => {
    const servers = createRealServers(fakeApi(), () => NOW);
    expect(await servers.searchServers("  web ")).toEqual([
      { code: "SRV-2", name: "prod-web-1", projectCode: "AUD" },
    ]);
    expect(await servers.searchServers("  ")).toEqual([]);
    expect(calls).toEqual([["search", "web"]]);
    // Revisione del lotto 5, M-7: senza ambiente visibile, nessun progetto.
    const orphan = createRealServers(
      fakeApi({ search: async () => [{ code: "SRV-9", name: "x", projectCode: null }] }),
      () => NOW,
    );
    expect(await orphan.searchServers("srv")).toEqual([
      { code: "SRV-9", name: "x", projectCode: null },
    ]);
  });
});
