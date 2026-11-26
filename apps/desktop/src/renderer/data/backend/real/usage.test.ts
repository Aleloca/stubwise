import { ApiError } from "@stubwise/api-client";
import { describe, expect, it } from "vitest";
import { createRealUsage, type UsageApi } from "./usage";

// Area 9, F4: AI → Usage su `GET /api/ai-usage/summary` (72, 923003b24), nella
// forma del prototipo: raggruppamento, giorni a zero e «Other projects» (R-G5)
// li fa il server.

const summary = () => ({
  totals: { costUsd: 12.5, inputTokens: 1000, outputTokens: 500, cacheReadTokens: 200, runs: 7 },
  byDay: [{ day: "2026-11-18", costUsd: 12.5, runs: 7 }],
  rows: [
    { key: "p1", label: "Acquedotto", code: "ACQ", costUsd: 8, tokens: 900, runs: 4, children: [] },
    { key: "other", label: "other", code: null, costUsd: 3, tokens: 400, runs: 2, children: [] },
    {
      key: "none",
      label: "none",
      code: null,
      costUsd: 1.5,
      tokens: 200,
      runs: 1,
      children: [{ key: "none", label: "none", code: null, costUsd: 1.5, tokens: 200, runs: 1 }],
    },
  ],
});

function fakeApi(over: Partial<UsageApi> = {}) {
  const calls: unknown[] = [];
  const api: UsageApi = {
    summary: async (input) => {
      calls.push(input);
      return summary();
    },
    ...over,
  };
  return { api, calls };
}

describe("i consumi dal server (area 9, F4)", () => {
  it("passa intervallo e raggruppamenti; «none» è la riga senza (key null), «other» resta", async () => {
    const { api, calls } = fakeApi();
    const v = await createRealUsage(api).getUsage({
      range: { days: 30 },
      groupBy: "project",
      thenBy: "provider",
    });
    expect(calls).toEqual([{ range: { days: 30 }, groupBy: "project", thenBy: "provider" }]);
    expect(v.totals.runs).toBe(7);
    expect(v.rows.map((r) => [r.key, r.code ?? null])).toEqual([
      ["p1", "ACQ"],
      ["other", null],
      [null, null],
    ]);
    expect(v.rows[2]!.children[0]!.key).toBeNull();
  });

  it("un intervallo che il server rifiuta è un errore che la scheda dice", async () => {
    const bad = createRealUsage(
      fakeApi({
        summary: async () => {
          throw new ApiError(400, "range_too_long", "range_too_long");
        },
      }).api,
    );
    await expect(
      bad.getUsage({ range: { from: "2024-01-01", to: "2026-01-01" }, groupBy: "day" }),
    ).rejects.toThrow("range_too_long");
  });
});
