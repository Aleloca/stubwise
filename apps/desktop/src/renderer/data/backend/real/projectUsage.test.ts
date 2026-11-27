import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setAppClientForTests } from "./client";
import { installFakeServer } from "./fakeServer";
import { getProjectUsage } from "./usage";

// Progetto → Settings → Usage nella build app (ritiro del web vecchio,
// inventario 1.3): la stessa lettura di AI → Usage col filtro `projectId`.

const PRJ = "11111111-1111-4111-8111-111111111111";
const summary = {
  totals: { costUsd: 7, inputTokens: 200, outputTokens: 100, cacheReadTokens: 0, runs: 2 },
  byDay: [],
  rows: [],
};

beforeEach(() => {
  setAppClientForTests(null);
  vi.stubEnv("VITE_STUBWISE_BUILD", "app");
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  setAppClientForTests(null);
});

describe("Settings → Usage", () => {
  it("chiede i consumi col projectId del progetto", async () => {
    const { seen } = installFakeServer({ "GET /api/ai-usage/summary": { body: summary } });
    const view = await getProjectUsage(PRJ, { range: { days: 30 }, groupBy: "model" });
    expect(view?.totals.costUsd).toBe(7);
    const q = new URL(`http://x${seen[0]!.path}`).searchParams;
    expect(q.get("projectId")).toBe(PRJ);
    expect(q.get("groupBy")).toBe("model");
  });

  it("un progetto fuori scope o invisibile (404): null, come il prototipo", async () => {
    installFakeServer({});
    expect(await getProjectUsage(PRJ, { range: { days: 30 }, groupBy: "model" })).toBeNull();
  });
});
