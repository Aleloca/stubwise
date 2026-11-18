import { ApiError } from "@stubwise/api-client";
import { describe, expect, it } from "vitest";
import { createRealBudget, type BudgetApi } from "./budget";

// Area 9, F4: AI → Budget & language su `/api/settings/instance` (72, 58af0dcd3).

const settings = (over: Record<string, unknown> = {}) => ({
  contentLanguage: "en",
  monthlyBudgetUsd: 600,
  spentUsd: 412.5,
  budgetReached: false,
  budgetEffect: null,
  s3Bucket: "files",
  ...over,
});

function fakeApi(over: Partial<BudgetApi> = {}) {
  const saved: unknown[] = [];
  const api: BudgetApi = {
    get: async () => settings(),
    save: async (input) => {
      saved.push(input);
      return settings({ ...input, budgetEffect: "released", spentUsd: 412.5 });
    },
    ...over,
  };
  return { api, saved };
}

describe("Budget & language dal server (area 9, F4)", () => {
  it("la lettura: tetto, speso del mese, raggiunto e lingua dal server; nessuna simulazione", async () => {
    expect(await createRealBudget(fakeApi().api).getBudget()).toEqual({
      monthlyUsd: 600,
      spentUsd: 412.5,
      reached: false,
      simulated: false,
      contentLanguage: "en",
    });
  });

  it("«raggiunto» è del server, non un confronto del client fra speso e tetto", async () => {
    const b = createRealBudget(
      fakeApi({
        get: async () => settings({ spentUsd: 100, monthlyBudgetUsd: 600, budgetReached: true }),
      }).api,
    );
    expect((await b.getBudget()).reached).toBe(true);
  });

  it("salvare: tetto e lingua (solo loro: l'archiviazione resta); l'effetto lo dice il server", async () => {
    const { api, saved } = fakeApi();
    expect(
      await createRealBudget(api).saveBudget({ monthlyUsd: 800, contentLanguage: "it" }),
    ).toEqual({
      ok: true,
      effect: "released",
      simulated: false,
      spentUsd: 412.5,
    });
    expect(saved).toEqual([{ contentLanguage: "it", monthlyBudgetUsd: 800 }]);
    const none = createRealBudget(
      fakeApi({ save: async (input) => settings({ ...input, budgetEffect: null }) }).api,
    );
    expect(await none.saveBudget({ monthlyUsd: null, contentLanguage: "en" })).toMatchObject({
      effect: "none",
    });
  });

  it("i rifiuti: senza permesso, un importo non valido", async () => {
    const no = createRealBudget(
      fakeApi({
        save: async () => {
          throw new ApiError(403, "forbidden", "forbidden");
        },
      }).api,
    );
    expect(await no.saveBudget({ monthlyUsd: 1, contentLanguage: "en" })).toEqual({
      ok: false,
      error: "forbidden",
    });
    const bad = createRealBudget(
      fakeApi({
        save: async () => {
          throw new ApiError(400, "body/monthlyBudgetUsd must be >= 0", "FST_ERR_VALIDATION");
        },
      }).api,
    );
    expect(await bad.saveBudget({ monthlyUsd: -1, contentLanguage: "en" })).toEqual({
      ok: false,
      error: "invalid",
      reason: "amount",
    });
  });
});
