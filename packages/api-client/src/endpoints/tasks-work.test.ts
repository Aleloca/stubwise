import { describe, expect, it, vi } from "vitest";
import { createStubwiseClient } from "../index.js";

const T = "7f1c2a1e-0000-4000-8000-0000000000a1";
const J = "7f1c2a1e-0000-4000-8000-0000000000a2";

function clientReturning(body: unknown) {
  const fetchImpl = vi.fn<typeof globalThis.fetch>(
    async () => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } }),
  );
  return createStubwiseClient({ baseUrl: "", getAuthHeader: () => null, fetch: fetchImpl });
}

/** `tasks.work` passa da `readerSchema` (area 3, fetta 3a): un server della fetta 1 non manda i campi nuovi, uno più nuovo manda valori ignoti. */
describe("tasks.work", () => {
  it("un server della fetta 1 (senza i campi nuovi): i default, la sezione degrada", async () => {
    const work = await clientReturning({ claude: "none", pullRequests: [], webHref: `/tickets/${T}` }).tasks.work(T);
    expect(work).toMatchObject({
      runs: [],
      hiddenRuns: false,
      prFacts: [],
      actions: { start: "unavailable", relaunch: "unavailable", resume: "unavailable", requestChanges: "unavailable" },
      blocked: null,
    });
  });

  it("un valore ignoto di un server più nuovo arriva come UNKNOWN, non fa fallire il parse", async () => {
    const work = await clientReturning({
      claude: "working",
      pullRequests: [],
      webHref: `/tickets/${T}`,
      runs: [{ id: J, createdAt: "2026-11-10T10:00:00.000Z", state: "uno_stato_nuovo" }],
      actions: { start: "una_disponibilita_nuova" },
    }).tasks.work(T);
    expect(work.runs).toHaveLength(1);
    expect(work.runs[0]!.state).toBe("__unknown__");
    expect(work.actions.start).toBe("__unknown__");
    expect(work.actions.relaunch).toBe("unavailable");
  });
});

describe("tasks.cancelRun (area 3, fetta 3b)", () => {
  it("POST /api/tasks/:id/cancel-run e restituisce il lavoro aggiornato", async () => {
    const fetchImpl = vi.fn<typeof globalThis.fetch>(
      async () =>
        new Response(JSON.stringify({ claude: "none", pullRequests: [], webHref: `/tickets/${T}` }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    const client = createStubwiseClient({ baseUrl: "", getAuthHeader: () => null, fetch: fetchImpl });
    const work = await client.tasks.cancelRun(T);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(String(url)).toBe(`/api/tasks/${T}/cancel-run`);
    expect(init!.method).toBe("POST");
    expect(work.actions.relaunch).toBe("unavailable");
  });
});
