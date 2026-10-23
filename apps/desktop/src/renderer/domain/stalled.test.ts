import { describe, expect, it } from "vitest";
import type { DecisionRequest, Task } from "../data/model";
import { familyOfStub, makeTask } from "./fixtures";
import { stallOf, type StallContext } from "./stalled";

const decision = (over: Partial<DecisionRequest> = {}): DecisionRequest => ({
  id: "d1",
  taskId: "t1",
  askedById: "u2",
  askedOfId: "u3",
  question: "?",
  options: [],
  createdAt: "2026-10-20T10:00:00Z",
  withdrawnAt: null,
  answer: null,
  ...over,
});

function ctx(over: Partial<StallContext> = {}, tasks: Task[] = []): StallContext {
  return {
    family: "active",
    openDecisions: [],
    tasksById: new Map(tasks.map((t) => [t.id, t])),
    familyOf: familyOfStub,
    thresholds: { activeDays: 7, todoDays: 14 },
    ...over,
  };
}

describe("stallOf", () => {
  it("una task in regola non è ferma", () => {
    expect(stallOf(makeTask(), ctx())).toBeNull();
  });

  it("una task chiusa non è mai ferma, qualunque causa abbia", () => {
    const t = makeTask({
      statusId: "s-closed",
      claude: "awaiting_answer",
      assigneeId: null,
      manualStall: { reason: "r", note: "n", since: "2026-10-01", byId: "u1" },
    });
    expect(stallOf(t, ctx({ family: "closed", openDecisions: [decision()] }))).toBeNull();
  });

  it("manuale: prende reason e note, since è quello dichiarato", () => {
    const t = makeTask({
      manualStall: {
        reason: "Aspetta il cliente",
        note: "mail inviata",
        since: "2026-10-18",
        byId: "u1",
      },
    });
    expect(stallOf(t, ctx())).toEqual({
      reason: { kind: "manual", reason: "Aspetta il cliente", note: "mail inviata" },
      since: "2026-10-18",
      days: 5,
    });
  });

  it("decisione: la più vecchia aperta, con la persona interpellata", () => {
    const s = stallOf(
      makeTask(),
      ctx({
        openDecisions: [
          decision({ id: "d2", createdAt: "2026-10-22T10:00:00Z", askedOfId: "u9" }),
          decision({ id: "d1", createdAt: "2026-10-20T10:00:00Z", askedOfId: "u3" }),
        ],
      }),
    );
    expect(s).toEqual({
      reason: { kind: "decision", personId: "u3" },
      since: "2026-10-20T10:00:00Z",
      days: 3,
    });
  });

  it("una decisione ritirata, risposta o di un'altra task non ferma", () => {
    const answered = decision({
      answer: { optionIndex: 0, text: null, at: "2026-10-21", byId: "u3" },
    });
    const withdrawn = decision({ withdrawnAt: "2026-10-21T00:00:00Z" });
    const other = decision({ taskId: "altra" });
    expect(stallOf(makeTask(), ctx({ openDecisions: [answered, withdrawn, other] }))).toBeNull();
  });

  it("domanda di Claude", () => {
    const t = makeTask({ claude: "awaiting_answer", lastActivityAt: "2026-10-21T08:00:00Z" });
    expect(stallOf(t, ctx())).toEqual({
      reason: { kind: "claude_question" },
      since: "2026-10-21T08:00:00Z",
      days: 2,
    });
  });

  it("bloccata da una task aperta sì, da una chiusa o inesistente no", () => {
    const blocker = makeTask({ id: "b1", statusId: "s-active" });
    const closed = makeTask({ id: "b2", statusId: "s-closed" });
    const t = makeTask({ links: [{ kind: "blocked_by", taskId: "b1" }] });
    expect(stallOf(t, ctx({}, [blocker]))?.reason).toEqual({ kind: "blocked_by", taskId: "b1" });
    const t2 = makeTask({
      links: [
        { kind: "blocked_by", taskId: "b2" },
        { kind: "blocked_by", taskId: "nope" },
        { kind: "blocks", taskId: "b1" },
      ],
    });
    expect(stallOf(t2, ctx({}, [blocker, closed]))).toBeNull();
  });

  it("senza assegnatario: ferma se attiva o pianificata entro questa settimana", () => {
    const active = makeTask({ assigneeId: null, lastActivityAt: "2026-10-22T08:00:00Z" });
    expect(stallOf(active, ctx())?.reason).toEqual({ kind: "unassigned" });
    expect(stallOf(active, ctx())?.since).toBe("2026-10-22T08:00:00Z");

    const todoNow = makeTask({ statusId: "s-todo", assigneeId: null, plannedWeek: "2026-W43" });
    expect(stallOf(todoNow, ctx({ family: "todo" }))?.reason).toEqual({ kind: "unassigned" });
    const todoPast = makeTask({ statusId: "s-todo", assigneeId: null, plannedWeek: "2026-W40" });
    expect(stallOf(todoPast, ctx({ family: "todo" }))?.reason).toEqual({ kind: "unassigned" });
    const todoFuture = makeTask({ statusId: "s-todo", assigneeId: null, plannedWeek: "2026-W44" });
    expect(stallOf(todoFuture, ctx({ family: "todo" }))).toBeNull();
    const todoNoPlan = makeTask({ statusId: "s-todo", assigneeId: null });
    expect(stallOf(todoNoPlan, ctx({ family: "todo" }))).toBeNull();
  });

  it("inattiva: active oltre activeDays", () => {
    const old = makeTask({ lastActivityAt: "2026-10-15T09:00:00Z" });
    expect(stallOf(old, ctx())).toEqual({
      reason: { kind: "idle" },
      since: "2026-10-15T09:00:00Z",
      days: 8,
    });
    const fresh = makeTask({ lastActivityAt: "2026-10-16T09:00:00Z" });
    expect(stallOf(fresh, ctx())).toBeNull();
  });

  it("inattiva: todo solo se già slittata e oltre todoDays", () => {
    const base = { statusId: "s-todo", lastActivityAt: "2026-10-01T09:00:00Z" };
    expect(stallOf(makeTask({ ...base, slipCount: 0 }), ctx({ family: "todo" }))).toBeNull();
    expect(stallOf(makeTask({ ...base, slipCount: 1 }), ctx({ family: "todo" }))?.reason).toEqual({
      kind: "idle",
    });
    const recent = makeTask({
      statusId: "s-todo",
      slipCount: 2,
      lastActivityAt: "2026-10-15T09:00:00Z",
    });
    expect(stallOf(recent, ctx({ family: "todo" }))).toBeNull();
  });

  it("precedenza: manual > decision > claude_question > blocked_by > unassigned > idle", () => {
    const blocker = makeTask({ id: "b1" });
    const all = makeTask({
      assigneeId: null,
      claude: "awaiting_answer",
      lastActivityAt: "2026-10-01T09:00:00Z",
      links: [{ kind: "blocked_by", taskId: "b1" }],
      manualStall: { reason: "r", note: "n", since: "2026-10-10", byId: "u1" },
    });
    const c = ctx({ openDecisions: [decision()] }, [blocker]);
    expect(stallOf(all, c)?.reason.kind).toBe("manual");
    expect(stallOf({ ...all, manualStall: null }, c)?.reason.kind).toBe("decision");
    expect(stallOf({ ...all, manualStall: null }, { ...c, openDecisions: [] })?.reason.kind).toBe(
      "claude_question",
    );
    expect(
      stallOf({ ...all, manualStall: null, claude: "none" }, { ...c, openDecisions: [] })?.reason
        .kind,
    ).toBe("blocked_by");
    expect(
      stallOf({ ...all, manualStall: null, claude: "none", links: [] }, { ...c, openDecisions: [] })
        ?.reason.kind,
    ).toBe("unassigned");
    expect(
      stallOf(
        { ...all, manualStall: null, claude: "none", links: [], assigneeId: "u1" },
        { ...c, openDecisions: [] },
      )?.reason.kind,
    ).toBe("idle");
  });
});
