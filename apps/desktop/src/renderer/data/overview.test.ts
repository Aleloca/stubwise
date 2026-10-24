import { beforeEach, describe, expect, it } from "vitest";
import {
  createMilestone,
  deleteMilestone,
  failNext,
  getLatestBrief,
  listDecisionLog,
  listMilestones,
  listTasks,
  listTimeline,
  recordDecision,
  resetApi,
  setLatency,
  updateMilestone,
} from "./api";
import { BRIEFS } from "./seed/briefs";
import { DECISION_LOG } from "./seed/decisionLog";
import { setSessionPersonId } from "./session";
import { state } from "./store";

beforeEach(() => {
  setLatency(0);
  resetApi();
});

describe("cronologia di progetto (R-A2)", () => {
  it("unisce task, traguardi, decisioni, brief, report giornalieri e PR, dalla più recente", async () => {
    setSessionPersonId("p-roberta");
    const events = await listTimeline("prj-stw");
    const kinds = new Set(events.map((e) => e.kind));
    for (const k of [
      "task_opened",
      "task_closed",
      "milestone",
      "decision",
      "brief",
      "daily_report",
      "pr_opened",
      "pr_merged",
      "pr_closed",
    ]) {
      expect(kinds).toContain(k);
    }
    const ats = events.map((e) => e.at);
    expect([...ats].sort().reverse()).toEqual(ats);
  });

  it("un progetto invisibile non ha cronologia, registro né brief", async () => {
    setSessionPersonId("p-sara");
    expect(await listTimeline("prj-aud")).toEqual([]);
    expect(await listDecisionLog("prj-aud")).toEqual([]);
    expect(await getLatestBrief("prj-aud")).toBeNull();
  });
});

describe("brief e registro decisioni", () => {
  it("getLatestBrief dà l'ultimo brief, `null` se non ce n'è", async () => {
    setSessionPersonId("p-giulia");
    const latest = await getLatestBrief("prj-aud");
    const mine = BRIEFS.filter((b) => b.projectId === "prj-aud").map((b) => b.createdAt);
    expect(latest?.createdAt).toBe([...mine].sort().at(-1));
    expect(await getLatestBrief("prj-glt")).toBeNull();
  });

  it("nessuna voce del registro viene dall'AI: le sorgenti sono quelle dei fatti", () => {
    for (const d of DECISION_LOG) {
      expect(["ask_user", "plan_review", "pulse", "manual", "email"]).toContain(d.source);
    }
  });

  it("recordDecision: solo con decisions.record; la voce è manuale, di chi scrive, e supera l'altra", async () => {
    setSessionPersonId("p-giulia");
    // Su AUD Giulia è Contributor: niente decisions.record, e niente cambia.
    const before = state.decisionLog.length;
    await expect(recordDecision("prj-aud", { title: "X", decision: "Y" })).rejects.toThrow(
      "forbidden",
    );
    expect(state.decisionLog).toHaveLength(before);

    // Su MKX è Project Lead.
    const entry = await recordDecision("prj-mkx", {
      title: "  Keep one landing page  ",
      decision: "One page in two languages.",
      context: "",
      supersedesId: "dl-mkx-2",
    });
    expect(entry).toMatchObject({
      source: "manual",
      decidedById: "p-giulia",
      title: "Keep one landing page",
      context: null,
      supersededById: null,
    });
    const log = await listDecisionLog("prj-mkx");
    expect(log[0]!.id).toBe(entry.id);
    expect(log.find((d) => d.id === "dl-mkx-2")!.supersededById).toBe(entry.id);
  });

  it("recordDecision rifiuta titolo o decisione vuoti", async () => {
    setSessionPersonId("p-giulia");
    await expect(recordDecision("prj-mkx", { title: " ", decision: "x" })).rejects.toThrow(
      "invalid: title",
    );
    await expect(recordDecision("prj-mkx", { title: "x", decision: "" })).rejects.toThrow(
      "invalid: decision",
    );
  });
});

describe("traguardi (R-A6)", () => {
  it("crea, modifica, chiude e riapre con tickets.edit; senza, forbidden", async () => {
    setSessionPersonId("p-giulia");
    await expect(createMilestone("prj-aud", { name: "Nope" })).rejects.toThrow("forbidden");

    const m = await createMilestone("prj-mkx", { name: " Summer ", dueDate: "2026-12-01" });
    expect(m).toMatchObject({ name: "Summer", dueDate: "2026-12-01", closed: false });
    const edited = await updateMilestone(m.id, { name: "Summer sale", dueDate: null });
    expect(edited).toMatchObject({ name: "Summer sale", dueDate: null });
    expect((await updateMilestone(m.id, { closed: true })).closed).toBe(true);
    expect((await updateMilestone(m.id, { closed: false })).closed).toBe(false);
    await expect(updateMilestone(m.id, { name: "" })).rejects.toThrow("invalid: name");
  });

  it("eliminare un traguardo lascia le sue task, senza traguardo", async () => {
    setSessionPersonId("p-giulia");
    const ids = (await listTasks({ milestoneIds: ["ms-mkx-1"] })).map((x) => x.id);
    expect(ids.length).toBeGreaterThan(0);
    await deleteMilestone("ms-mkx-1");
    expect((await listMilestones("prj-mkx")).some((x) => x.id === "ms-mkx-1")).toBe(false);
    for (const id of ids) expect(state.tasksById.get(id)!.milestoneId).toBeNull();
  });

  it("una scrittura rifiutata dal simulatore non tocca niente", async () => {
    setSessionPersonId("p-giulia");
    failNext("deleteMilestone");
    await expect(deleteMilestone("ms-mkx-1")).rejects.toThrow();
    expect(state.milestones.some((x) => x.id === "ms-mkx-1")).toBe(true);
  });
});
