import { describe, expect, it, vi } from "vitest";
import { createStubwiseClient } from "../index.js";

const ID = "11111111-1111-4111-8111-111111111111";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function clientReturning(body: unknown, status = 200) {
  const fetchImpl = vi.fn<typeof globalThis.fetch>(async () => jsonResponse(status, body));
  const client = createStubwiseClient({ baseUrl: "", getAuthHeader: () => null, fetch: fetchImpl });
  return { client, fetchImpl };
}

/** Ultima chiamata a fetch, come coppia `[url, metodo]`. */
function lastCall(fetchImpl: ReturnType<typeof clientReturning>["fetchImpl"]): [string, string] {
  const [url, init] = fetchImpl.mock.calls.at(-1)!;
  return [String(url), String(init!.method)];
}

describe("endpoints backlog — stato del job di intake", () => {
  it("job: GET sulla rotta del job e legge esito e voce risultante", async () => {
    const JOB_ID = "33333333-3333-4333-8333-333333333333";
    const { client, fetchImpl } = clientReturning({ status: "done", resultItemId: ID, error: null });
    const job = await client.backlog.job(JOB_ID);
    expect(lastCall(fetchImpl)).toEqual([`/api/backlog/jobs/${JOB_ID}`, "GET"]);
    expect(job).toEqual({ status: "done", resultItemId: ID, error: null });
  });
});
