import { beforeEach, describe, expect, it } from "vitest";
import { automations, resetApi, setLatency } from "../../../data/api";
import { AUTOMATION_CASES } from "../../../data/seed/automations";
import { setSessionPersonId } from "../../../data/session";
import { state } from "../../../data/store";
import type { Step } from "../../../data/types";
import {
  currentRound,
  defaultRound,
  indexLog,
  laneTaken,
  markAt,
  roundSeg,
  roundTotal,
  roundsSeen,
} from "./marks";

// I segni di percorso della prova, su prove vere del livello dati.

const A = AUTOMATION_CASES.automations;
const S = AUTOMATION_CASES.sources;
const sample = (sourceId: string, i: number) =>
  state.automationSources.find((s) => s.id === sourceId)!.sampleEvents[i]!;
const flowOf = (id: string, n: number) =>
  state.automations.find((a) => a.id === id)!.versions.find((v) => v.n === n)!.flow;

beforeEach(() => {
  resetApi();
  setLatency(0);
  setSessionPersonId("p-matteo");
});

describe("segni di percorso", () => {
  it("all'inizio: l'inizio fatto, il primo passo corrente, il resto non raggiunto", async () => {
    const id = await automations.startSimulation(A.newContract, 1, sample(S.audin, 0));
    const ix = indexLog((await automations.getSimulation(id))!);
    expect(markAt(ix, "trigger")).toBe("done");
    expect(markAt(ix, "0")).toBe("current");
    expect(markAt(ix, "1")).toBe("pending");
    expect(markAt(ix, "2/forEach[0]/0")).toBe("pending");
  });

  it("dentro un «Per ogni»: rami presi e non presi per giro, giri, fermata all'approvazione", async () => {
    const id = await automations.startSimulation(A.newContract, 1, sample(S.audin, 0));
    await automations.simulationStep(id, { kind: "next" });
    const sim = await automations.simulationStep(id, { kind: "run" });
    const ix = indexLog(sim);
    const steps = flowOf(A.newContract, 1).steps;
    const each = steps[2]!;
    const cond = (each as Extract<Step, { kind: "forEach" }>).steps[0]!;
    expect(markAt(ix, "0")).toBe("done");
    expect(markAt(ix, "2")).toBe("done");
    expect(markAt(ix, "3")).toBe("stopped");
    // Giro 0: «Development» → then; giro 1: else.
    expect(laneTaken(ix, cond, "2/forEach[0]/0", "then")).toBe(true);
    expect(laneTaken(ix, cond, "2/forEach[0]/0", "else")).toBe(false);
    expect(laneTaken(ix, cond, "2/forEach[1]/0", "then")).toBe(false);
    expect(markAt(ix, "2/forEach[0]/0/then/0")).toBe("done");
    expect(markAt(ix, "2/forEach[1]/0/then/0")).toBe("pending");
    expect(laneTaken(ix, each, "2", "forEach[0]")).toBe(true);
    expect(roundsSeen(ix, "2", "forEach")).toEqual([0, 1, 2, 3]);
    expect(roundTotal(ix, each, "2")).toBe(4);
    expect(currentRound(ix, "2", "forEach")).toBeNull();
    expect(defaultRound(ix, "2", "forEach")).toBe(3);
    expect(roundSeg("forEach[0]", 2)).toBe("forEach[2]");
  });

  it("a metà di un giro: il ciclo ha il cursore dentro, il giro corrente è il default", async () => {
    const id = await automations.startSimulation(A.newContract, 1, sample(S.audin, 0));
    await automations.simulationStep(id, { kind: "next" });
    await automations.simulationStep(id, { kind: "next" });
    const sim = await automations.simulationStep(id, { kind: "next" });
    const ix = indexLog(sim);
    expect(sim.cursor).toMatch(/^2\/forEach\[1\]\//);
    expect(markAt(ix, "2")).toBe("inside");
    expect(currentRound(ix, "2", "forEach")).toBe(1);
    expect(defaultRound(ix, "2", "forEach")).toBe(1);
    expect(markAt(ix, sim.cursor!)).toBe("current");
  });

  it("rifiutata nella prova; fallita allo stesso passo", async () => {
    const id = await automations.startSimulation(A.newContract, 1, sample(S.audin, 0));
    await automations.simulationStep(id, { kind: "run" });
    let sim = await automations.simulationStep(id, { kind: "rejected", path: "", byId: "" });
    expect(markAt(indexLog(sim), "3")).toBe("rejected");

    state.googleAccounts.find((a) => a.personId === "p-matteo")!.status = "expired";
    const other = await automations.startSimulation(A.newContract, 1, sample(S.audin, 0));
    await automations.simulationStep(other, { kind: "run" });
    await automations.simulationStep(other, { kind: "approved", path: "", byId: "" });
    sim = await automations.simulationStep(other, { kind: "next" });
    expect(sim.status).toBe("failed");
    expect(markAt(indexLog(sim), "3")).toBe("failed");
  });

  it("«Ripeti finché» al limite: la corsia del limite presa, l'attesa ferma", async () => {
    const id = await automations.startSimulation(A.clientData, 1, sample(S.webhook, 1));
    let sim = await automations.simulationStep(id, { kind: "next" });
    const repeat = flowOf(A.clientData, 1).steps[2]!;
    expect(markAt(indexLog(sim), "1")).toBe("stopped");
    expect(laneTaken(indexLog(sim), repeat, "2", "onLimit")).toBeNull();
    for (let i = 0; i < 3; i++) {
      const until = sim.waiting?.kind === "event" ? sim.waiting.until : "";
      sim = await automations.simulationStep(id, { kind: "time", now: until });
      if (sim.status === "running") sim = await automations.simulationStep(id, { kind: "run" });
    }
    const ix = indexLog(sim);
    expect(sim.status).toBe("done");
    expect(laneTaken(ix, repeat, "2", "onLimit")).toBe(true);
    expect(laneTaken(ix, repeat, "2", "repeat[0]")).toBe(true);
    expect(roundsSeen(ix, "2", "repeat")).toEqual([0, 1]);
    expect(markAt(ix, "2")).toBe("done");
  });
});
