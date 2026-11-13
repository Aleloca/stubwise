import { describe, expect, it } from "vitest";
import type {
  Automation,
  AutomationFlow,
  SimulationContext,
  SimulationExamplesView,
  Step,
} from "@stubwise/shared";
import { SimulationConfigError } from "../../../domain/automations/simCore";
import {
  ClaudeAnswerUnreadable,
  createRealSimulation,
  type SimulationApi,
} from "./automationSimulate";

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

  it("dopo un salvataggio della bozza le prove aperte di quell'automazione si buttano (review F3, m5)", async () => {
    const { api } = fakeApi(context([task()]));
    const s = createRealSimulation(api);
    const id = await s.startSimulation("a-1", "draft", {});
    s.forgetContext("a-1");
    expect(await s.getSimulation(id)).toBeNull();
  });

  it("dopo un salvataggio della bozza la prova rilegge il contesto (review, minore)", async () => {
    const { api, calls } = fakeApi(context([task()]));
    const s = createRealSimulation(api);
    await s.listSimulationExamples("a-1", "draft");
    s.forgetContext("a-1");
    await s.startSimulation("a-1", "draft", {});
    expect(calls).toEqual(["GET examples a-1 draft", "GET examples a-1 draft"]);
  });

  it("un traguardo col nome di uno che il progetto ha già: fallisce come il worker (`milestoneExists`), confronto esatto", async () => {
    const milestone = (name: string) =>
      ({
        id: "m1",
        kind: "createMilestone",
        name,
        dueInDays: null,
        project: { mode: "own" },
        approval: { mode: "auto" },
      }) as unknown as Step;
    const withNames = (step: Step) => {
      const ctx = context([step]);
      (ctx.projects[0] as { milestoneNames?: string[] }).milestoneNames = ["Kick-off"];
      return ctx;
    };
    const run = async (ctx: SimulationContext) => {
      const s = createRealSimulation(fakeApi(ctx).api);
      const id = await s.startSimulation("a-1", "draft", {});
      return s.simulationStep(id, { kind: "run" });
    };
    const taken = await run(withNames(milestone("Kick-off")));
    expect(taken.status).toBe("failed");
    expect(JSON.stringify(taken)).toContain("milestoneExists");
    // Come `milestoneNameTaken` (eq): un nome diverso anche solo nelle maiuscole passa.
    expect((await run(withNames(milestone("kick-off")))).status).toBe("done");
    // Un server senza il campo: nessun nome noto.
    expect((await run(context([milestone("Kick-off")]))).status).toBe("done");
  });

  it("un'email nella prova (F2, R5): dalla casella del contesto, la seconda allo stesso indirizzo nella stessa conversazione", async () => {
    const email = (id: string, to: string) =>
      ({
        id,
        kind: "sendEmail",
        to,
        subject: "Benvenuto",
        body: "Ciao",
        attachRefs: [],
        approval: { mode: "auto" },
      }) as unknown as Step;
    const ctx = context([email("e1", "cliente@example.com"), email("e2", "Cliente@Example.com")], {
      ownerMailbox: { ok: true, address: "ada@audin.test" },
    });
    const { api, calls } = fakeApi(ctx);
    const s = createRealSimulation(api);
    const id = await s.startSimulation("a-1", "draft", {});
    const v = await s.simulationStep(id, { kind: "run" });
    expect(v.status).toBe("done");
    expect(v.preview.emails).toEqual([
      expect.objectContaining({ stepId: "e1", from: "ada@audin.test", to: "cliente@example.com", sameConversationAs: null }),
      expect.objectContaining({ stepId: "e2", sameConversationAs: { stepId: "e1", path: "0" } }),
    ]);
    // Non manda niente: solo gli esempi e la prova segnata.
    expect(calls).toEqual(["GET examples a-1 draft", "POST tested a-1 1 7"]);
  });

  it("l'attesa della risposta nella prova: si ferma, la risposta scritta la sveglia (F2, R5)", async () => {
    const steps = [
      {
        id: "e1",
        kind: "sendEmail",
        to: "cliente@example.com",
        subject: "Documenti",
        body: "Ci mandi i documenti?",
        attachRefs: [],
        approval: { mode: "auto" },
      },
      { id: "w1", kind: "wait", for: { replyTo: "e1", maxDays: 3 } },
      notify,
    ] as unknown as Step[];
    const ctx = context(steps, { ownerMailbox: { ok: true, address: "ada@audin.test" } });
    const { api, calls } = fakeApi(ctx);
    const s = createRealSimulation(api);
    const id = await s.startSimulation("a-1", "draft", {});
    let v = await s.simulationStep(id, { kind: "run" });
    expect(v.waiting).toMatchObject({ kind: "event", wait: { replyTo: "e1" } });
    v = await s.simulationStep(id, {
      kind: "event",
      payload: { kind: "reply", to: "e1", text: "Eccoli" },
    });
    v = await s.simulationStep(id, { kind: "run" });
    expect(v.status).toBe("done");
    expect(v.preview.notifications).toHaveLength(1);
    expect(calls).toEqual(["GET examples a-1 draft", "POST tested a-1 1 7"]);
  });

  it("senza una casella utilizzabile l'email fallisce come nell'esecuzione vera", async () => {
    const email = {
      id: "e1",
      kind: "sendEmail",
      to: "cliente@example.com",
      subject: "x",
      body: "y",
      attachRefs: [],
      approval: { mode: "auto" },
    } as unknown as Step;
    for (const [ownerMailbox, code] of [
      [{ ok: false, reason: "expired" }, "mailboxExpired"],
      [undefined, "noMailbox"],
    ] as const) {
      const ctx = context([email], ownerMailbox ? { ownerMailbox } : {});
      const s = createRealSimulation(fakeApi(ctx).api);
      const id = await s.startSimulation("a-1", "draft", {});
      const v = await s.simulationStep(id, { kind: "run" });
      expect(v.status).toBe("failed");
      expect(JSON.stringify(v)).toContain(code);
    }
  });

  it("un passo di Claude (F3): la prova si ferma col costo stimato, confermato una volta chiama il server e prende il ramo", async () => {
    const claudeStep = {
      id: "c1",
      kind: "claude",
      instruction: "Il contratto è firmato?",
      inputs: ["task.titolo"],
      outcomes: ["firmato", "no"],
      fields: [],
      branches: { firmato: [notify], no: [] },
    } as unknown as Step;
    const second = { ...claudeStep, id: "c2", branches: {} } as unknown as Step;
    const ctx = context([claudeStep, second]);
    const { api, calls } = fakeApi(ctx);
    const runs: unknown[] = [];
    const s = createRealSimulation({
      ...api,
      claude: {
        estimate: async (automationId, version, event) => {
          calls.push(`GET estimate ${automationId} ${version} ${JSON.stringify(event)}`);
          return { claudeSteps: 2, estimateUsd: 0.04, model: "sonnet" };
        },
        run: async (automationId, body) => {
          runs.push({ automationId, ...body });
          return { outcome: "firmato", reason: "C'è la firma", truncated: runs.length === 1 ? ["task.titolo"] : [] };
        },
      },
    });
    const id = await s.startSimulation("a-1", "draft", { task: { titolo: "AUD-1" } });
    let v = await s.simulationStep(id, { kind: "run" });
    expect(v.costToConfirm).toEqual({ claudeSteps: 2, estimateUsd: 0.04, model: "sonnet" });
    expect(runs).toEqual([]);
    v = await s.confirmSimulationCost(id);
    expect(v.costToConfirm).toBeNull();
    v = await s.simulationStep(id, { kind: "run" });
    expect(v.status).toBe("done");
    expect(v.preview.claude.map((c) => c.outcome)).toEqual(["firmato", "firmato"]);
    expect(v.preview.notifications).toHaveLength(1);
    // Una conferma vale per tutta la prova: due passi, una stima.
    expect(runs).toEqual([
      { automationId: "a-1", version: 1, path: "0", vars: expect.any(Object) },
      { automationId: "a-1", version: 1, path: "1", vars: expect.any(Object) },
    ]);
    // La stima porta l'evento dell'esempio; una sola per la prova.
    expect(calls.filter((c) => c.startsWith("GET estimate"))).toEqual([
      `GET estimate a-1 draft {"task":{"titolo":"AUD-1"}}`,
    ]);
    // Un input tagliato si dice in testa alla motivazione, come nell'esecuzione vera.
    expect(v.preview.claude[0]!.reason).toMatch(/^\[Input tagliati a 20 000 caratteri: task\.titolo\] /);
    expect(v.preview.claude[1]!.reason).toBe("C'è la firma");
  });

  const claudeTrial = (steps: Step[], run: (body: { path: string }) => Promise<{ outcome?: string; reason: string }>) => {
    const ctx = context(steps);
    const { api } = fakeApi(ctx);
    const calls: string[] = [];
    const s = createRealSimulation({
      ...api,
      claude: {
        estimate: async () => ({ claudeSteps: steps.length, estimateUsd: 0.01, model: "sonnet" }),
        run: async (_id, body) => {
          calls.push(body.path);
          return run(body);
        },
      },
    });
    return { s, calls };
  };
  const ask = (id: string) =>
    ({ id, kind: "claude", instruction: "x", inputs: [], outcomes: ["si", "no"], fields: [], branches: {} }) as unknown as Step;
  const confirmed = async (s: ReturnType<typeof createRealSimulation>) => {
    const id = await s.startSimulation("a-1", "draft", {});
    await s.simulationStep(id, { kind: "run" });
    await s.confirmSimulationCost(id);
    return id;
  };

  it("una risposta non JSON fa fallire il passo con claude_invalid, come l'esecuzione vera (e non si richiama)", async () => {
    const { s, calls } = claudeTrial([ask("c1")], async () => {
      throw new ClaudeAnswerUnreadable();
    });
    const id = await confirmed(s);
    const v = await s.simulationStep(id, { kind: "run" });
    expect(v.status).toBe("failed");
    expect(v.error).toBe("claude_invalid");
    expect(v.log.at(-1)).toMatchObject({ kind: "claude", outcome: "failed", why: { code: "claudeInvalid" } });
    expect(calls).toEqual(["0"]);
  });

  it("un errore a metà di «run» tiene il progresso già pagato e lo dice (interrupted)", async () => {
    const { s, calls } = claudeTrial([ask("c1"), ask("c2")], async ({ path }) => {
      if (path === "1") throw new Error("invalid: budget");
      return { outcome: "si", reason: "ok" };
    });
    const id = await confirmed(s);
    const v = await s.simulationStep(id, { kind: "run" });
    expect(v.interrupted).toBe("budget");
    expect(v.preview.claude.map((c) => c.stepId)).toEqual(["c1"]);
    expect((await s.getSimulation(id))!.preview.claude).toHaveLength(1);
    expect(calls).toEqual(["0", "1"]);
  });

  it("in un «ripeti finché» ogni giro chiede la sua risposta, anche con gli stessi dati", async () => {
    const loop = {
      id: "r",
      kind: "repeatUntil",
      // Mai vero: si ripete fino al massimo.
      until: { left: { value: 1 }, op: "is", right: { value: 2 } },
      max: 3,
      steps: [ask("c1")],
      onLimit: [],
    } as unknown as Step;
    const { s, calls } = claudeTrial([loop], async () => ({ outcome: "si", reason: "ok" }));
    const id = await confirmed(s);
    await s.simulationStep(id, { kind: "run" });
    expect(new Set(calls).size).toBe(calls.length);
    expect(calls.length).toBeGreaterThan(1);
  });

  it("senza la rotta di Claude (un server della F2) un passo di Claude non è disponibile", async () => {
    const claudeStep = {
      id: "c1",
      kind: "claude",
      instruction: "x",
      inputs: [],
      outcomes: [],
      fields: [],
      branches: {},
    } as unknown as Step;
    const s = createRealSimulation(fakeApi(context([claudeStep])).api);
    const id = await s.startSimulation("a-1", "draft", {});
    await expect(s.simulationStep(id, { kind: "run" })).rejects.toThrow(/not_available/);
  });

  it("la casella scelta che non c'è più: il motivo la nomina, come nel prototipo (chi prova è il proprietario)", async () => {
    const email = {
      id: "e1",
      kind: "sendEmail",
      to: "cliente@example.com",
      subject: "x",
      body: "y",
      attachRefs: [],
      approval: { mode: "auto" },
    } as unknown as Step;
    const ctx = context([email], { ownerMailbox: { ok: false, reason: "chosen_gone" } });
    Object.assign(ctx.automation, { mailbox: "vecchia@audin.test", ownerId: ME });
    const s = createRealSimulation(fakeApi(ctx).api);
    const id = await s.startSimulation("a-1", "draft", {});
    const v = await s.simulationStep(id, { kind: "run" });
    expect(v.status).toBe("failed");
    expect(JSON.stringify(v.log)).toContain("vecchia@audin.test");
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
