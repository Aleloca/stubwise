import { ApiError } from "@stubwise/api-client";
import { describe, expect, it } from "vitest";
import { createRealModels, type ModelsApi } from "./aiModels";

// Area 9, F3: AI → Models su `/api/settings/models` (72, bc6a4dfe0).

function fakeApi(over: Partial<ModelsApi> = {}) {
  const calls: unknown[] = [];
  const api: ModelsApi = {
    get: async () => ({
      operations: [
        {
          operation: "fix_plan",
          configurable: true,
          model: "opus",
          workerDefault: "sonnet",
          source: "setting",
          fallbackSource: "env",
        },
        {
          operation: "daily_report",
          configurable: true,
          model: null,
          workerDefault: "claude-haiku-5-5",
          source: "env",
          fallbackSource: "env",
        },
        {
          operation: "plugin_smoke",
          configurable: false,
          model: null,
          workerDefault: "haiku",
          source: "default",
          fallbackSource: "default",
        },
        {
          operation: "chat",
          configurable: true,
          model: null,
          workerDefault: null,
          source: "default",
          fallbackSource: "default",
        },
      ],
      choices: ["haiku", "sonnet", "opus"],
    }),
    set: async (models) => {
      calls.push(models);
      return {};
    },
    ...over,
  };
  return { api, calls };
}

describe("Models dal server (area 9, F3)", () => {
  it("le operazioni configurabili col gruppo; il ripiego con la sua fonte; l'id dell'env com'è", async () => {
    const rows = await createRealModels(fakeApi().api).listModels();
    expect(rows.map((r) => r.operation)).toEqual(["fix_plan", "daily_report", "chat"]);
    expect(rows[0]).toMatchObject({
      model: "opus",
      source: "setting",
      // «Use default» riporta all'env del worker: lo dice il server.
      fallback: { model: "sonnet", source: "env" },
    });
    expect(rows[0]!.group).toBeTruthy();
    expect(rows[1]).toMatchObject({
      model: "claude-haiku-5-5",
      source: "env",
      fallback: { model: "claude-haiku-5-5", source: "env" },
    });
    // Il worker non ha mai pubblicato i default: «—».
    expect(rows[2]).toMatchObject({ model: "—", fallback: { model: "—", source: "default" } });
  });

  it("scegliere manda solo quell'operazione; null torna al default; i rifiuti", async () => {
    const { api, calls } = fakeApi();
    const m = createRealModels(api);
    expect(await m.setModel("fix_plan", "haiku")).toEqual({ ok: true });
    expect(await m.setModel("fix_plan", null)).toEqual({ ok: true });
    expect(calls).toEqual([{ fix_plan: "haiku" }, { fix_plan: null }]);
    const no = createRealModels(
      fakeApi({
        set: async () => {
          throw new ApiError(403, "forbidden", "forbidden");
        },
      }).api,
    );
    expect(await no.setModel("fix_plan", "opus")).toEqual({ ok: false, error: "forbidden" });
  });
});
