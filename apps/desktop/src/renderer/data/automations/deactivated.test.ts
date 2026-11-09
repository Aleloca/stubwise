import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { automations, resetApi, setLatency } from "../api";
import { writeAccess } from "../access/index";
import { setSessionPersonId } from "../session";
import { state } from "../store";
import type { AutomationFlow, AutomationRun, Step } from "../types";
import { approversFor, holdersOfRole } from "./visibility";

// Automazioni e persone disattivate (area 9a, re-review giro 1, I2). Un
// ruolo sceglie fra i titolari ATTIVI; una persona fissa disattivata si
// decide nel PIANO, con un motivo in parole, così la prova fallisce dove
// fallirebbe l'esecuzione vera. Gli approvatori disattivati non contano.

const STW = "prj-stw";
const AUD = "prj-aud";
const AUTO = { mode: "auto" } as const;

const as = (personId: string) => setSessionPersonId(personId);
const idle = () => automations.whenAutomationsIdle();
const run = (id: string): AutomationRun => state.automationRuns.find((r) => r.id === id)!;
const deactivate = (personId: string) =>
  writeAccess((s) => {
    const p = s.people.find((x) => x.personId === personId)!;
    p.status = "deactivated";
    p.deactivatedAt = "2026-10-20T12:00:00Z";
  });

const createTaskStep = (
  assignee: Extract<Step, { kind: "createTask" }>["assignee"],
  approval: Extract<Step, { kind: "createTask" }>["approval"] = AUTO,
): Step => ({
  id: "t",
  kind: "createTask",
  title: "Per qualcuno",
  description: "",
  assignee,
  dueInDays: null,
  project: { mode: "own" },
  milestoneRef: null,
  approval,
});

const manual = (steps: Step[]): AutomationFlow => ({
  trigger: { kind: "manual" },
  steps,
  titleTemplate: "Prova",
});

/** Crea e accende un'automazione; restituisce il suo id. */
async function make(projectId: string, step: Step) {
  const a = await automations.createAutomation({ name: "Prova", projectId, flow: manual([step]) });
  await automations.activate(a.id);
  return a.id;
}

/** La prova della versione accesa, fino in fondo. */
async function simulate(id: string) {
  const sim = await automations.startSimulation(id, 1, {});
  return automations.simulationStep(sim, { kind: "run" });
}

const madeBy = (runId: string) => state.tasks.filter((t) => t.automationRef?.runId === runId);

beforeEach(() => {
  resetApi();
  setLatency(0);
  as("p-roberta");
});

afterEach(async () => {
  await idle();
});

describe("A: un ruolo sceglie fra i titolari attivi", () => {
  it("su STW Federico (primo Developer) è disattivato: la task va a Marco, nella vera e nella prova", async () => {
    deactivate("p-federico");
    expect(holdersOfRole(STW, "developer")).toEqual(["p-marco"]);
    const id = await make(STW, createTaskStep({ projectRole: "developer" }));

    const sim = await simulate(id);
    expect(sim.status).toBe("done");
    expect(sim.preview.tasks.map((t) => [t.assignedBy, t.assigneeId])).toEqual([
      ["role", "p-marco"],
    ]);

    const r = await automations.startManual(id);
    await idle();
    expect(run(r).status).toBe("done");
    expect(madeBy(r).map((t) => t.assigneeId)).toEqual(["p-marco"]);
  });

  it("nessun titolare attivo: senza incaricato, col suo avviso (come «nessuno ha il ruolo»)", async () => {
    deactivate("p-federico");
    deactivate("p-marco");
    const id = await make(STW, createTaskStep({ projectRole: "developer" }));
    const r = await automations.startManual(id);
    await idle();
    expect(run(r).status).toBe("done");
    expect(madeBy(r).map((t) => t.assigneeId)).toEqual([null]);
    expect((await simulate(id)).preview.tasks.map((t) => t.assigneeId)).toEqual([null]);
  });
});

describe("B: una persona fissa disattivata", () => {
  it("l'esecuzione vera fallisce con un motivo in parole, mai col codice della scrittura", async () => {
    const id = await make(AUD, createTaskStep({ personId: "p-marco" }));
    deactivate("p-marco");
    const r = await automations.startManual(id);
    await idle();
    expect(run(r)).toMatchObject({ status: "failed", error: "assignee_deactivated" });
    expect(madeBy(r)).toEqual([]);
    const last = run(r).log.at(-1)!;
    expect(last).toMatchObject({
      outcome: "failed",
      why: { code: "assigneeDeactivated", params: { name: "Marco Bellini" } },
    });
    expect(last.reason).toMatch(/^Marco Bellini è una persona disattivata/);
    // Ciò che il proprietario legge dell'esecuzione (registro, codice, avvisi) non ha il codice tecnico.
    expect(JSON.stringify([run(r), state.notifications])).not.toMatch(/invalid: assignee/);
  });

  it("la prova fallisce allo stesso passo, con lo stesso codice", async () => {
    const id = await make(AUD, createTaskStep({ personId: "p-marco" }));
    deactivate("p-marco");
    const sim = await simulate(id);
    expect(sim).toMatchObject({ status: "failed", error: "assignee_deactivated" });
    expect(sim.preview.tasks).toEqual([]);
  });
});

describe("un approvatore disattivato non approva", () => {
  it("la persona indicata è disattivata: nessuno può approvare, l'esecuzione fallisce", async () => {
    const id = await make(AUD, createTaskStep(null, { mode: "ask", who: { personId: "p-marco" } }));
    deactivate("p-marco");
    const a = state.automations.find((x) => x.id === id)!;
    expect(approversFor(a, { personId: "p-marco" }, AUD)).toEqual([]);
    const r = await automations.startManual(id);
    await idle();
    expect(run(r)).toMatchObject({ status: "failed", error: "no_approver" });
    // La prova non parte nemmeno: la configurazione dice che nessuno può approvare.
    await expect(simulate(id)).rejects.toThrow("invalid: config");
  });

  it("per ruolo, il disattivato non è fra chi approva", () => {
    deactivate("p-federico");
    const a = state.automations[0]!;
    expect(approversFor(a, { projectRole: "developer" }, STW)).toEqual(["p-marco"]);
  });
});
