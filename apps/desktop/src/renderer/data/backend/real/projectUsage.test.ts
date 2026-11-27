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

  it("M3: un server di prima ignora `projectId` (righe di altri progetti): «server_outdated», non i consumi dell'istanza", async () => {
    const row = (key: string) => ({ key, label: key, code: null, costUsd: 1, tokens: 1, runs: 1, children: [] });
    installFakeServer({
      "GET /api/ai-usage/summary": (req: { path: string }) => ({
        body: new URL(`http://x${req.path}`).searchParams.get("groupBy") === "project"
          ? { ...summary, rows: [row(PRJ), row("22222222-2222-4222-8222-222222222222")] }
          : summary,
      }),
    });
    await expect(getProjectUsage(PRJ, { range: { days: 30 }, groupBy: "model" })).rejects.toThrow("server_outdated");
  });

  it("M3: un server nuovo dà le sole righe del progetto: si legge", async () => {
    const row = (key: string) => ({ key, label: key, code: null, costUsd: 1, tokens: 1, runs: 1, children: [] });
    installFakeServer({ "GET /api/ai-usage/summary": { body: { ...summary, rows: [row(PRJ)] } } });
    expect((await getProjectUsage(PRJ, { range: { days: 30 }, groupBy: "model" }))?.totals.costUsd).toBe(7);
  });
});
