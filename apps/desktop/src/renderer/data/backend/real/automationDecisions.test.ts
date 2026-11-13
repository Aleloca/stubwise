import { ApiError } from "@stubwise/api-client";
import { describe, expect, it } from "vitest";
import type { AutomationDecision, AutomationRunDetail, MyAutomationRun } from "@stubwise/shared";
import { createRealDecisions, type DecisionApi } from "./automationDecisions";

// R7 della F1 (area 7): il blocco «Automations» della Home e le
// approvazioni in «Da decidere» sulle rotte vere. Le pagine restano quelle
// del prototipo: l'adattatore parla la loro lingua (gli id delle
// esecuzioni, `invalid: not_waiting` per una decisione stantia).

const decision = (over: Partial<AutomationDecision> = {}): AutomationDecision =>
  ({
    kind: "approval",
    runId: "run-1",
    code: "AUD-A1 #3",
    title: "Kick-off",
    automationId: "a-1",
    automationName: "Avvio",
    projectId: "prj-1",
    stepKind: "createTask",
    preview: {},
    since: "2026-11-13T09:00:00.000Z",
    cursor: "1",
    automationCode: "AUD-A1",
    n: 3,
    automationVisible: true,
    clientName: "",
    effect: null,
    ...over,
  }) as AutomationDecision;

function fakeApi(over: Partial<DecisionApi> = {}) {
  const calls: string[] = [];
  const api: DecisionApi = {
    myRuns: async () => {
      calls.push("GET my runs");
      return [{ id: "run-1", code: "AUD-A1 #3", automationCode: "AUD-A1", n: 3 } as unknown as MyAutomationRun];
    },
    myApprovals: async () => {
      calls.push("GET my approvals");
      return { items: [decision({ round: 2 })] };
    },
    run: async (code, n) => {
      calls.push(`GET run ${code} ${n}`);
      return { id: "run-1", automationCode: code, n, cursor: "2", round: 0 } as unknown as AutomationRunDetail;
    },
    approve: async (code, n, body) => {
      calls.push(`POST approve ${code} ${n} ${JSON.stringify(body)}`);
    },
    reject: async (code, n, body) => {
      calls.push(`POST reject ${code} ${n} ${JSON.stringify(body)}`);
    },
    ...over,
  };
  return { api, calls };
}

describe("«Da decidere» e il blocco «Automations» sulle rotte vere", () => {
  it("le mie esecuzioni e le mie approvazioni sono quelle del server", async () => {
    const { api } = fakeApi();
    const d = createRealDecisions(api);
    expect((await d.listMyRuns()).map((r) => r.id)).toEqual(["run-1"]);
    expect((await d.listMyApprovals()).map((x) => x.runId)).toEqual(["run-1"]);
  });

  it("Approva va alla rotta dell'esecuzione col passo e il giro che chi decide ha visto", async () => {
    const { api, calls } = fakeApi();
    const d = createRealDecisions(api);
    await d.listMyApprovals();
    await d.approve("run-1", undefined, { expectedPath: "1" });
    await d.reject("run-1", { expectedPath: "1" });
    expect(calls.slice(1)).toEqual([
      `POST approve AUD-A1 3 {"expectedPath":"1","expectedRound":2}`,
      `POST reject AUD-A1 3 {"expectedPath":"1","expectedRound":2}`,
    ]);
  });

  it("un passo diverso da quello visto non porta il giro di prima (0)", async () => {
    const { api, calls } = fakeApi();
    const d = createRealDecisions(api);
    await d.listMyApprovals();
    await d.approve("run-1", { oggetto: "x" }, { expectedPath: "5" });
    expect(calls.at(-1)).toBe(`POST approve AUD-A1 3 {"expectedPath":"5","expectedRound":0,"edited":{"oggetto":"x"}}`);
  });

  it("una decisione stantia (409 stale): `invalid: not_waiting`, che la pagina sa dire («già deciso da …»)", async () => {
    const { api } = fakeApi({
      approve: async () => {
        throw new ApiError(409, "stale", "stale");
      },
    });
    const d = createRealDecisions(api);
    await d.listMyApprovals();
    await expect(d.approve("run-1", undefined, { expectedPath: "1" })).rejects.toThrow("invalid: not_waiting");
  });

  it("un ex approvatore (403) e un'esecuzione sospesa: gli errori del prototipo", async () => {
    const { api } = fakeApi({
      approve: async () => {
        throw new ApiError(403, "forbidden", "forbidden");
      },
      reject: async () => {
        throw new ApiError(409, "suspended", "suspended");
      },
    });
    const d = createRealDecisions(api);
    await d.listMyApprovals();
    await expect(d.approve("run-1", undefined, { expectedPath: "1" })).rejects.toThrow(/^forbidden$/);
    await expect(d.reject("run-1", { expectedPath: "1" })).rejects.toThrow("invalid: suspended");
  });

  it("chi ha deciso prima si rilegge dall'esecuzione; un'esecuzione mai vista non si decide", async () => {
    const { api } = fakeApi({
      run: async () => {
        throw new ApiError(404, "not_found", "not_found");
      },
    });
    const d = createRealDecisions(api);
    await d.listMyRuns();
    expect(await d.getRun("run-1")).toBeNull();
    await expect(d.approve("run-x", undefined, { expectedPath: "1" })).rejects.toThrow(/^not_found$/);
  });
});
