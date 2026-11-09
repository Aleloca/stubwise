import { describe, expect, it } from "vitest";
import type { Conversation, ConversationEvent } from "../../data/model";
import { makeTask } from "../fixtures";
import { access, ev, hoursAgo, serverTask, STATES } from "./fixtures";
import { fixCommandsBeforeApproval, fixStartBlock, serverTaskState } from "./fixGate";

describe("fixStartBlock", () => {
  const base = {
    hasOperate: true,
    task: serverTask(),
    serverInProject: true,
    access: access(),
    liveRun: false,
    serverBusy: false,
  };

  it("server tolto dal progetto → server_gone, prima della task chiusa e dell'accesso", () => {
    expect(fixStartBlock({ ...base, serverInProject: false })).toBe("server_gone");
    expect(
      fixStartBlock({
        ...base,
        serverInProject: false,
        task: serverTask({ closedAt: hoursAgo(1) }),
        access: undefined,
      }),
    ).toBe("server_gone");
  });

  it("un'altra correzione viva sullo stesso server → server_busy", () => {
    expect(fixStartBlock({ ...base, serverBusy: true })).toBe("server_busy");
    expect(fixStartBlock({ ...base, serverBusy: true, liveRun: true })).toBe("run_live");
  });

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
      fixStartBlock({
        hasOperate: false,
        task: makeTask(),
        serverInProject: false,
        access: undefined,
        liveRun: true,
        serverBusy: true,
      }),
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

const plan = (status: "pending" | "approved" | "rejected" | "pre_approved", extra: object = {}) =>
  ev({ type: "plan", planText: "p", summary: "s", status, ...extra });
const approved = () => plan("approved", { decidedById: "p-laura" });
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
