import { ApiError } from "@stubwise/api-client";
import { describe, expect, it } from "vitest";
import { createRealAutomation, type AutomationApi } from "./automation";

// Area 9, F3: la scheda Automation sulle rotte di 72 (`/api/settings/automation`).
// Il server ha cinque tipi; la pagina ne mostra tre (la riga di `activity` è
// `task`): `feedback` e `review` restano com'erano, a ogni salvataggio.

const rule = (type: string, maxEffort = 2) => ({
  type,
  autoFix: true,
  maxEffort,
  planApprovalMinEffort: null,
  maxCostUsd: null,
});

function fakeApi(over: Partial<AutomationApi> = {}) {
  const saved: unknown[] = [];
  const api: AutomationApi = {
    get: async () => ({
      rules: [
        rule("bug", 2),
        rule("feature", 3),
        rule("task", 1),
        rule("feedback", 4),
        rule("review", 5),
      ],
      prReview: { enabled: true, maxCostUsd: 2 },
    }),
    save: async (input) => {
      saved.push(input);
      return input as never;
    },
    ...over,
  };
  return { api, saved };
}

describe("Automation dal server (area 9, F3)", () => {
  it("la lettura: tre righe nell'ordine del prototipo, activity dalla regola di task", async () => {
    const a = await createRealAutomation(fakeApi().api).getAutomation();
    expect(a.rules.map((r) => [r.taskType, r.maxEffort])).toEqual([
      ["bug", 2],
      ["feature", 3],
      ["activity", 1],
    ]);
    expect(a.prReview).toEqual({ enabled: true, maxCostUsd: 2 });
  });

  it("salvare: le tre righe sui loro tipi; feedback e review mandati com'erano", async () => {
    const { api, saved } = fakeApi();
    const auto = createRealAutomation(api);
    const a = await auto.getAutomation();
    expect(
      await auto.saveAutomation({
        rules: a.rules.map((r) => (r.taskType === "activity" ? { ...r, maxEffort: 4 } : r)),
        prReview: { enabled: false, maxCostUsd: null },
      }),
    ).toEqual({ ok: true });
    expect(saved[0]).toEqual({
      rules: [
        rule("bug", 2),
        rule("feature", 3),
        rule("task", 4),
        rule("feedback", 4),
        rule("review", 5),
      ],
      prReview: { enabled: false, maxCostUsd: null },
    });
  });

  it("i rifiuti: senza permesso forbidden; una regola non valida invalid", async () => {
    const forbidden = createRealAutomation(
      fakeApi({
        save: async () => {
          throw new ApiError(403, "forbidden", "forbidden");
        },
      }).api,
    );
    const a = await forbidden.getAutomation();
    expect(await forbidden.saveAutomation(a)).toEqual({ ok: false, error: "forbidden" });
    const bad = createRealAutomation(
      fakeApi({
        save: async () => {
          throw new ApiError(400, "body/rules/0/maxEffort must be <= 5", "FST_ERR_VALIDATION");
        },
      }).api,
    );
    expect(await bad.saveAutomation(a)).toEqual({ ok: false, error: "invalid", reason: "effort" });
  });
});
