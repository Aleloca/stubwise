import { describe, expect, it } from "vitest";
import type { Automation, AutomationFlow, AutomationVersion, Step } from "../../data/types";
import { createSimulator, SimulationConfigError, type SimWorld } from "./simCore";

// R3 del piano della F1 (area 7): la prova gira sul nucleo puro col mondo da
// fuori, senza lo store né il seme — così la build app la fa sullo stesso
// codice del prototipo. Questo file non importa niente del prototipo.

const PRJ = "prj-1";
const people: Record<string, { id: string; name: string; departmentIds: string[] }> = {
  ada: { id: "ada", name: "Ada", departmentIds: ["dev"] },
  bob: { id: "bob", name: "Bob", departmentIds: ["dev"] },
};

function world(over: Partial<SimWorld> = {}): SimWorld {
  return {
    person: (id) => people[id],
    isDeactivated: () => false,
    holdersOfRole: (projectId, role) => (projectId === PRJ && role === "Project Lead" ? ["bob"] : []),
    departmentRecipients: () => [],
    canSeeProject: (personId, projectId) => projectId === PRJ && personId in people,
    projectGone: (projectId) => projectId !== PRJ,
    checkNewTask: () => {},
    checkNewMilestone: () => {},
    checkNewRequest: () => {},
    defaultDepartmentOf: () => "dev",
    now: () => "2026-11-13T10:00:00.000Z",
    project: (id) => (id === PRJ ? { code: "AUD", name: "Audin" } : undefined),
    visibleProjectIds: (personId) => new Set(personId in people ? [PRJ] : []),
    canSeeAutomation: () => true,
    configErrors: () => [],
    ...over,
  };
}

const task = (id: string, approval: unknown = { mode: "auto" }): Step =>
  ({
    id,
    kind: "createTask",
    title: "Kick-off {{task.titolo}}",
    description: "",
    assignee: { projectRole: "Project Lead" },
    dueInDays: 3,
    project: { mode: "own" },
    milestoneRef: null,
    approval,
  }) as Step;
const notify = (id: string): Step =>
  ({ id, kind: "notify", who: { personId: "ada" }, text: "Fatto", approval: { mode: "auto" } }) as Step;

const flow = (steps: Step[]): AutomationFlow => ({
  trigger: { kind: "manual" },
  steps,
  titleTemplate: "Prova",
});
const version = (f: AutomationFlow): AutomationVersion =>
  ({ n: 1, flow: f, publishedAt: null, publishedById: null, savedAt: "", savedById: "ada", rev: 4, testedRev: null }) as unknown as AutomationVersion;
const automation = (f: AutomationFlow): Automation =>
  ({
    id: "a-1",
    code: "AUD-A1",
    name: "Avvio",
    description: "",
    projectId: PRJ,
    ownerId: "ada",
    status: "draft",
    versions: [version(f)],
  }) as unknown as Automation;

describe("il nucleo della prova, senza lo store", () => {
  it("una prova completa: anteprime coi piani veri, nessuna scrittura (il mondo non scrive)", () => {
    const f = flow([task("t1"), notify("n1")]);
    const sim = createSimulator(world());
    const s = sim.start("ada", "sim-1", automation(f), version(f), { task: { titolo: "AUD" } }, "ada");
    sim.handle("ada", s, { ...automation(f), ownerId: "ada" }, { kind: "run" });
    const v = sim.view("ada", s, automation(f));
    expect(v.status).toBe("done");
    expect(v.preview.tasks).toEqual([
      expect.objectContaining({
        title: "Kick-off AUD",
        assigneeId: "bob",
        assignedBy: "role",
        project: { id: PRJ, code: "AUD", name: "Audin" },
        dueDate: "2026-11-16",
      }),
    ]);
    expect(v.preview.notifications).toEqual([expect.objectContaining({ personId: "ada", text: "Fatto" })]);
    expect(sim.finishedWell(s)).toBe(true);
  });

  it("un passo «chiede a»: la prova si ferma, dice chi approverebbe davvero, e si sblocca con l'approvazione", () => {
    const f = flow([task("t1", { mode: "ask", who: { projectRole: "Project Lead" } })]);
    const sim = createSimulator(world());
    const a = automation(f);
    const s = sim.start("ada", "sim-2", a, version(f), { task: { titolo: "x" } }, "ada");
    const waiting = sim.view("ada", s, a).waiting;
    expect(waiting).toMatchObject({ kind: "approval", realApproverIds: ["bob"] });
    sim.handle("ada", s, a, { kind: "approved", path: "0", byId: "ada" } as never);
    sim.handle("ada", s, a, { kind: "run" });
    expect(sim.view("ada", s, a).status).toBe("done");
  });

  it("nessun approvatore possibile: no_approver (R-J11), come l'esecuzione vera", () => {
    const f = flow([task("t1", { mode: "ask", who: { projectRole: "Nobody" } })]);
    const sim = createSimulator(world());
    const a = automation(f);
    const s = sim.start("ada", "sim-3", a, version(f), {}, "ada");
    expect(s.engine).toMatchObject({ status: "failed", error: "no_approver" });
  });

  it("il permesso del proprietario perso: il passo fallisce col codice dell'esecuzione vera", () => {
    const f = flow([task("t1")]);
    const sim = createSimulator(
      world({
        checkNewTask: () => {
          throw new Error("forbidden");
        },
      }),
    );
    const a = automation(f);
    const s = sim.start("ada", "sim-4", a, version(f), {}, "ada");
    sim.handle("ada", s, a, { kind: "run" });
    expect(s.engine).toMatchObject({ status: "failed", error: "permission_lost" });
  });

  it("errori di configurazione: la prova non parte", () => {
    const f = flow([task("t1")]);
    const sim = createSimulator(world({ configErrors: () => [{ path: "0", code: "incomplete", message: "x" }] }));
    expect(() => sim.start("ada", "sim-5", automation(f), version(f), {}, "ada")).toThrow(SimulationConfigError);
  });

  it("un passo fuori dalla fetta 1 senza i suoi agganci (la build app): non si prova", () => {
    const email = {
      id: "e1",
      kind: "sendEmail",
      to: "a@b.test",
      subject: "s",
      body: "b",
      attachRefs: [],
      approval: { mode: "auto" },
    } as Step;
    const f = flow([email]);
    const sim = createSimulator(world());
    const a = automation(f);
    const s = sim.start("ada", "sim-6", a, version(f), {}, "ada");
    expect(() => sim.handle("ada", s, a, { kind: "run" })).toThrow("not_available");
  });
});
