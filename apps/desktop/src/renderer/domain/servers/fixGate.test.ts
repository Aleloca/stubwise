import { describe, expect, it } from "vitest";
import type { Conversation, ConversationEvent } from "../../data/model";
import { makeTask } from "../fixtures";
import { ev, hoursAgo, serverTask } from "./fixtures";
import {
  fixCommandsBeforeApproval,
  fixStartBlock,
  fixSteps,
  serverFixStatus,
  serverTaskState,
} from "./fixGate";

describe("fixStartBlock", () => {
  const base = {
    hasOperate: true,
    task: serverTask(),
    serverInProject: true,
    operationsOn: true,
    liveRun: false,
    serverBusy: false,
  };

  it("server tolto dal progetto → server_gone, prima della task chiusa e delle operazioni", () => {
    expect(fixStartBlock({ ...base, serverInProject: false })).toBe("server_gone");
    expect(
      fixStartBlock({
        ...base,
        serverInProject: false,
        task: serverTask({ closedAt: hoursAgo(1) }),
        operationsOn: false,
      }),
    ).toBe("server_gone");
  });

  it("un'altra correzione viva sullo stesso server → server_busy", () => {
    expect(fixStartBlock({ ...base, serverBusy: true })).toBe("server_busy");
    expect(fixStartBlock({ ...base, serverBusy: true, liveRun: true })).toBe("run_live");
  });

  it("nessun blocco con le due condizioni e le operazioni accese", () => {
    expect(fixStartBlock(base)).toBeNull();
  });

  it("ogni motivo", () => {
    expect(fixStartBlock({ ...base, hasOperate: false })).toBe("no_permission");
    expect(fixStartBlock({ ...base, task: makeTask() })).toBe("not_server_task");
    expect(fixStartBlock({ ...base, task: serverTask({ closedAt: hoursAgo(1) }) })).toBe("closed");
    expect(fixStartBlock({ ...base, liveRun: true })).toBe("run_live");
    // La correzione passa dall'AGENTE (F4b): senza le operazioni non parte.
    expect(fixStartBlock({ ...base, operationsOn: false })).toBe("operations_off");
  });

  it("il permesso viene prima di tutto", () => {
    expect(
      fixStartBlock({
        hasOperate: false,
        task: makeTask(),
        serverInProject: false,
        operationsOn: false,
        liveRun: true,
        serverBusy: true,
      }),
    ).toBe("no_permission");
  });
});

const STEPS = [
  {
    action: "container.restart",
    params: { container: "api", timeoutSeconds: 30 },
    why: "It is stuck.",
  },
  { action: "docker.prune", params: { what: "images_unused" }, why: "The disk is full." },
] as const;
const plan = (
  status: "pending" | "approved" | "rejected" | "pre_approved",
  extra: { id?: string; decidedById?: string; instructions?: string } = {},
) =>
  ({
    ...ev({ type: "plan", planText: "p", summary: "s", status, serverPlan: { steps: [...STEPS] } }),
    ...extra,
  }) as Extract<ConversationEvent, { type: "plan" }>;
const approved = (id = "plan-1") => plan("approved", { id, decidedById: "p-laura" });
/** Un comando che CAMBIA, via agente, coperto (o no) dal piano `approvalId`. */
const fixCmd = (
  approvalId: string | null = "plan-1",
  state: "done" | "running" | "failed" = "done",
) =>
  ev({
    type: "action",
    tool: "server.fix",
    label: "fix",
    input: "container.restart container=api timeoutSeconds=30",
    state,
    serverCommand: {
      action: "container.restart",
      params: { container: "api", timeoutSeconds: 30 },
      kind: "change",
      via: "agent",
      approvalId,
      exitCode: state === "failed" ? 1 : 0,
    },
  });
const readCmd = () =>
  ev({
    type: "action",
    tool: "server.read",
    label: "read",
    input: "uptime",
    state: "done",
    serverCommand: {
      action: "uptime",
      params: {},
      kind: "read",
      via: "ssh",
      approvalId: null,
      exitCode: 0,
    },
  });

describe("fixCommandsBeforeApproval", () => {
  it("conta un server.fix dopo un pre_approved", () => {
    expect(fixCommandsBeforeApproval([readCmd(), plan("pre_approved"), fixCmd()])).toBe(1);
  });

  it("conta un server.fix dopo un rejected", () => {
    expect(
      fixCommandsBeforeApproval([plan("rejected", { decidedById: "p-laura" }), fixCmd()]),
    ).toBe(1);
  });

  it("un approved deciso da Claude non vale: non è una persona", () => {
    expect(
      fixCommandsBeforeApproval([plan("approved", { decidedById: "p-claude" }), fixCmd()]),
    ).toBe(1);
  });

  it("zero dopo un approved deciso da una persona", () => {
    expect(fixCommandsBeforeApproval([readCmd(), approved(), fixCmd(), fixCmd()])).toBe(0);
  });

  it("un approved senza chi l'ha deciso non vale; senza piano conta", () => {
    expect(fixCommandsBeforeApproval([plan("approved"), fixCmd()])).toBe(1);
    expect(fixCommandsBeforeApproval([fixCmd(), fixCmd()])).toBe(2);
  });

  it("un piano nuovo dopo l'approvazione rimette il cancello", () => {
    expect(fixCommandsBeforeApproval([approved(), fixCmd(), plan("pending"), fixCmd()])).toBe(1);
  });

  it("le letture non contano", () => {
    expect(fixCommandsBeforeApproval([readCmd(), readCmd()])).toBe(0);
  });

  it("un comando che cambia conta anche fuori da `server.fix`, e vale solo il SUO piano", () => {
    const sneaky = { ...fixCmd(), tool: "server.read" } as ConversationEvent;
    expect(fixCommandsBeforeApproval([sneaky])).toBe(1);
    // Coperto da un'approvazione che non è quella del piano davanti: non vale.
    expect(fixCommandsBeforeApproval([approved("plan-1"), fixCmd("plan-0")])).toBe(1);
    expect(fixCommandsBeforeApproval([approved("plan-1"), fixCmd(null)])).toBe(1);
  });
});

describe("fixSteps e serverFixStatus (i concetti di `serverFixViewSchema`)", () => {
  const t = serverTask();
  const run = (c: Partial<Conversation>, events: ConversationEvent[]) => ({ c: conv(c), events });

  it("i passi del piano con lo stato di ognuno", () => {
    expect(fixSteps(null)).toEqual([]);
    expect(fixSteps(run({}, [plan("pending", { id: "plan-1" })])).map((s) => s.status)).toEqual([
      "waiting",
      "waiting",
    ]);
    expect(
      fixSteps(run({}, [approved(), fixCmd("plan-1", "running")])).map((s) => [s.index, s.status]),
    ).toEqual([
      [0, "running"],
      [1, "waiting"],
    ]);
    expect(fixSteps(run(finished("stopped"), [approved(), fixCmd()])).map((s) => s.status)).toEqual(
      ["done", "skipped"],
    );
    expect(
      fixSteps(run(finished("failed"), [approved(), fixCmd("plan-1", "failed")])).map(
        (s) => s.status,
      ),
    ).toEqual(["failed", "skipped"]);
    expect(fixSteps(run({}, [approved()]))[0]).toMatchObject({
      action: "container.restart",
      params: { container: "api", timeoutSeconds: 30 },
      why: "It is stuck.",
    });
  });

  it("lo stato della correzione", () => {
    expect(serverFixStatus(t, null)).toBe("none");
    expect(serverFixStatus(t, run({}, [readCmd()]))).toBe("proposing");
    expect(serverFixStatus(t, run({ state: "awaiting_approval" }, [plan("pending")]))).toBe(
      "awaiting_approval",
    );
    expect(serverFixStatus(t, run({}, [approved()]))).toBe("approved");
    expect(serverFixStatus(t, run({}, [approved(), fixCmd()]))).toBe("running");
    expect(serverFixStatus(t, run(finished("ok"), [approved(), fixCmd(), check(true)]))).toBe(
      "done",
    );
    expect(
      serverFixStatus(t, run(finished("stopped"), [plan("rejected", { decidedById: "p-laura" })])),
    ).toBe("rejected");
    expect(serverFixStatus(t, run(finished("stopped"), [approved(), fixCmd()]))).toBe("stopped");
    expect(serverFixStatus(t, run(finished("failed"), [approved(), fixCmd()]))).toBe("failed");
    // Nessun piano possibile con le azioni ammesse: finita senza piano.
    expect(serverFixStatus(t, run(finished("ok"), [readCmd()]))).toBe("failed");
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
const check = (resolved?: boolean) =>
  ev({
    type: "work_result",
    kind: "server_check",
    text: "memory at 41%",
    ...(resolved === undefined ? {} : { resolved }),
  });
const finished = (outcome: Conversation["outcome"]) =>
  ({ state: "finished", outcome }) satisfies Partial<Conversation>;

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
      serverTaskState(t, run(finished("stopped"), [plan("rejected", { decidedById: "p-laura" })])),
    ).toBe("plan_rejected");
    expect(serverTaskState(t, run({}, [approved(), fixCmd()]))).toBe("fixing");
    expect(serverTaskState(t, run(finished("stopped"), [approved(), fixCmd()]))).toBe("stopped");
    expect(serverTaskState(t, run(finished("ok"), [approved(), fixCmd(), check(true)]))).toBe(
      "resolved",
    );
    expect(serverTaskState(t, run(finished("ok"), [approved(), fixCmd(), check(false)]))).toBe(
      "not_resolved",
    );
    // Nessuna azione dell'insieme chiuso serve: Claude chiude senza piano.
    expect(serverTaskState(t, run(finished("ok"), [readCmd()]))).toBe("no_plan");
  });

  it("R-L3: decide il campo del controllo, non l'esito della sessione", () => {
    // Un controllo «risolto» in una sessione che poi si chiude male resta risolto…
    expect(serverTaskState(t, run(finished("failed"), [approved(), fixCmd(), check(true)]))).toBe(
      "resolved",
    );
    // …e una sessione finita bene o male SENZA controllo non afferma un esito.
    expect(serverTaskState(t, run(finished("ok"), [approved(), fixCmd()]))).toBe("stopped");
    expect(serverTaskState(t, run(finished("failed"), [approved(), fixCmd()]))).toBe("stopped");
    expect(serverTaskState(t, run(finished("timed_out"), [approved(), fixCmd()]))).toBe("stopped");
    // Un `server_check` senza il campo non vale come esito.
    expect(serverTaskState(t, run(finished("ok"), [approved(), fixCmd(), check()]))).toBe(
      "stopped",
    );
    // Il controllo arriva prima che la sessione si chiuda: vale già.
    expect(serverTaskState(t, run({}, [approved(), fixCmd(), check(false)]))).toBe("not_resolved");
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
        run(finished("stopped"), [plan("rejected", { decidedById: "p-laura", instructions: "x" })]),
      ),
    ).toBe("stopped");
  });

  it("una task chiusa resta chiusa anche con una correzione", () => {
    expect(serverTaskState(serverTask({ closedAt: hoursAgo(1) }), run({}, [fixCmd()]))).toBe(
      "closed",
    );
  });
});
