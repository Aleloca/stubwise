import { describe, expect, it } from "vitest";
import type { MonitoredServer, ServerAnalysis, ServerEpisode } from "../../data/model";
import { hoursAgo, NOW, serverTask } from "./fixtures";
import { serverHealth, serverWork } from "./health";

const server = (over: Partial<MonitoredServer> = {}): MonitoredServer => ({
  id: "srv-x",
  code: "SRV-9",
  name: "x",
  hostname: "x",
  status: "online",
  agentVersion: "1.0.0",
  lastSeenAt: hoursAgo(0),
  sampleIntervalSeconds: 30,
  thresholds: { cpuPct: 95, memPct: 90, diskPct: 90, sustainedMinutes: 5 },
  services: [],
  disks: [],
  primaryProjectId: null,
  createdAt: hoursAgo(1000),
  sshReachable: true,
  ...over,
});

const MEM = { kind: "memory" as const, valuePct: 94, thresholdPct: 90 };
const DISK = { kind: "disk" as const, valuePct: 93, thresholdPct: 90 };

const episode = (over: Partial<ServerEpisode> = {}): ServerEpisode => ({
  id: "ep-x",
  serverCode: "SRV-9",
  severity: "trouble",
  reasons: [MEM],
  startedAt: hoursAgo(3),
  recoveredAt: null,
  analysisId: null,
  ...over,
});

describe("serverHealth", () => {
  it("in salute senza episodi", () => {
    expect(serverHealth(server(), [], NOW)).toEqual({
      health: "healthy",
      since: null,
      reasons: [],
    });
  });

  it("mai collegato → never_connected, non in salute (R-L4)", () => {
    const s = server({ status: "never_connected", lastSeenAt: null, agentVersion: null });
    expect(serverHealth(s, [], NOW)).toEqual({
      health: "never_connected",
      since: null,
      reasons: [],
    });
  });

  it("offline senza episodio → down, da quando l'agente tace", () => {
    const lastSeen = hoursAgo(2);
    const h = serverHealth(server({ status: "offline", lastSeenAt: lastSeen }), [], NOW);
    expect(h.health).toBe("down");
    expect(h.since).toBe(lastSeen);
    expect(h.reasons).toEqual([{ kind: "agent_silent", since: lastSeen }]);
  });

  it("un episodio aperto `down` → down", () => {
    const e = episode({
      severity: "down",
      reasons: [{ kind: "agent_silent", since: hoursAgo(1) }],
      startedAt: hoursAgo(1),
    });
    const h = serverHealth(server(), [e], NOW);
    expect(h).toEqual({ health: "down", since: e.startedAt, reasons: e.reasons });
  });

  it("un episodio aperto `trouble` → trouble, coi motivi di tutti gli aperti", () => {
    const a = episode({ id: "a", startedAt: hoursAgo(3) });
    const b = episode({ id: "b", reasons: [DISK], startedAt: hoursAgo(1) });
    const h = serverHealth(server(), [b, a], NOW);
    expect(h.health).toBe("trouble");
    expect(h.since).toBe(a.startedAt);
    expect(h.reasons).toEqual([MEM, DISK]);
  });

  it("rientrato da 23 h → recovered; da 25 h → healthy", () => {
    const e23 = episode({ startedAt: hoursAgo(26), recoveredAt: hoursAgo(23) });
    expect(serverHealth(server(), [e23], NOW)).toEqual({
      health: "recovered",
      since: e23.recoveredAt,
      reasons: [MEM],
    });
    const e25 = episode({ startedAt: hoursAgo(26), recoveredAt: hoursAgo(25) });
    expect(serverHealth(server(), [e25], NOW).health).toBe("healthy");
  });

  it("conta solo l'ultimo rientro, e un episodio aperto prevale", () => {
    const old = episode({ id: "old", startedAt: hoursAgo(40), recoveredAt: hoursAgo(30) });
    const recent = episode({
      id: "new",
      reasons: [DISK],
      startedAt: hoursAgo(5),
      recoveredAt: hoursAgo(4),
    });
    expect(serverHealth(server(), [recent, old], NOW).reasons).toEqual([DISK]);
    const open = episode({ id: "open", startedAt: hoursAgo(1) });
    expect(serverHealth(server(), [recent, open], NOW).health).toBe("trouble");
  });

  it("ignora gli episodi di un altro server", () => {
    expect(serverHealth(server(), [episode({ serverCode: "SRV-1" })], NOW).health).toBe("healthy");
  });
});

const analysis = (outcome: ServerAnalysis["outcome"]): ServerAnalysis => ({
  id: "an",
  serverCode: "SRV-9",
  episodeId: "ep",
  projectId: "p1",
  conversationId: "cv",
  outcome,
  taskId: null,
  startedAt: hoursAgo(1),
  endedAt: outcome === "running" ? null : hoursAgo(0),
});

describe("serverWork", () => {
  it("nessun lavoro", () => {
    expect(serverWork({ analyses: [analysis("diagnosed")], serverTasks: [] })).toBe("none");
    expect(
      serverWork({
        analyses: [],
        serverTasks: [{ task: serverTask({ closedAt: hoursAgo(1) }), liveFix: false }],
      }),
    ).toBe("none");
  });

  it("diagnosi pronta: una task di server aperta", () => {
    expect(
      serverWork({ analyses: [], serverTasks: [{ task: serverTask(), liveFix: false }] }),
    ).toBe("diagnosis_ready");
  });

  it("precedenza fixing > analyzing > diagnosis_ready", () => {
    const open = { task: serverTask(), liveFix: false };
    const live = { task: serverTask({ id: "t2" }), liveFix: true };
    expect(serverWork({ analyses: [analysis("running")], serverTasks: [open] })).toBe("analyzing");
    expect(serverWork({ analyses: [analysis("running")], serverTasks: [open, live] })).toBe(
      "fixing",
    );
  });
});
