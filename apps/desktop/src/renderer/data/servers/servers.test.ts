import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { METRIC_POINTS_MAX } from "../../domain/servers/limits";
import { failNext, listNotifications, releases, resetApi, servers, setLatency } from "../api";
import { setSessionPersonId } from "../session";
import { state, storeGeneration } from "../store";
import type { ServerService } from "../types";
import { grantInstancePermission, grantProjectRole } from "../viewer";
import { serverFor, serversVisibleTo } from "./visibility";

const as = (personId: string) => setSessionPersonId(personId);
const server = (code: string) => state.servers.find((s) => s.code === code);
const env = (id: string) => state.environments.find((e) => e.id === id)!;
/** `monitor.manage` è un permesso di `@stubwise/shared`, non del prototipo: il cast serve solo al tipo. */
const grantMonitor = (personId: string) =>
  grantInstancePermission(
    personId,
    "monitor.manage" as Parameters<typeof grantInstancePermission>[1],
  );
/** Tutto lo stato, Map e Set compresi, come testo. */
const dumpState = () =>
  JSON.stringify(state, (_, v: unknown) =>
    v instanceof Map ? [...v.entries()] : v instanceof Set ? [...v] : v,
  );
const AGENT_KEY_RE = /sk_[0-9a-f]{40}/;

beforeEach(() => {
  resetApi();
  setLatency(0);
});

afterEach(() => resetApi());

describe("visibilità dei server (R-L2, R-G5)", () => {
  it("un server si vede attraverso gli ambienti dei progetti visibili", () => {
    // Marco vede ACQ e AUD; Sara vede ACQ ma non AUD.
    expect(serversVisibleTo("p-marco").has("SRV-1")).toBe(true);
    expect(serversVisibleTo("p-marco").has("SRV-3")).toBe(true);
    expect(serversVisibleTo("p-sara").has("SRV-1")).toBe(true);
    expect(serversVisibleTo("p-sara").has("SRV-3")).toBe(false);
    expect(serversVisibleTo("p-sara").has("SRV-4")).toBe(false);
  });

  it("serverFor: inesistente e invisibile rispondono allo stesso modo", () => {
    expect(serverFor("p-marco", "SRV-1").code).toBe("SRV-1");
    expect(() => serverFor("p-sara", "SRV-3")).toThrow("not_found");
    expect(() => serverFor("p-sara", "SRV-99")).toThrow("not_found");
  });

  it("Marco vede SRV-1 nella sezione di ACQ; Sara non vede SRV-3, nemmeno nel dettaglio", async () => {
    as("p-marco");
    expect((await servers.listProjectServers("prj-acq")).map((s) => s.code)).toEqual(["SRV-1"]);
    expect((await servers.listProjectServers("prj-aud")).map((s) => s.code)).toEqual([
      "SRV-3",
      "SRV-4",
    ]);
    as("p-sara");
    expect((await servers.listProjectServers("prj-acq")).map((s) => s.code)).toEqual(["SRV-1"]);
    expect(await servers.listProjectServers("prj-aud")).toEqual([]);
    const hidden = await servers.getServer("SRV-3").catch((e: Error) => e.message);
    const missing = await servers.getServer("SRV-99").catch((e: Error) => e.message);
    expect(hidden).toBe("not_found");
    expect(missing).toBe(hidden);
    await expect(servers.getServerMetrics("SRV-3", "1h")).rejects.toThrow("not_found");
  });
});

describe("letture dei server", () => {
  it("la riga di SRV-1: salute, lavoro, accesso, ambienti, principale, CPU recente", async () => {
    as("p-marco");
    const [row] = await servers.listProjectServers("prj-acq");
    expect(row).toMatchObject({
      code: "SRV-1",
      name: "acq-prod-01",
      hostname: "acq-prod-01.colline.internal",
      status: "online",
      health: { health: "healthy" },
      // La task della diagnosi (ACQ-6) è aperta.
      work: "diagnosis_ready",
      access: "verified",
      environments: [{ projectCode: "ACQ", name: "Production", kind: "production" }],
      primaryProjectCode: "ACQ",
    });
    expect(row!.recentCpu.length).toBeGreaterThan(0);
    expect(row!.recentCpu.length).toBeLessThanOrEqual(servers.RECENT_CPU_POINTS);
  });

  it("SRV-2 è in difficoltà e non collegato; SRV-3 attende il comando", async () => {
    as("p-roberta");
    const [srv2] = await servers.listProjectServers("prj-stw");
    expect(srv2).toMatchObject({ code: "SRV-2", access: "not_linked", work: "none" });
    expect(srv2!.health.health).toBe("trouble");
    const aud = await servers.listProjectServers("prj-aud");
    expect(aud.find((s) => s.code === "SRV-3")!.access).toBe("awaiting_command");
  });

  it("gli ambienti di un progetto invisibile non compaiono nella riga", async () => {
    // SRV-1 anche nello staging di AUD: Sara, che non vede AUD, non lo sa.
    env("env-aud-staging").servers.push({
      repositoryId: null,
      serverCode: "SRV-1",
      reportedSha: null,
      reportedAt: null,
    });
    as("p-sara");
    const [row] = await servers.listProjectServers("prj-acq");
    expect(row!.environments.map((e) => e.projectCode)).toEqual(["ACQ"]);
    as("p-marco");
    const [full] = await servers.listProjectServers("prj-acq");
    expect(full!.environments.map((e) => e.projectCode)).toEqual(["AUD", "ACQ"]);
  });

  it("il dettaglio di SRV-1: soglie, servizi, dischi, controlli, episodi con analisi e task", async () => {
    as("p-marco");
    const d = await servers.getServer("SRV-1");
    expect(d.thresholds).toEqual({ cpuPct: 95, memPct: 90, diskPct: 90, sustainedMinutes: 5 });
    expect(d.services.map((s) => s.name)).toContain("portale-import");
    expect(d.disks).toHaveLength(2);
    expect(d.checks.map((c) => c.id)).toEqual([
      "chk-srv-1-api",
      "chk-srv-1-db",
      "chk-srv-1-import",
    ]);
    expect(d.episodes).toHaveLength(1);
    expect(d.episodes[0]!.analysis).toMatchObject({ id: "an-srv-1-1", outcome: "diagnosed" });
    expect(d.episodes[0]!.taskCode).toBe("ACQ-6");
    expect(d.productionProjects).toEqual([
      { id: "prj-acq", code: "ACQ", name: expect.any(String) },
    ]);
    expect(d.canManage).toBe(false);
    as("p-roberta");
    expect((await servers.getServer("SRV-1")).canManage).toBe(true);
  });

  it("analisi e task di un progetto invisibile non escono dal dettaglio", async () => {
    // SRV-1 anche nella produzione di AUD (Sara non la vede); l'analisi resta di ACQ.
    state.serverAnalyses[0]!.projectId = "prj-aud";
    state.tasksById.get(state.serverAnalyses[0]!.taskId!)!.projectId = "prj-aud";
    env("env-aud-staging").servers.push({
      repositoryId: null,
      serverCode: "SRV-1",
      reportedSha: null,
      reportedAt: null,
    });
    as("p-sara");
    const d = await servers.getServer("SRV-1");
    expect(d.episodes[0]!.analysis).toBeNull();
    expect(d.episodes[0]!.taskCode).toBeNull();
  });

  it("RF 5: 200 servizi restituiti tutti", async () => {
    const many: ServerService[] = Array.from({ length: 200 }, (_, i) => ({
      name: `svc-${i}`,
      source: "docker",
      state: "running",
      cpuPct: 0.1,
      memBytes: 1024,
      restarts: 0,
    }));
    server("SRV-1")!.services = many;
    as("p-marco");
    expect((await servers.getServer("SRV-1")).services).toHaveLength(200);
  });

  it("RF 5: 7 giorni di metriche a 30 s si riducono a ≤ 300 punti", async () => {
    as("p-marco");
    const week = await servers.getServerMetrics("SRV-1", "7d");
    expect(week.points.length).toBeLessThanOrEqual(METRIC_POINTS_MAX);
    expect(week.truncated).toBe(true);
    expect(week.check).toBeNull();
    const hour = await servers.getServerMetrics("SRV-1", "1h");
    expect(hour.truncated).toBe(false);
    expect(hour.points.length).toBe(120);
    const from = Date.parse(hour.points[0]!.ts);
    expect(Date.parse(hour.points.at(-1)!.ts) - from).toBeLessThan(3_600_000);
  });

  it("i punti delle metriche sono copie, non lo stato", async () => {
    as("p-marco");
    const hour = await servers.getServerMetrics("SRV-1", "1h", "chk-srv-1-api");
    const stored = state.serverMetrics.get("SRV-1")!.at(-1)!;
    const sample = state.serverCheckSamples.get("chk-srv-1-api")!.at(-1)!;
    expect(hour.points.at(-1)).toEqual(stored);
    expect(hour.points.at(-1)).not.toBe(stored);
    expect(hour.check!.samples.at(-1)).not.toBe(sample);
    hour.points.at(-1)!.cpuPct = -1;
    expect(stored.cpuPct).not.toBe(-1);
  });

  it("R-L1: con un controllo, i campioni della latenza (ridotti anch'essi)", async () => {
    as("p-marco");
    const day = await servers.getServerMetrics("SRV-1", "24h", "chk-srv-1-api");
    expect(day.check).not.toBeNull();
    expect(day.check!.samples.length).toBeLessThanOrEqual(METRIC_POINTS_MAX);
    expect(day.check!.truncated).toBe(true);
    // Quanti campioni c'erano: la nota dei punti ridotti vale anche qui (T7 m5).
    expect(day.check!.sampleCount).toBeGreaterThan(day.check!.samples.length);
    expect(day.check!.samples.some((s) => s.latencyMs !== null)).toBe(true);
    // La replica di SRV-2 è giù: le fasce dei momenti giù non si perdono nella media.
    const replica = await servers.getServerMetrics("SRV-2", "7d", "chk-srv-2-replica");
    expect(replica.check!.samples.at(-1)).toMatchObject({ status: "down", latencyMs: null });
    expect(replica.check!.samples.some((s) => s.status === "down")).toBe(true);
    // Un controllo di un altro server non si legge da qui.
    await expect(servers.getServerMetrics("SRV-1", "1h", "chk-srv-2-db")).rejects.toThrow(
      "not_found",
    );
  });

  it("⌘K: per codice, nome o hostname, solo fra i server visibili", async () => {
    as("p-sara");
    // Sara vede ACQ e STW, non AUD.
    expect(await servers.searchServers("srv")).toEqual([
      { code: "SRV-1", name: "acq-prod-01", projectCode: "ACQ" },
      { code: "SRV-2", name: "db-stw-01", projectCode: "STW" },
    ]);
    expect(await servers.searchServers("aud-app")).toEqual([]);
    as("p-marco");
    expect(await servers.searchServers("aud-app")).toEqual([
      { code: "SRV-3", name: "aud-app-01", projectCode: "AUD" },
    ]);
    expect(await servers.searchServers("colline.internal")).toHaveLength(1);
    expect(await servers.searchServers("  ")).toEqual([]);
  });

  it("serverHref: il dettaglio del server nella sezione del progetto", () => {
    expect(servers.serverHref("STW", "SRV-2")).toBe("#/p/STW/servers/SRV-2");
  });
});

describe("monitor: creare, modificare, togliere (monitor.manage)", () => {
  it("senza monitor.manage (Laura): forbidden, e nessun server", async () => {
    as("p-laura");
    const before = state.servers.length;
    await expect(
      servers.createServer({ name: "aud-new", environmentId: "env-aud-staging" }),
    ).rejects.toThrow("forbidden");
    expect(state.servers).toHaveLength(before);
    expect(state.serverCodeSeq).toBe(4);
    await expect(servers.updateServer("SRV-3", { name: "x" })).rejects.toThrow("forbidden");
    await expect(servers.deleteServer("SRV-3")).rejects.toThrow("forbidden");
    await expect(servers.regenerateAgentKey("SRV-3")).rejects.toThrow("forbidden");
  });

  it("Roberta crea SRV-5 nello staging di AUD; la chiave non esce da nessuna lettura", async () => {
    as("p-roberta");
    const { server: row, agentKey } = await servers.createServer({
      name: "  aud-staging-01 ",
      environmentId: "env-aud-staging",
    });
    expect(row).toMatchObject({
      code: "SRV-5",
      name: "aud-staging-01",
      status: "never_connected",
      health: { health: "never_connected" },
      access: "not_linked",
      environments: [{ projectCode: "AUD", name: "Staging", kind: "staging" }],
      primaryProjectCode: null,
    });
    expect(agentKey).toMatch(/^sk_[0-9a-f]{40}$/);
    expect(env("env-aud-staging").servers).toEqual([
      { repositoryId: null, serverCode: "SRV-5", reportedSha: null, reportedAt: null },
    ]);
    const again = await servers.regenerateAgentKey("SRV-5");
    expect(again.agentKey).toMatch(/^sk_[0-9a-f]{40}$/);
    expect(again.agentKey).not.toBe(agentKey);
    // Ogni lettura del livello dati dei server, le notifiche e TUTTO lo stato.
    const reads = JSON.stringify([
      await servers.getServer("SRV-5"),
      await servers.listProjectServers("prj-aud"),
      await servers.searchServers("SRV-5"),
      await servers.getServerMetrics("SRV-5", "7d"),
      await releases.listEnvironments("prj-aud"),
      await listNotifications(),
    ]);
    for (const text of [reads, dumpState()]) {
      expect(text).not.toContain(agentKey);
      expect(text).not.toContain(again.agentKey);
      expect(text).not.toMatch(AGENT_KEY_RE);
    }
  });

  it("con monitor.manage ma senza environments.manage nel progetto: forbidden", async () => {
    // Sara (Contributor su STW) gestisce il monitor ma non gli ambienti di STW.
    grantMonitor("p-sara");
    as("p-sara");
    await expect(
      servers.createServer({ name: "x", environmentId: "env-stw-staging" }),
    ).rejects.toThrow("forbidden");
    expect(state.serverCodeSeq).toBe(4);
    expect(env("env-stw-staging").servers).toEqual([]);
    grantProjectRole("p-sara", "prj-stw", "project_lead");
    const { server: row } = await servers.createServer({
      name: "x",
      environmentId: "env-stw-staging",
    });
    expect(row.code).toBe("SRV-5");
  });

  it("serve environments.manage nel progetto dell'ambiente, e un ambiente senza server", async () => {
    as("p-roberta");
    await expect(
      servers.createServer({ name: "dup", environmentId: "env-acq-prod" }),
    ).rejects.toThrow("invalid: environment");
    await expect(
      servers.createServer({ name: " ", environmentId: "env-aud-staging" }),
    ).rejects.toThrow("invalid: name");
    await expect(servers.createServer({ name: "x", environmentId: "env-nope" })).rejects.toThrow(
      "not_found",
    );
    expect(state.serverCodeSeq).toBe(4);
  });

  it("deleteServer toglie il server dagli ambienti; il codice non si riusa", async () => {
    as("p-roberta");
    const first = await servers.createServer({ name: "a", environmentId: "env-aud-staging" });
    expect(first.server.code).toBe("SRV-5");
    await servers.deleteServer("SRV-5");
    expect(server("SRV-5")).toBeUndefined();
    expect(env("env-aud-staging").servers).toEqual([]);
    const second = await servers.createServer({ name: "b", environmentId: "env-aud-staging" });
    expect(second.server.code).toBe("SRV-6");
    await servers.deleteServer("SRV-3");
    expect(env("env-aud-prod").servers.map((s) => s.serverCode)).toEqual(["SRV-4"]);
    expect(state.serverChecks.some((c) => c.serverCode === "SRV-3")).toBe(false);
    await expect(servers.getServer("SRV-3")).rejects.toThrow("not_found");
  });

  it("updateServer: nome, intervallo 10–300, principale fra le produzioni", async () => {
    as("p-roberta");
    await servers.updateServer("SRV-1", { name: "acq-prod-02", sampleIntervalSeconds: 60 });
    expect(server("SRV-1")).toMatchObject({ name: "acq-prod-02", sampleIntervalSeconds: 60 });
    await expect(servers.updateServer("SRV-1", { sampleIntervalSeconds: 9 })).rejects.toThrow(
      "invalid: sampleIntervalSeconds",
    );
    await expect(servers.updateServer("SRV-1", { sampleIntervalSeconds: 301 })).rejects.toThrow(
      "invalid: sampleIntervalSeconds",
    );
    await expect(servers.updateServer("SRV-1", { sampleIntervalSeconds: 30.5 })).rejects.toThrow(
      "invalid: sampleIntervalSeconds",
    );
    await expect(servers.updateServer("SRV-1", { name: "" })).rejects.toThrow("invalid: name");
    // AUD non usa SRV-1 in produzione: non può esserne il principale.
    await expect(servers.updateServer("SRV-1", { primaryProjectId: "prj-aud" })).rejects.toThrow(
      "invalid: primaryProjectId",
    );
    env("env-aud-prod").servers.push({
      repositoryId: "repo-aud-scripts",
      serverCode: "SRV-1",
      reportedSha: null,
      reportedAt: null,
    });
    await servers.updateServer("SRV-1", { primaryProjectId: "prj-aud" });
    expect(server("SRV-1")!.primaryProjectId).toBe("prj-aud");
    // Uno scarto lascia il server com'era: niente scritture a metà.
    await expect(
      servers.updateServer("SRV-1", { name: "half", sampleIntervalSeconds: 5 }),
    ).rejects.toThrow("invalid");
    expect(server("SRV-1")!.name).toBe("acq-prod-02");
  });

  it("setThresholds: 1–100 o spenta, minuti 1–60", async () => {
    as("p-roberta");
    await servers.setThresholds("SRV-2", {
      cpuPct: null,
      memPct: 80,
      diskPct: 95,
      sustainedMinutes: 10,
    });
    expect(server("SRV-2")!.thresholds).toEqual({
      cpuPct: null,
      memPct: 80,
      diskPct: 95,
      sustainedMinutes: 10,
    });
    const base = { cpuPct: 95, memPct: 90, diskPct: 90, sustainedMinutes: 5 };
    for (const [bad, what] of [
      [{ cpuPct: 0 }, "cpuPct"],
      [{ memPct: 101 }, "memPct"],
      [{ diskPct: Number.NaN }, "diskPct"],
      [{ sustainedMinutes: 0 }, "sustainedMinutes"],
      [{ sustainedMinutes: 61 }, "sustainedMinutes"],
      [{ sustainedMinutes: 2.5 }, "sustainedMinutes"],
    ] as const) {
      await expect(servers.setThresholds("SRV-2", { ...base, ...bad })).rejects.toThrow(
        `invalid: ${what}`,
      );
    }
    expect(server("SRV-2")!.thresholds.memPct).toBe(80);
    as("p-marco");
    await expect(servers.setThresholds("SRV-1", base)).rejects.toThrow("forbidden");
  });

  it("controlli: crea, modifica, togli; intervallo 10–3600 e tipi del web", async () => {
    as("p-roberta");
    const c = await servers.createCheck("SRV-4", {
      name: "Admin DB",
      type: "mysql",
      target: "127.0.0.1:3306",
      intervalSeconds: 30,
      enabled: true,
    });
    expect(c).toMatchObject({ serverCode: "SRV-4", status: "unknown", latencyMs: null });
    expect((await servers.getServer("SRV-4")).checks.map((x) => x.id)).toContain(c.id);
    const updated = await servers.updateCheck(c.id, { intervalSeconds: 3600, enabled: false });
    expect(updated).toMatchObject({ intervalSeconds: 3600, enabled: false, name: "Admin DB" });
    const good = {
      name: "x",
      type: "http" as const,
      target: "https://x.test",
      intervalSeconds: 60,
      enabled: true,
    };
    await expect(servers.createCheck("SRV-4", { ...good, intervalSeconds: 9 })).rejects.toThrow(
      "invalid: intervalSeconds",
    );
    await expect(servers.updateCheck(c.id, { intervalSeconds: 3601 })).rejects.toThrow(
      "invalid: intervalSeconds",
    );
    await expect(servers.createCheck("SRV-4", { ...good, type: "ftp" as never })).rejects.toThrow(
      "invalid: type",
    );
    await expect(servers.createCheck("SRV-4", { ...good, name: " " })).rejects.toThrow(
      "invalid: name",
    );
    await expect(servers.createCheck("SRV-4", { ...good, target: "" })).rejects.toThrow(
      "invalid: target",
    );
    await servers.deleteCheck(c.id);
    expect(state.serverChecks.some((x) => x.id === c.id)).toBe(false);
    await expect(servers.deleteCheck(c.id)).rejects.toThrow("not_found");
    as("p-marco");
    await expect(servers.createCheck("SRV-1", good)).rejects.toThrow("forbidden");
    await expect(servers.deleteCheck("chk-srv-1-api")).rejects.toThrow("forbidden");
    as("p-sara");
    await expect(servers.updateCheck("chk-srv-3-app", { enabled: false })).rejects.toThrow(
      "not_found",
    );
  });
});

describe("R-G5 sulle scritture", () => {
  it("ogni scrittura su un server nascosto risponde come su uno inesistente, prima di forbidden", async () => {
    as("p-sara"); // non vede AUD, non ha monitor.manage
    const writes: [string, (code: string) => Promise<unknown>][] = [
      ["updateServer", (c) => servers.updateServer(c, { name: "x" })],
      ["deleteServer", (c) => servers.deleteServer(c)],
      ["regenerateAgentKey", (c) => servers.regenerateAgentKey(c)],
      [
        "setThresholds",
        (c) =>
          servers.setThresholds(c, { cpuPct: 50, memPct: 50, diskPct: 50, sustainedMinutes: 5 }),
      ],
      [
        "createCheck",
        (c) =>
          servers.createCheck(c, {
            name: "x",
            type: "http",
            target: "https://x.test",
            intervalSeconds: 60,
            enabled: true,
          }),
      ],
    ];
    const before = JSON.stringify([state.servers, state.serverChecks]);
    for (const [name, write] of writes) {
      const hidden = await write("SRV-3").catch((e: Error) => e.message);
      const missing = await write("SRV-99").catch((e: Error) => e.message);
      expect(hidden, name).toBe("not_found");
      expect(missing, name).toBe(hidden);
      // Su un server che vede ma senza monitor.manage: forbidden.
      expect(await write("SRV-1").catch((e: Error) => e.message), name).toBe("forbidden");
    }
    for (const [name, del] of [
      ["updateCheck", (id: string) => servers.updateCheck(id, { enabled: false })],
      ["deleteCheck", (id: string) => servers.deleteCheck(id)],
    ] as const) {
      const hidden = await del("chk-srv-3-app").catch((e: Error) => e.message);
      const missing = await del("chk-nope").catch((e: Error) => e.message);
      expect(hidden, name).toBe("not_found");
      expect(missing, name).toBe(hidden);
    }
    expect(JSON.stringify([state.servers, state.serverChecks])).toBe(before);
  });

  it("I1: un ambiente non può nominare un server nascosto; stesso errore di uno inesistente", async () => {
    // Sara diventa Project Lead di ACQ (environments.manage) ma non vede AUD, quindi né SRV-3 né SRV-4.
    grantProjectRole("p-sara", "prj-acq", "project_lead");
    as("p-sara");
    const before = JSON.stringify(state.environments);
    const attempt = (code: string) =>
      releases
        .updateEnvironment("env-acq-prod", {
          servers: [{ repositoryId: null, serverCode: code }],
        })
        .catch((e: Error) => e.message);
    const hidden = await attempt("SRV-3");
    const missing = await attempt("SRV-99");
    expect(hidden).toBe("invalid: serverCode");
    expect(missing).toBe(hidden);
    const created = await releases
      .createEnvironment("prj-acq", {
        name: "Staging",
        kind: "staging",
        url: null,
        servers: [{ repositoryId: null, serverCode: "srv-4" }],
      })
      .catch((e: Error) => e.message);
    expect(created).toBe("invalid: serverCode");
    expect(JSON.stringify(state.environments)).toBe(before);
    expect(serversVisibleTo("p-sara").has("SRV-3")).toBe(false);
    await expect(servers.getServer("SRV-3")).rejects.toThrow("not_found");
    // Un server che vede, invece, si può nominare.
    await releases.updateEnvironment("env-acq-prod", {
      servers: [{ repositoryId: null, serverCode: "SRV-2" }],
    });
    expect(env("env-acq-prod").servers.map((s) => s.serverCode)).toEqual(["SRV-2"]);
  });
});

describe("«Link SSH access» dell'avviso porta dove il server è", () => {
  it("spostato in un altro progetto che chi guarda vede, il link apre quel progetto", async () => {
    as("p-roberta");
    const href = async () =>
      (await listNotifications()).find(
        (n) => n.kind === "server.trouble" && n.objectCode === "SRV-2",
      )!.linkAccessHref;
    expect(await href()).toMatch(/\/p\/STW\/servers\/SRV-2\?section=access$/);
    for (const env of state.environments)
      env.servers = env.servers.filter((s) => s.serverCode !== "SRV-2");
    const acq = state.environments.find((e) => e.id === "env-acq-prod")!;
    acq.servers.push({ repositoryId: null, serverCode: "SRV-2", reportedSha: null, reportedAt: null });
    expect(await href()).toMatch(/\/p\/ACQ\/servers\/SRV-2\?section=access$/);
  });
});

describe("R-L7: un server orfano lo vede chi ha monitor.manage", () => {
  it("tolto l'ultimo ambiente, resta raggiungibile dal monitor e si può togliere", async () => {
    as("p-roberta");
    await releases.deleteEnvironment("env-acq-prod");
    // Senza monitor.manage nessuno lo vede, nemmeno chi era in ACQ.
    expect(serversVisibleTo("p-marco").has("SRV-1")).toBe(false);
    as("p-marco");
    await expect(servers.getServer("SRV-1")).rejects.toThrow("not_found");
    expect(await servers.searchServers("acq-prod")).toEqual([]);
    // Con monitor.manage sì (Roberta, e Marco dopo la concessione).
    expect(serversVisibleTo("p-roberta").has("SRV-1")).toBe(true);
    grantMonitor("p-marco");
    expect(serversVisibleTo("p-marco").has("SRV-1")).toBe(true);
    expect((await servers.getServer("SRV-1")).environments).toEqual([]);
    // Col monitor non si vedono i server collegati a progetti invisibili: solo gli orfani.
    grantMonitor("p-sara");
    expect(serversVisibleTo("p-sara").has("SRV-1")).toBe(true);
    expect(serversVisibleTo("p-sara").has("SRV-3")).toBe(false);
    as("p-roberta");
    await servers.deleteServer("SRV-1");
    expect(server("SRV-1")).toBeUndefined();
  });

  it("tolto l'ambiente di produzione, il principale che non usa più il server si azzera", async () => {
    expect(server("SRV-1")!.primaryProjectId).toBe("prj-acq");
    as("p-roberta");
    await releases.deleteEnvironment("env-acq-prod");
    expect(server("SRV-1")!.primaryProjectId).toBeNull();
    // Gli altri server restano col loro principale.
    expect(server("SRV-2")!.primaryProjectId).toBe("prj-stw");
  });

  it("tolta la riga dalla produzione con updateEnvironment, lo stesso", async () => {
    as("p-roberta");
    await releases.updateEnvironment("env-acq-prod", { servers: [] });
    expect(server("SRV-1")!.primaryProjectId).toBeNull();
  });
});

describe("simulatore", () => {
  it("failNext rifiuta solo la chiamata successiva", async () => {
    as("p-marco");
    failNext("servers.listProjectServers");
    await expect(servers.listProjectServers("prj-acq")).rejects.toThrow("Simulated failure");
    expect(await servers.listProjectServers("prj-acq")).toHaveLength(1);
    as("p-roberta");
    failNext("servers.createServer");
    await expect(
      servers.createServer({ name: "x", environmentId: "env-aud-staging" }),
    ).rejects.toThrow("Simulated failure");
    expect(state.serverCodeSeq).toBe(4);
  });

  it("una scrittura partita prima di resetApi non scrive", async () => {
    setLatency(20);
    as("p-roberta");
    const gen = storeGeneration();
    const pending = servers.createServer({ name: "x", environmentId: "env-aud-staging" });
    resetApi();
    await expect(pending).rejects.toThrow("reset");
    expect(storeGeneration()).not.toBe(gen);
    expect(state.serverCodeSeq).toBe(4);
    expect(env("env-aud-staging").servers).toEqual([]);
  });

  it("resetApi ripulisce server, ambienti, controlli e contatore", async () => {
    as("p-roberta");
    await servers.createServer({ name: "x", environmentId: "env-aud-staging" });
    await servers.deleteServer("SRV-1");
    await servers.setThresholds("SRV-2", {
      cpuPct: 50,
      memPct: 50,
      diskPct: 50,
      sustainedMinutes: 1,
    });
    resetApi();
    expect(state.servers.map((s) => s.code)).toEqual(["SRV-1", "SRV-2", "SRV-3", "SRV-4"]);
    expect(state.serverCodeSeq).toBe(4);
    expect(env("env-acq-prod").servers.map((s) => s.serverCode)).toEqual(["SRV-1"]);
    expect(env("env-aud-staging").servers).toEqual([]);
    expect(server("SRV-2")!.thresholds.cpuPct).toBe(95);
    expect(state.serverChecks.some((c) => c.serverCode === "SRV-1")).toBe(true);
  });
});

describe("Task 7: ciò che la UI legge senza dedurlo", () => {
  const stagingRow = (serverCode: string) => ({
    repositoryId: null,
    serverCode,
    reportedSha: null,
    reportedAt: null,
  });

  it("la riga dice la task del lavoro (se visibile) e dove si apre la diagnosi", async () => {
    as("p-marco");
    const [srv1] = await servers.listProjectServers("prj-acq");
    expect(srv1!.work).toBe("diagnosis_ready");
    expect(srv1!.workTaskCode).toBe("ACQ-6");
    expect(srv1!.analysisProject).toEqual({ code: "ACQ" });
    // Usato anche dallo staging di STW: la diagnosi resta in AUD, la sua produzione.
    env("env-stw-staging").servers.push(stagingRow("SRV-3"));
    as("p-roberta");
    const stw = await servers.listProjectServers("prj-stw");
    expect(stw.find((s) => s.code === "SRV-3")!.analysisProject).toEqual({ code: "AUD" });
    // Chi non vede il progetto della diagnosi sa solo che è «un altro progetto».
    as("p-sara");
    const seen = (await servers.listProjectServers("prj-stw")).find((s) => s.code === "SRV-3")!;
    expect(seen.analysisProject).toEqual({ code: null });
    // Nessuna produzione: nessuna diagnosi.
    env("env-aud-prod").servers = env("env-aud-prod").servers.filter(
      (s) => s.serverCode !== "SRV-3",
    );
    as("p-roberta");
    const staging = (await servers.listProjectServers("prj-stw")).find((s) => s.code === "SRV-3")!;
    expect(staging.analysisProject).toBeNull();
  });

  it("le metriche portano quanti campioni c'erano prima della riduzione", async () => {
    as("p-marco");
    const week = await servers.getServerMetrics("SRV-1", "7d");
    expect(week.truncated).toBe(true);
    expect(week.sampleCount).toBeGreaterThan(week.points.length);
    const hour = await servers.getServerMetrics("SRV-1", "1h");
    expect(hour.sampleCount).toBe(hour.points.length);
  });

  it("il dettaglio dice se l'SSH risponde (solo prototipo)", async () => {
    as("p-marco");
    expect((await servers.getServer("SRV-1")).sshReachable).toBe(true);
    await servers.simulateSshUnreachable("SRV-1", true);
    expect((await servers.getServer("SRV-1")).sshReachable).toBe(false);
  });

  it("⌘K trova un server orfano per chi ha monitor.manage, nel suo primo progetto", async () => {
    as("p-roberta");
    await releases.deleteEnvironment("env-acq-prod");
    server("SRV-1")!.primaryProjectId = null;
    expect(await servers.searchServers("SRV-1")).toEqual([
      { code: "SRV-1", name: "acq-prod-01", projectCode: "ACQ" },
    ]);
    as("p-marco");
    expect(await servers.searchServers("SRV-1")).toEqual([]);
  });

  it("gli ambienti dicono quali server non usa nessun altro progetto", async () => {
    as("p-laura");
    expect((await releases.listEnvironments("prj-aud")).onlyHere).toEqual(["SRV-3", "SRV-4"]);
    env("env-stw-staging").servers.push(stagingRow("SRV-3"));
    expect((await releases.listEnvironments("prj-aud")).onlyHere).toEqual(["SRV-4"]);
  });
});

describe("area 9b, Task 7: i server di tutta l'istanza", () => {
  const orphanOf = (rows: { code: string; orphan: boolean }[], code: string) =>
    rows.find((r) => r.code === code)!.orphan;

  it("Roberta vede tutti i server, orfani compresi, coi progetti; Marco senza monitor.manage → forbidden", async () => {
    as("p-roberta");
    await releases.deleteEnvironment("env-acq-prod");
    const rows = await servers.listAllServers();
    expect(rows.map((r) => r.code)).toEqual(["SRV-1", "SRV-2", "SRV-3", "SRV-4"]);
    expect(orphanOf(rows, "SRV-1")).toBe(true);
    expect(rows.find((r) => r.code === "SRV-1")!.projects).toEqual([]);
    expect(orphanOf(rows, "SRV-3")).toBe(false);
    expect(rows.find((r) => r.code === "SRV-3")!.projects.map((p) => p.code)).toEqual(["AUD"]);
    expect(rows.find((r) => r.code === "SRV-3")!.projects[0]!.name).toBe(
      state.projectsById.get("prj-aud")!.name,
    );
    as("p-marco");
    await expect(servers.listAllServers()).rejects.toThrow("forbidden");
  });

  it("un monitor-manager che non vede AUD non trova AUD nella colonna, e il server NON è orfano (RF 2)", async () => {
    grantMonitor("p-sara");
    as("p-sara");
    const rows = await servers.listAllServers();
    const srv3 = rows.find((r) => r.code === "SRV-3")!;
    expect(srv3.projects).toEqual([]);
    expect(srv3.orphan).toBe(false);
    expect(rows.find((r) => r.code === "SRV-1")!.projects.map((p) => p.code)).toEqual(["ACQ"]);
  });

  it("createServer con environmentId null: nasce orfano, solo da chi ha monitor.manage; dal progetto resta come nell'8b", async () => {
    as("p-laura");
    await expect(servers.createServer({ name: "x", environmentId: null })).rejects.toThrow(
      "forbidden",
    );
    expect(state.servers).toHaveLength(4);
    as("p-roberta");
    const { server: row, agentKey } = await servers.createServer({
      name: " orfano-01 ",
      environmentId: null,
    });
    expect(agentKey).toMatch(/^sk_[0-9a-f]{40}$/);
    expect(row).toMatchObject({
      code: "SRV-5",
      name: "orfano-01",
      status: "never_connected",
      environments: [],
      primaryProjectCode: null,
    });
    expect(state.environments.some((e) => e.servers.some((s) => s.serverCode === "SRV-5"))).toBe(
      false,
    );
    expect(server("SRV-5")!.primaryProjectId).toBeNull();
    const all = await servers.listAllServers();
    expect(orphanOf(all, "SRV-5")).toBe(true);
    expect((await servers.getServer("SRV-5")).orphan).toBe(true);
    // Chi non ha monitor.manage non lo vede, nemmeno per codice.
    as("p-marco");
    await expect(servers.getServer("SRV-5")).rejects.toThrow("not_found");
    expect((await servers.listProjectServers("prj-acq")).map((s) => s.code)).not.toContain("SRV-5");
    // Con un ambiente, come prima: non è orfano.
    as("p-roberta");
    const inEnv = await servers.createServer({ name: "aud-st", environmentId: "env-aud-staging" });
    expect((await servers.getServer(inEnv.server.code)).orphan).toBe(false);
  });

  it("un nome non valido dà invalid anche senza ambiente, e non scrive", async () => {
    as("p-roberta");
    await expect(servers.createServer({ name: "  ", environmentId: null })).rejects.toThrow(
      "invalid: name",
    );
    expect(state.servers).toHaveLength(4);
    expect(state.changelog.filter((c) => c.kind === "server.created")).toEqual([]);
  });

  it("30d e 90d: al più METRIC_POINTS_MAX punti, e il primo di 90d ha più di 89 giorni", async () => {
    as("p-marco");
    const now = Date.parse("2026-10-30T12:00:00Z");
    for (const [range, days] of [
      ["30d", 29],
      ["90d", 89],
    ] as const) {
      const m = await servers.getServerMetrics("SRV-1", range);
      expect(m.points.length).toBeLessThanOrEqual(METRIC_POINTS_MAX);
      expect(m.truncated).toBe(true);
      expect(now - Date.parse(m.points[0]!.ts)).toBeGreaterThan(days * 86_400_000);
    }
    const week = await servers.getServerMetrics("SRV-1", "7d");
    expect(week.points.length).toBeLessThanOrEqual(METRIC_POINTS_MAX);
  });
});

describe("area 9b, Task 7: le scritture dei server scrivono la loro voce", () => {
  const entries = () => state.changelog.filter((c) => c.kind.startsWith("server."));
  const last = () => entries().at(-1)!;
  const sshEntries = () => entries().filter((c) => c.kind === "server.ssh_access_changed");

  it("createServer: voce con scope orphan o project, e l'id dell'oggetto è il codice", async () => {
    as("p-roberta");
    await servers.createServer({ name: "orfano", environmentId: null });
    expect(last()).toMatchObject({
      kind: "server.created",
      actorId: "p-roberta",
      projectId: null,
      object: { type: "server", id: "SRV-5" },
      params: { scope: "orphan" },
    });
    await servers.createServer({ name: "in-aud", environmentId: "env-aud-staging" });
    expect(last()).toMatchObject({
      kind: "server.created",
      object: { id: "SRV-6" },
      params: { scope: "project" },
    });
  });

  it("regenerateAgentKey, updateServer, setThresholds, controlli, deleteServer: una voce ciascuno, mai la chiave", async () => {
    as("p-roberta");
    const { agentKey } = await servers.regenerateAgentKey("SRV-2");
    expect(last()).toMatchObject({ kind: "server.agent_key_regenerated", object: { id: "SRV-2" } });
    expect(JSON.stringify(entries())).not.toContain(agentKey);
    expect(JSON.stringify(entries())).not.toMatch(AGENT_KEY_RE);

    await servers.updateServer("SRV-2", { name: "db-stw-02", sampleIntervalSeconds: 60 });
    expect(last()).toMatchObject({ kind: "server.updated", object: { id: "SRV-2" } });
    expect(JSON.parse(last().before!)).toEqual({ name: "db-stw-01", sampleInterval: "30" });
    expect(JSON.parse(last().after!)).toEqual({ name: "db-stw-02", sampleInterval: "60" });

    const n = entries().length;
    await servers.updateServer("SRV-2", { name: "db-stw-02" });
    expect(entries()).toHaveLength(n);

    await servers.setThresholds("SRV-2", {
      cpuPct: 50,
      memPct: server("SRV-2")!.thresholds.memPct,
      diskPct: server("SRV-2")!.thresholds.diskPct,
      sustainedMinutes: server("SRV-2")!.thresholds.sustainedMinutes,
    });
    expect(last()).toMatchObject({ kind: "server.thresholds_changed", object: { id: "SRV-2" } });
    expect(JSON.parse(last().before!)).toEqual({ cpu: "95" });
    expect(JSON.parse(last().after!)).toEqual({ cpu: "50" });

    const check = await servers.createCheck("SRV-2", {
      name: "HTTP /health",
      type: "http",
      target: "https://x/health",
      intervalSeconds: 60,
      enabled: true,
    });
    expect(last()).toMatchObject({
      kind: "server.check_changed",
      object: { id: "SRV-2" },
      params: { check: "HTTP /health" },
    });
    await servers.updateCheck(check.id, { enabled: false, intervalSeconds: 120 });
    expect(last()).toMatchObject({ params: { check: "HTTP /health" } });
    expect(JSON.parse(last().before!)).toEqual({ interval: "60", checkEnabled: true });
    expect(JSON.parse(last().after!)).toEqual({ interval: "120", checkEnabled: false });
    await servers.deleteCheck(check.id);
    expect(last()).toMatchObject({
      kind: "server.check_changed",
      params: { check: "HTTP /health" },
    });

    await servers.deleteServer("SRV-2");
    expect(last()).toMatchObject({ kind: "server.deleted", object: { id: "SRV-2" } });
  });

  it("accesso SSH: collega, rigenera, revoca scrivono; verifica solo se lo stato cambia; mai le chiavi", async () => {
    as("p-roberta");
    await servers.linkSshAccess("SRV-2");
    expect(sshEntries()).toHaveLength(1);
    expect(last()).toMatchObject({ kind: "server.ssh_access_changed", object: { id: "SRV-2" } });
    // La prima verifica porta l'accesso a «verificato»: cambia lo stato.
    await servers.verifySshAccess("SRV-2");
    expect(sshEntries()).toHaveLength(2);
    // Una seconda verifica nello stesso stato non cambia niente: nessuna voce.
    await servers.verifySshAccess("SRV-2");
    expect(sshEntries()).toHaveLength(2);
    await servers.regenerateSshAccess("SRV-2");
    expect(sshEntries()).toHaveLength(3);
    await servers.revokeSshAccess("SRV-2");
    expect(sshEntries()).toHaveLength(4);
    expect(JSON.stringify(entries())).not.toMatch(/ssh-ed25519|PRIVATE KEY/);
  });

  it("una scrittura rifiutata non scrive la voce (forbidden, not_found, invalid)", async () => {
    as("p-laura");
    await expect(servers.updateServer("SRV-3", { name: "x" })).rejects.toThrow("forbidden");
    await expect(servers.regenerateAgentKey("SRV-3")).rejects.toThrow("forbidden");
    as("p-roberta");
    await expect(servers.updateServer("SRV-2", { sampleIntervalSeconds: 5 })).rejects.toThrow(
      "invalid",
    );
    await expect(servers.deleteServer("SRV-99")).rejects.toThrow("not_found");
    await expect(servers.linkSshAccess("SRV-1")).rejects.toThrow("invalid: state");
    expect(entries()).toEqual([]);
  });
});
