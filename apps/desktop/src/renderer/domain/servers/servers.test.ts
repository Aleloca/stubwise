import { describe, expect, it } from "vitest";
import type {
  Conversation,
  ConversationEvent,
  EventDraft,
  MetricPoint,
  MonitoredServer,
  ProjectEnvironment,
  ServerAnalysis,
  ServerEpisode,
  ServerSshAccess,
  Task,
} from "../../data/model";
import { SERVER_CONVERSATIONS } from "../../data/seed/servers/analysis";
import { fakeSshPublicKey } from "../../data/seed/servers/access";
import { makeTask } from "../fixtures";
import { isReadCommand, READ_COMMANDS, truncateOutput } from "./commands";
import { fixCommandsBeforeApproval, fixStartBlock, serverTaskState } from "./fixGate";
import { serverHealth, serverWork } from "./health";
import {
  COMMAND_OUTPUT_MAX_LINES,
  METRIC_POINTS_MAX,
  RECOVERED_SHOWN_HOURS,
  ANALYSIS_MAX_COST_USD,
  ANALYSIS_MAX_MINUTES,
} from "./limits";
import { downsample } from "./metrics";
import { alertProjectsOf, analysisProjectOf } from "./projects";
import { accessState, accessUsable, verifyFailure } from "./sshAccess";

const NOW = "2026-10-29T12:00:00Z";
const hoursAgo = (h: number) => new Date(Date.parse(NOW) - h * 3_600_000).toISOString();

describe("limiti", () => {
  it("sono quelli del piano", () => {
    expect(ANALYSIS_MAX_MINUTES).toBe(20);
    expect(ANALYSIS_MAX_COST_USD).toBe(2);
    expect(COMMAND_OUTPUT_MAX_LINES).toBe(40);
    expect(RECOVERED_SHOWN_HOURS).toBe(24);
    expect(METRIC_POINTS_MAX).toBe(300);
  });
});

// --- salute ------------------------------------------------------------------

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

// --- lavoro --------------------------------------------------------------------

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
const serverTask = (over: Partial<Task> = {}) =>
  makeTask({ source: "server", serverRef: { serverCode: "SRV-9", episodeId: "ep" }, ...over });

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

// --- accessi SSH ---------------------------------------------------------------

const pair = (generation: number) => ({
  read: fakeSshPublicKey("SRV-9", "read", generation, hoursAgo(10)),
  fix: fakeSshPublicKey("SRV-9", "fix", generation, hoursAgo(10)),
});
const ok = (ofPending = false) => ({
  at: hoursAgo(1),
  read: "ok" as const,
  fix: "ok" as const,
  reason: null,
  ofPending,
});
const access = (over: Partial<ServerSshAccess> = {}): ServerSshAccess => ({
  serverCode: "SRV-9",
  keys: pair(1),
  pending: null,
  verification: ok(),
  lastUse: {},
  revokedAt: null,
  ...over,
});

const STATES = {
  not_linked: undefined,
  awaiting_command: access({ keys: null, pending: pair(1), verification: null }),
  verified: access(),
  verify_failed: access({
    verification: {
      at: hoursAgo(1),
      read: "ok",
      fix: "failed",
      reason: "Permission denied (publickey)",
      ofPending: false,
    },
  }),
  read_writes: access({
    verification: {
      at: hoursAgo(1),
      read: "writes",
      fix: "ok",
      reason: "sudo -n true succeeded",
      ofPending: false,
    },
  }),
  regenerating: access({ pending: pair(2) }),
  revoked: access({ keys: null, pending: null, verification: null, revokedAt: hoursAgo(1) }),
} as const;

describe("accessState e accessUsable", () => {
  it("i sette stati", () => {
    for (const [state, a] of Object.entries(STATES)) {
      expect(accessState(a), state).toBe(state);
    }
  });

  it("chi è usabile in ogni stato", () => {
    const usable = (a: ServerSshAccess | undefined) => [
      accessUsable(a, "read"),
      accessUsable(a, "fix"),
    ];
    expect(usable(STATES.not_linked)).toEqual([false, false]);
    expect(usable(STATES.awaiting_command)).toEqual([false, false]);
    expect(usable(STATES.verified)).toEqual([true, true]);
    expect(usable(STATES.verify_failed)).toEqual([true, false]);
    // Scelta del piano: una lettura che scrive spegne ENTRAMBI.
    expect(usable(STATES.read_writes)).toEqual([false, false]);
    // Rigenerazione: le vecchie restano usabili finché le nuove non sono verificate.
    expect(usable(STATES.regenerating)).toEqual([true, true]);
    expect(usable(STATES.revoked)).toEqual([false, false]);
  });

  it("verify_failed dice quale accesso e perché", () => {
    expect(verifyFailure(STATES.verify_failed)).toEqual({
      read: false,
      fix: true,
      reason: "Permission denied (publickey)",
    });
    expect(verifyFailure(STATES.verified)).toBeNull();
  });

  it("la prima verifica fallita (chiavi in attesa) → verify_failed, niente di usabile", () => {
    const a = access({
      keys: null,
      pending: pair(1),
      verification: {
        at: hoursAgo(1),
        read: "failed",
        fix: "failed",
        reason: "Connection timed out",
        ofPending: true,
      },
    });
    expect(accessState(a)).toBe("verify_failed");
    expect(accessUsable(a, "read")).toBe(false);
    expect(verifyFailure(a)).toEqual({ read: true, fix: true, reason: "Connection timed out" });
  });

  it("rigenerazione con verifica delle nuove fallita: le vecchie restano usabili", () => {
    const a = access({
      pending: pair(2),
      verification: { at: hoursAgo(1), read: "failed", fix: "ok", reason: "x", ofPending: true },
    });
    expect(accessState(a)).toBe("verify_failed");
    expect(accessUsable(a, "read")).toBe(true);
    expect(accessUsable(a, "fix")).toBe(true);
  });

  it("rigenerazione con le nuove che scrivono: nessuno dei due", () => {
    const a = access({
      pending: pair(2),
      verification: { at: hoursAgo(1), read: "writes", fix: "ok", reason: "x", ofPending: true },
    });
    expect(accessState(a)).toBe("read_writes");
    expect([accessUsable(a, "read"), accessUsable(a, "fix")]).toEqual([false, false]);
  });

  it("ricollegato dopo la revoca → in attesa del comando", () => {
    const a = access({ keys: null, pending: pair(2), verification: null, revokedAt: hoursAgo(5) });
    expect(accessState(a)).toBe("awaiting_command");
  });
});

// --- comandi -------------------------------------------------------------------

describe("isReadCommand", () => {
  it("vero per ogni READ_COMMANDS, anche con argomenti", () => {
    for (const cmd of READ_COMMANDS) {
      expect(isReadCommand(cmd), cmd).toBe(true);
      expect(isReadCommand(`${cmd} x`), cmd).toBe(true);
    }
  });

  it("falso per ciò che scrive o non è di lettura", () => {
    for (const cmd of [
      "docker inspect x",
      "sudo docker inspect x",
      "docker restart x",
      "sudo docker restart x",
      "rm -rf /tmp/x",
      "sudo -n true",
      "sudo journalctl --vacuum-size=1M",
      "sudo journalctl --rotate",
      "uptime; rm -rf /",
      "ps aux | sh",
      "df -h && reboot",
      "free $(reboot)",
      "freeze",
      "psql",
      "sudo systemctl restart docker",
      "",
    ]) {
      expect(isReadCommand(cmd), cmd).toBe(false);
    }
  });

  it("accetta ogni comando della sessione d'analisi del seme", () => {
    const inputs = SERVER_CONVERSATIONS.flatMap((s) => s.events)
      .filter((e): e is Extract<ConversationEvent, { type: "action" }> => e.type === "action")
      .map((e) => e.input ?? "");
    expect(inputs.length).toBeGreaterThanOrEqual(6);
    for (const input of inputs) expect(isReadCommand(input), input).toBe(true);
  });
});

describe("truncateOutput", () => {
  it("5000 righe → le ultime 40, troncato", () => {
    const text = Array.from({ length: 5000 }, (_, i) => `line ${i + 1}`).join("\n");
    const out = truncateOutput(text);
    expect(out.truncated).toBe(true);
    const lines = out.text.split("\n");
    expect(lines).toHaveLength(COMMAND_OUTPUT_MAX_LINES);
    expect(lines[0]).toBe("line 4961");
    expect(lines.at(-1)).toBe("line 5000");
  });

  it("un'uscita corta resta intera", () => {
    expect(truncateOutput("a\nb\n")).toEqual({ text: "a\nb\n", truncated: false });
    const forty = Array.from({ length: 40 }, () => "x").join("\n");
    expect(truncateOutput(forty)).toEqual({ text: forty, truncated: false });
  });
});

// --- metriche ------------------------------------------------------------------

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

// --- progetti ------------------------------------------------------------------

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

// --- correzione ----------------------------------------------------------------

describe("fixStartBlock", () => {
  const base = { hasOperate: true, task: serverTask(), access: access(), liveRun: false };

  it("nessun blocco con le due condizioni", () => {
    expect(fixStartBlock(base)).toBeNull();
  });

  it("ogni motivo", () => {
    expect(fixStartBlock({ ...base, hasOperate: false })).toBe("no_permission");
    expect(fixStartBlock({ ...base, task: makeTask() })).toBe("not_server_task");
    expect(fixStartBlock({ ...base, task: serverTask({ closedAt: hoursAgo(1) }) })).toBe("closed");
    expect(fixStartBlock({ ...base, liveRun: true })).toBe("run_live");
    expect(fixStartBlock({ ...base, access: undefined })).toBe("no_fix_access");
    expect(fixStartBlock({ ...base, access: STATES.revoked })).toBe("no_fix_access");
    expect(fixStartBlock({ ...base, access: STATES.awaiting_command })).toBe(
      "fix_access_unverified",
    );
    expect(fixStartBlock({ ...base, access: STATES.verify_failed })).toBe("fix_access_unverified");
    expect(fixStartBlock({ ...base, access: STATES.read_writes })).toBe("fix_access_unverified");
  });

  it("il permesso viene prima di tutto", () => {
    expect(
      fixStartBlock({ hasOperate: false, task: makeTask(), access: undefined, liveRun: true }),
    ).toBe("no_permission");
  });

  it("l'accesso di un altro server non vale", () => {
    expect(fixStartBlock({ ...base, access: access({ serverCode: "SRV-1" }) })).toBe(
      "no_fix_access",
    );
  });

  it("rigenerazione: le vecchie chiavi verificate bastano", () => {
    expect(fixStartBlock({ ...base, access: STATES.regenerating })).toBeNull();
  });
});

let seq = 0;
const ev = (e: EventDraft): ConversationEvent => ({ id: `e${++seq}`, at: hoursAgo(1), ...e });
const plan = (status: "pending" | "approved" | "rejected" | "pre_approved", extra: object = {}) =>
  ev({ type: "plan", planText: "p", summary: "s", status, ...extra });
const fixCmd = () =>
  ev({
    type: "action",
    tool: "server.fix",
    label: "fix",
    input: "sudo docker restart x",
    state: "done",
  });
const readCmd = () =>
  ev({ type: "action", tool: "server.read", label: "read", input: "uptime", state: "done" });

describe("fixCommandsBeforeApproval", () => {
  it("conta un server.fix dopo un pre_approved", () => {
    expect(fixCommandsBeforeApproval([readCmd(), plan("pre_approved"), fixCmd()])).toBe(1);
  });

  it("conta un server.fix dopo un rejected", () => {
    expect(
      fixCommandsBeforeApproval([plan("rejected", { decidedById: "p-laura" }), fixCmd()]),
    ).toBe(1);
  });

  it("zero dopo un approved deciso da una persona", () => {
    expect(
      fixCommandsBeforeApproval([
        readCmd(),
        plan("approved", { decidedById: "p-laura" }),
        fixCmd(),
        fixCmd(),
      ]),
    ).toBe(0);
  });

  it("un approved senza chi l'ha deciso non vale; senza piano conta", () => {
    expect(fixCommandsBeforeApproval([plan("approved"), fixCmd()])).toBe(1);
    expect(fixCommandsBeforeApproval([fixCmd(), fixCmd()])).toBe(2);
  });

  it("un piano nuovo dopo l'approvazione rimette il cancello", () => {
    expect(
      fixCommandsBeforeApproval([
        plan("approved", { decidedById: "p-laura" }),
        fixCmd(),
        plan("pending"),
        fixCmd(),
      ]),
    ).toBe(1);
  });

  it("le letture non contano", () => {
    expect(fixCommandsBeforeApproval([readCmd(), readCmd()])).toBe(0);
  });
});

const conv = (over: Partial<Conversation> = {}): Conversation =>
  ({
    id: "cv",
    kind: "task_run",
    title: "x",
    ownerId: "p-marco",
    projectId: "p1",
    contextProjectId: null,
    taskId: "t1",
    requestId: null,
    state: "working",
    outcome: null,
    visibility: "project",
    publishedAt: null,
    publishedById: null,
    touchedProjectIds: [],
    privateFromIndex: null,
    publishedProjectIds: [],
    continuesFromId: null,
    createdAt: hoursAgo(1),
    updatedAt: hoursAgo(1),
    archived: false,
    serverFix: { serverCode: "SRV-9" },
    ...over,
  }) as Conversation;
const check = () => ev({ type: "work_result", kind: "server_check", text: "memory at 41%" });

describe("serverTaskState", () => {
  const t = serverTask();
  const run = (c: Partial<Conversation>, events: ConversationEvent[]) => ({ c: conv(c), events });

  it("ogni stato", () => {
    expect(serverTaskState(serverTask({ closedAt: hoursAgo(1) }), null)).toBe("closed");
    expect(serverTaskState(t, null)).toBe("diagnosis_ready");
    expect(serverTaskState(t, run({}, [readCmd()]))).toBe("fix_planning");
    expect(
      serverTaskState(t, run({ state: "awaiting_approval" }, [readCmd(), plan("pending")])),
    ).toBe("plan_awaiting");
    expect(
      serverTaskState(
        t,
        run({ state: "finished", outcome: "stopped" }, [
          plan("rejected", { decidedById: "p-laura" }),
        ]),
      ),
    ).toBe("plan_rejected");
    expect(
      serverTaskState(t, run({}, [plan("approved", { decidedById: "p-laura" }), fixCmd()])),
    ).toBe("fixing");
    expect(
      serverTaskState(
        t,
        run({ state: "finished", outcome: "stopped" }, [
          plan("approved", { decidedById: "p-laura" }),
          fixCmd(),
        ]),
      ),
    ).toBe("stopped");
    expect(
      serverTaskState(
        t,
        run({ state: "finished", outcome: "ok" }, [
          plan("approved", { decidedById: "p-laura" }),
          fixCmd(),
          check(),
        ]),
      ),
    ).toBe("resolved");
    expect(
      serverTaskState(
        t,
        run({ state: "finished", outcome: "failed" }, [
          plan("approved", { decidedById: "p-laura" }),
          fixCmd(),
          check(),
        ]),
      ),
    ).toBe("not_resolved");
  });

  it("rifiutato con indicazioni: Claude riscrive il piano", () => {
    expect(
      serverTaskState(
        t,
        run({}, [plan("rejected", { decidedById: "p-laura", instructions: "no restart" })]),
      ),
    ).toBe("fix_planning");
  });

  it("fermato mentre riscrive dopo un rifiuto con indicazioni → stopped", () => {
    expect(
      serverTaskState(
        t,
        run({ state: "finished", outcome: "stopped" }, [
          plan("rejected", { decidedById: "p-laura", instructions: "x" }),
        ]),
      ),
    ).toBe("stopped");
  });

  it("una task chiusa resta chiusa anche con una correzione", () => {
    expect(serverTaskState(serverTask({ closedAt: hoursAgo(1) }), run({}, [fixCmd()]))).toBe(
      "closed",
    );
  });
});
