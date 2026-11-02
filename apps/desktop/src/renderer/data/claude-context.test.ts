import { beforeEach, describe, expect, it } from "vitest";
import {
  contextIdOf,
  createConversation,
  describeContext,
  getConversation,
  instance,
  resetApi,
  sendMessage,
  setLatency,
  setStreamLatency,
  whenIdle,
} from "./api";
import { setSessionPersonId } from "./session";
import { state } from "./store";
import type { ContextRef } from "./types";

// Il contesto del riquadro di Claude (area 10a, Task 8): il chip si rilegge
// con la visibilità di chi guarda, il messaggio lo porta con sé, e ogni
// turno della libera conta i suoi consumi come `chat`.

beforeEach(() => {
  setLatency(0);
  setStreamLatency(null);
  resetApi();
});

const as = (personId: string) => setSessionPersonId(personId);
const acqTask = (code: string) => state.tasks.find((t) => t.code === code)!;

describe("describeContext", () => {
  it("ogni forma del riferimento: codice, parola, progetto", async () => {
    as("p-laura");
    const acq = "prj-acq";
    const task = acqTask("ACQ-3");
    expect(await describeContext({ kind: "task", taskId: task.id })).toEqual({
      code: "ACQ-3",
      labelKey: "claude.panel.chip.kind.task",
      projectId: acq,
    });
    expect(await describeContext({ kind: "request", requestId: "req-acq-1" })).toMatchObject({
      code: "ACQ-R1",
      labelKey: "claude.panel.chip.kind.request",
    });
    expect(await describeContext({ kind: "support", conversationId: "sup-acq-2" })).toMatchObject({
      code: "ACQ-S2",
      labelKey: "claude.panel.chip.kind.support",
    });
    expect(await describeContext({ kind: "settings", projectId: acq, section: "ai" })).toEqual({
      code: "ACQ",
      labelKey: "claude.panel.chip.projectSettings",
      projectId: acq,
      params: { sectionKey: "settings.sections.ai" },
    });
    expect(
      await describeContext({ kind: "settings", projectId: null, section: "ai.models" }),
    ).toEqual({
      code: null,
      labelKey: "claude.panel.chip.instanceSettings",
      projectId: null,
      params: { sectionKey: "admin.ai.tabs.models" },
    });
    expect(await describeContext({ kind: "page", route: "tasks", projectId: acq })).toEqual({
      code: "ACQ",
      labelKey: "project.sections.tasks",
      projectId: acq,
    });
    expect(await describeContext({ kind: "page", route: "home", projectId: null })).toEqual({
      code: null,
      labelKey: "nav.home",
      projectId: null,
    });
    as("p-giulia");
    expect(await describeContext({ kind: "pr", prId: "opr-aud-244" })).toEqual({
      code: "AUD",
      labelKey: "claude.panel.chip.kind.pr",
      projectId: "prj-aud",
      params: { number: 244 },
    });
    expect(await describeContext({ kind: "release", releaseId: "rel8-aud-2" })).toMatchObject({
      code: "AUD-V2",
      labelKey: "claude.panel.chip.kind.release",
    });
    expect(
      await describeContext({ kind: "automation", automationId: "aut-aud-client-data" }),
    ).toMatchObject({ code: "AUD-A1", labelKey: "claude.panel.chip.kind.automation" });
  });

  it("R-G5: un oggetto invisibile e uno inesistente rispondono `null`, uguale", async () => {
    as("p-sara");
    const hidden: ContextRef[] = [
      { kind: "task", taskId: acqTask("MKX-2").id },
      { kind: "pr", prId: "opr-aud-244" },
      { kind: "release", releaseId: "rel8-aud-2" },
      { kind: "automation", automationId: "aut-aud-client-data" },
      { kind: "settings", projectId: "prj-mkx", section: "ai" },
      { kind: "page", route: "tasks", projectId: "prj-mkx" },
    ];
    for (const ref of hidden) expect(await describeContext(ref)).toBeNull();
    expect(await describeContext({ kind: "task", taskId: "t-nope" })).toBeNull();
    expect(await describeContext({ kind: "request", requestId: "req-nope" })).toBeNull();
  });

  it("contextIdOf: dal codice all'id, solo se chi guarda lo vede", async () => {
    as("p-giulia");
    expect(await contextIdOf("task", "MKX-2")).toBe(acqTask("MKX-2").id);
    expect(await contextIdOf("release", "AUD-V2")).toBe("rel8-aud-2");
    expect(await contextIdOf("automation", "AUD-A1")).toBe("aut-aud-client-data");
    expect(await contextIdOf("task", "MKX-999")).toBeNull();
    as("p-sara");
    expect(await contextIdOf("task", "MKX-2")).toBeNull();
    as("p-laura");
    expect(await contextIdOf("support", "ACQ-S2")).toBe("sup-acq-2");
  });
});

describe("il contesto del messaggio e i consumi del turno", () => {
  it("il messaggio tiene il suo contesto; il turno conta `chat` sul progetto del contesto", async () => {
    as("p-laura");
    const c = await createConversation();
    const before = state.instance.usage.length;
    const ref: ContextRef = { kind: "task", taskId: acqTask("ACQ-3").id };
    await sendMessage(c.id, { text: "Summarize ACQ-3" }, { context: ref });
    await whenIdle(c.id);
    const user = (await getConversation(c.id))!.events.find((e) => e.type === "user");
    expect(user).toMatchObject({ type: "user", context: ref });
    const added = state.instance.usage.slice(before);
    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({
      operation: "chat",
      projectId: "prj-acq",
      conversationId: c.id,
    });
  });

  it("senza contesto: una riga senza progetto", async () => {
    as("p-laura");
    const c = await createConversation();
    const before = state.instance.usage.length;
    await sendMessage(c.id, { text: "What should I do today?" });
    await whenIdle(c.id);
    const added = state.instance.usage.slice(before);
    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({ operation: "chat", projectId: null });
  });

  it("un contesto diventato invisibile non porta il suo progetto: Claude risponde come per un codice inesistente", async () => {
    as("p-laura");
    const c = await createConversation();
    const task = acqTask("ACQ-3");
    // Laura esce da ACQ: la task non la vede più.
    const acq = state.projectsById.get("prj-acq")!;
    acq.memberIds = acq.memberIds.filter((id) => id !== "p-laura");
    const before = state.instance.usage.length;
    await sendMessage(
      c.id,
      { text: "Summarize ACQ-3" },
      { context: { kind: "task", taskId: task.id } },
    );
    await whenIdle(c.id);
    const other = await createConversation();
    await sendMessage(other.id, { text: "Summarize ACQ-999" });
    await whenIdle(other.id);
    const answer = async (id: string) =>
      (await getConversation(id))!.events
        .flatMap((e) => (e.type === "assistant" ? [e.text] : []))
        .join("\n");
    const hidden = await answer(c.id);
    const missing = await answer(other.id);
    expect(hidden).toMatch(/can't find ACQ-3/i);
    expect(hidden.replace("ACQ-3", "X")).toBe(missing.replace("ACQ-999", "X"));
    // Il consumo non dice il progetto che Laura non vede più.
    expect(state.instance.usage.slice(before)[0]).toMatchObject({ projectId: null });
  });

  it("budget esaurito: il messaggio non parte, nessun consumo", async () => {
    as("p-roberta");
    expect(await instance.simulateBudgetReached(true)).toMatchObject({ ok: true });
    as("p-laura");
    const c = await createConversation();
    const before = state.instance.usage.length;
    await expect(sendMessage(c.id, { text: "Hello" })).rejects.toThrow("monthly_budget");
    expect(state.instance.usage).toHaveLength(before);
  });
});
