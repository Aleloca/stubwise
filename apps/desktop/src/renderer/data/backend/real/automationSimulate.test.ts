import { describe, expect, it } from "vitest";
import type {
  Automation,
  AutomationFlow,
  SimulationContext,
  SimulationExamplesView,
  Step,
} from "@stubwise/shared";
import { SimulationConfigError } from "../../../domain/automations/simCore";
import { createRealSimulation, type SimulationApi } from "./automationSimulate";

// R3 della F1 (area 7): la prova nella build app gira nel client, sul nucleo
// puro, coi fatti che il server risolve (`GET …/examples`). Non scrive
// niente: l'unica chiamata oltre agli esempi è `/tested`, a prova finita bene.

const ME = "ada";
const PRJ = "prj-1";

const task = (approval: unknown = { mode: "auto" }): Step =>
  ({
    id: "t1",
    kind: "createTask",
    title: "Kick-off {{task.titolo}}",
    description: "",
    assignee: { projectRole: "Project Lead" },
    dueInDays: 3,
    project: { mode: "own" },
    milestoneRef: null,
    approval,
  }) as Step;
const notify: Step = {
  id: "n1",
  kind: "notify",
  who: { personId: "ada" },
  text: "Fatto",
  approval: { mode: "auto" },
} as Step;

function context(
  steps: Step[],
  over: Partial<SimulationContext> = {},
  trigger?: unknown,
): SimulationContext {
  const flow = {
    trigger: trigger ?? { kind: "stubwise", event: "task_created" },
    steps,
    titleTemplate: "Prova",
  } as unknown as AutomationFlow;
  const automation = {
    id: "a-1",
    code: "AUD-A1",
    name: "Avvio",
    description: "",
    projectId: PRJ,
    ownerId: null,
    status: "draft",
    versions: [
      {
        n: 1,
        flow,
        publishedAt: null,
        publishedById: null,
        savedAt: "",
        savedById: ME,
        rev: 7,
        testedRev: null,
      },
    ],
  } as unknown as Automation;
  return {
    automation,
    version: 1,
    draft: true,
    rev: 7,
    ownerId: ME,
    configErrors: [],
    people: [
      {
        id: "ada",
        name: "Ada",
        departmentIds: ["dev"],
        isClaude: false,
        deactivated: false,
        defaultDepartmentId: "dev",
      },
      {
        id: "bob",
        name: "Bob",
        departmentIds: ["dev"],
        isClaude: false,
        deactivated: false,
        defaultDepartmentId: "dev",
      },
    ],
    projects: [
      {
        id: PRJ,
        code: "AUD",
        name: "Audin",
        gone: false,
        seenBy: ["ada", "bob"],
        ownerCan: { createTask: true, createMilestone: true, createRequest: true },
        roleHolders: { "Project Lead": ["bob"] },
        departmentMembers: { dev: ["ada", "bob"] },
      },
    ],
    ...over,
  };
}

function fakeApi(ctx: SimulationContext) {
  const calls: string[] = [];
  const api: SimulationApi = {
    me: () => ME,
    now: () => "2026-11-13T10:00:00.000Z",
    examples: async (automationId, version): Promise<SimulationExamplesView> => {
      calls.push(`GET examples ${automationId} ${version}`);
      return {
        items: [
          { label: "AUD-12 Titolo", code: "AUD-12", at: null, event: { task: { titolo: "AUD" } } },
        ],
        context: structuredClone(ctx),
      };
    },
    markTested: async (automationId, body) => {
      calls.push(`POST tested ${automationId} ${body.version} ${body.rev}`);
    },
  };
  return { api, calls };
}

describe("la prova nella build app", () => {
  it("una prova completa: le anteprime dai fatti del server, e solo GET esempi più /tested con la rev", async () => {
    const { api, calls } = fakeApi(context([task(), notify]));
    const s = createRealSimulation(api);
    const [example] = await s.listSimulationExamples("a-1", "draft");
    const id = await s.startSimulation("a-1", "draft", example!.event);
    const v = await s.simulationStep(id, { kind: "run" });
    expect(v.status).toBe("done");
    expect(v.preview.tasks).toEqual([
      expect.objectContaining({ title: "Kick-off AUD", assigneeId: "bob", dueDate: "2026-11-16" }),
    ]);
    expect(v.preview.notifications).toEqual([
      expect.objectContaining({ personId: "ada", text: "Fatto" }),
    ]);
    expect(calls).toEqual(["GET examples a-1 draft", "POST tested a-1 1 7"]);
  });

  it("un passo «chiede a» si ferma e dice l'approvatore vero (quello del server)", async () => {
    const { api, calls } = fakeApi(
      context([task({ mode: "ask", who: { projectRole: "Project Lead" } })]),
    );
    const s = createRealSimulation(api);
    const id = await s.startSimulation("a-1", "draft", { task: { titolo: "x" } });
    const v = await s.getSimulation(id);
    expect(v?.status).toBe("waiting_approval");
    expect(v?.waiting).toMatchObject({ kind: "approval", realApproverIds: ["bob"] });
    expect(calls).toEqual(["GET examples a-1 draft"]);
  });

  it("«Wouldn't start»: il filtro dell'inizio non passa, la prova finisce senza contare come provata", async () => {
    const trigger = {
      kind: "stubwise",
      event: "task_created",
      filter: { left: { ref: "task.titolo" }, op: "is", right: { value: "ALTRO" } },
    };
    const { api, calls } = fakeApi(context([task()], {}, trigger));
    const s = createRealSimulation(api);
    const id = await s.startSimulation("a-1", "draft", { task: { titolo: "AUD" } });
    const v = await s.getSimulation(id);
    expect(v).toMatchObject({ status: "done", filteredOut: true });
    expect(calls).toEqual(["GET examples a-1 draft"]);
  });

  it("una prova che fallisce (permesso del proprietario perso) non chiama /tested", async () => {
    const ctx = context([task()]);
    ctx.projects[0]!.ownerCan.createTask = false;
    const { api, calls } = fakeApi(ctx);
    const s = createRealSimulation(api);
    const id = await s.startSimulation("a-1", "draft", {});
    const v = await s.simulationStep(id, { kind: "run" });
    expect(v.status).toBe("failed");
    expect(calls).toEqual(["GET examples a-1 draft"]);
  });

  it("un titolo o un nome vuoto fa fallire la prova come il worker (review I4), e non segna provato", async () => {
    const blankTask = { ...task(), title: "{{task.titolo}}" } as Step;
    const blankMilestone = {
      id: "m1",
      kind: "createMilestone",
      name: "  ",
      dueInDays: null,
      project: { mode: "own" },
      approval: { mode: "auto" },
    } as unknown as Step;
    const blankRequest = {
      id: "r1",
      kind: "createRequest",
      title: "",
      description: "",
      project: { mode: "own" },
      approval: { mode: "auto" },
    } as unknown as Step;
    for (const step of [blankTask, blankMilestone, blankRequest]) {
      const { api, calls } = fakeApi(context([step]));
      const s = createRealSimulation(api);
      const id = await s.startSimulation("a-1", "draft", { task: { titolo: "   " } });
      const v = await s.simulationStep(id, { kind: "run" });
      expect(v.status).toBe("failed");
      expect(calls).toEqual(["GET examples a-1 draft"]);
    }
  });

  it("gli errori di configurazione del server: la prova non parte", async () => {
    const { api } = fakeApi(
      context([task()], { configErrors: [{ path: "0", code: "not_available", message: "x" }] }),
    );
    const s = createRealSimulation(api);
    await expect(s.startSimulation("a-1", "draft", {})).rejects.toBeInstanceOf(
      SimulationConfigError,
    );
  });

  it("una prova buttata non c'è più", async () => {
    const { api } = fakeApi(context([task()]));
    const s = createRealSimulation(api);
    const id = await s.startSimulation("a-1", "draft", {});
    await s.endSimulation(id);
    expect(await s.getSimulation(id)).toBeNull();
  });
});
