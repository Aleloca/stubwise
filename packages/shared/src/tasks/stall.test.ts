import { describe, expect, it } from "vitest";
import { legacyFamilyOf, stallOf, type StallInputContext, type StallTaskInput } from "./stall.js";

/**
 * I casi di `apps/desktop/src/renderer/domain/stalled.test.ts`, sulla firma con
 * `today` esplicito (il prototipo passa il suo TODAY fisso, il server la data
 * UTC di oggi).
 */
const TODAY = "2026-10-23";

const task = (over: Partial<StallTaskInput> = {}): StallTaskInput => ({
  id: "t1",
  assigneeId: "u1",
  manualStall: null,
  links: [],
  lastActivityAt: "2026-10-22T09:00:00Z",
  plannedWeek: null,
  slipCount: 0,
  ...over,
});

const ctx = (over: Partial<StallInputContext> = {}): StallInputContext => ({
  family: "active",
  openDecisions: [],
  claudeQuestionSince: null,
  blockers: [],
  thresholds: { activeDays: 7, todoDays: 14 },
  ...over,
});

describe("legacyFamilyOf", () => {
  it("la stessa tabella della funzione SQL stubwise_legacy_family", () => {
    expect(legacyFamilyOf("open")).toBe("todo");
    expect(legacyFamilyOf("triaged")).toBe("todo");
    expect(legacyFamilyOf("in_progress")).toBe("active");
    expect(legacyFamilyOf("in_review")).toBe("active");
    expect(legacyFamilyOf("done")).toBe("closed");
    expect(legacyFamilyOf("closed")).toBe("closed");
  });
});

describe("stallOf", () => {
  it("una task in regola non è ferma", () => {
    expect(stallOf(task(), ctx(), TODAY)).toBeNull();
  });

  it("una task chiusa non è mai ferma, qualunque causa abbia", () => {
    const t = task({
      assigneeId: null,
      manualStall: { reason: "r", note: "n", since: "2026-10-01" },
    });
    expect(
      stallOf(
        t,
        ctx({
          family: "closed",
          claudeQuestionSince: "2026-10-01T00:00:00Z",
          openDecisions: [{ askedOfId: "u3", createdAt: "2026-10-20T10:00:00Z" }],
        }),
        TODAY,
      ),
    ).toBeNull();
  });

  it("manuale: prende reason e note, since è quello dichiarato", () => {
    const t = task({ manualStall: { reason: "Aspetta il cliente", note: "mail inviata", since: "2026-10-18" } });
    expect(stallOf(t, ctx(), TODAY)).toEqual({
      reason: { kind: "manual", reason: "Aspetta il cliente", note: "mail inviata" },
      since: "2026-10-18",
      days: 5,
    });
  });

  it("decisione: la più vecchia aperta, con la persona interpellata", () => {
    const s = stallOf(
      task(),
      ctx({
        openDecisions: [
          { askedOfId: "u9", createdAt: "2026-10-22T10:00:00Z" },
          { askedOfId: "u3", createdAt: "2026-10-20T10:00:00Z" },
        ],
      }),
      TODAY,
    );
    expect(s).toEqual({ reason: { kind: "decision", personId: "u3" }, since: "2026-10-20T10:00:00Z", days: 3 });
  });

  it("domanda di Claude: since è quando è stata fatta", () => {
    expect(stallOf(task(), ctx({ claudeQuestionSince: "2026-10-21T08:00:00Z" }), TODAY)).toEqual({
      reason: { kind: "claude_question" },
      since: "2026-10-21T08:00:00Z",
      days: 2,
    });
  });

  it("bloccata da una task aperta sì, da una chiusa no", () => {
    const t = task({ lastActivityAt: "2026-10-22T09:00:00Z" });
    expect(
      stallOf(t, ctx({ blockers: [{ id: "b1", family: "active", since: "2026-10-01" }] }), TODAY)?.reason,
    ).toEqual({ kind: "blocked_by", taskId: "b1" });
    expect(stallOf(t, ctx({ blockers: [{ id: "b2", family: "closed", since: "2026-10-01" }] }), TODAY)).toBeNull();
  });

  it("senza assegnatario: ferma se attiva o pianificata entro questa settimana", () => {
    const active = task({ assigneeId: null, lastActivityAt: "2026-10-22T08:00:00Z" });
    expect(stallOf(active, ctx(), TODAY)).toEqual({
      reason: { kind: "unassigned" },
      since: "2026-10-22T08:00:00Z",
      days: 1,
    });
    const todo = ctx({ family: "todo" });
    expect(stallOf(task({ assigneeId: null, plannedWeek: "2026-W43" }), todo, TODAY)?.reason).toEqual({
      kind: "unassigned",
    });
    expect(stallOf(task({ assigneeId: null, plannedWeek: "2026-W40" }), todo, TODAY)?.reason).toEqual({
      kind: "unassigned",
    });
    expect(stallOf(task({ assigneeId: null, plannedWeek: "2026-W44" }), todo, TODAY)).toBeNull();
    expect(stallOf(task({ assigneeId: null }), todo, TODAY)).toBeNull();
  });

  it("inattiva: active oltre activeDays", () => {
    expect(stallOf(task({ lastActivityAt: "2026-10-15T09:00:00Z" }), ctx(), TODAY)).toEqual({
      reason: { kind: "idle" },
      since: "2026-10-15T09:00:00Z",
      days: 8,
    });
    expect(stallOf(task({ lastActivityAt: "2026-10-16T09:00:00Z" }), ctx(), TODAY)).toBeNull();
  });

  it("inattiva: todo solo se già slittata e oltre todoDays", () => {
    const todo = ctx({ family: "todo" });
    const old = { lastActivityAt: "2026-10-01T09:00:00Z" };
    expect(stallOf(task({ ...old, slipCount: 0 }), todo, TODAY)).toBeNull();
    expect(stallOf(task({ ...old, slipCount: 1 }), todo, TODAY)?.reason).toEqual({ kind: "idle" });
    expect(stallOf(task({ slipCount: 2, lastActivityAt: "2026-10-15T09:00:00Z" }), todo, TODAY)).toBeNull();
  });

  it("una todo senza settimana pianificata non scatta per inattività", () => {
    // Fetta 1: nessuna settimana, quindi nessuno slittamento — ferma solo per le altre cause.
    const t = task({ plannedWeek: null, slipCount: 0, lastActivityAt: "2026-01-01T00:00:00Z" });
    expect(stallOf(t, ctx({ family: "todo" }), TODAY)).toBeNull();
  });

  it("le soglie del progetto contano", () => {
    const t = task({ lastActivityAt: "2026-10-20T09:00:00Z" });
    expect(stallOf(t, ctx({ thresholds: { activeDays: 2, todoDays: 14 } }), TODAY)?.reason).toEqual({
      kind: "idle",
    });
  });

  it("precedenza: manual > decision > claude_question > blocked_by > unassigned > idle", () => {
    const all = task({
      assigneeId: null,
      lastActivityAt: "2026-10-01T09:00:00Z",
      manualStall: { reason: "r", note: "n", since: "2026-10-10" },
    });
    const full = ctx({
      openDecisions: [{ askedOfId: "u3", createdAt: "2026-10-20T10:00:00Z" }],
      claudeQuestionSince: "2026-10-01T09:00:00Z",
      blockers: [{ id: "b1", family: "active", since: "2026-10-01" }],
    });
    const kind = (t: StallTaskInput, c: StallInputContext) => stallOf(t, c, TODAY)?.reason.kind;
    expect(kind(all, full)).toBe("manual");
    const noManual = { ...all, manualStall: null };
    expect(kind(noManual, full)).toBe("decision");
    expect(kind(noManual, { ...full, openDecisions: [] })).toBe("claude_question");
    expect(kind(noManual, { ...full, openDecisions: [], claudeQuestionSince: null })).toBe("blocked_by");
    expect(kind(noManual, { ...full, openDecisions: [], claudeQuestionSince: null, blockers: [] })).toBe(
      "unassigned",
    );
    expect(
      kind({ ...noManual, assigneeId: "u1" }, { ...full, openDecisions: [], claudeQuestionSince: null, blockers: [] }),
    ).toBe("idle");
  });
});
