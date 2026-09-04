import { describe, expect, it, vi } from "vitest";
import { createStubwiseClient } from "../index.js";

function clientReturning(body: unknown) {
  const fetchImpl = vi.fn<typeof globalThis.fetch>(
    async () => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } }),
  );
  const client = createStubwiseClient({ baseUrl: "", getAuthHeader: () => null, fetch: fetchImpl });
  return { client, fetchImpl };
}

describe("endpoint activity", () => {
  it("forDate: GET /api/activity con la data in query, percent-encoded", async () => {
    const { client, fetchImpl } = clientReturning({ date: "2026-09-01", projects: [] });
    await client.activity.forDate("2026-09-01");
    const [url, init] = fetchImpl.mock.calls.at(-1)!;
    expect(String(url)).toBe("/api/activity?date=2026-09-01");
    expect(String(init!.method)).toBe("GET");
  });

  it("estrae solo il sottoinsieme dichiarato, per progetto", async () => {
    const { client } = clientReturning({
      date: "2026-09-01",
      projects: [
        {
          project: { id: "11111111-1111-4111-8111-111111111111", name: "Portale B2B", slug: "portale-b2b" },
          status: "done",
          summary: "3 commit, un fix.",
          header: { commitCount: 3, additions: 1, deletions: 1, authorCount: 1 },
        },
      ],
      developers: [],
      developersSummaryPending: false,
      staleCommitTotal: 0,
    });

    const result = await client.activity.forDate("2026-09-01");
    expect(result.projects).toEqual([
      {
        project: { id: "11111111-1111-4111-8111-111111111111", name: "Portale B2B", slug: "portale-b2b" },
        status: "done",
        summary: "3 commit, un fix.",
      },
    ]);
  });
});
