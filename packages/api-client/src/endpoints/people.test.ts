import { describe, expect, it, vi } from "vitest";
import { createStubwiseClient } from "../index.js";

const D = "7f1c2a1e-0000-4000-8000-0000000000d1";

describe("people.activity (area 3, fetta 3d)", () => {
  it("GET /api/people/activity col giorno e il reparto; una riga di un server senza i campi nuovi prende i default", async () => {
    const fetchImpl = vi.fn<typeof globalThis.fetch>(
      async () =>
        new Response(JSON.stringify([{ personId: null, name: "Esterno" }]), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    const client = createStubwiseClient({ baseUrl: "", getAuthHeader: () => null, fetch: fetchImpl });
    const [row] = await client.people.activity("2026-11-09", D);
    const url = new URL(String(fetchImpl.mock.calls[0]![0]), "http://x");
    expect(url.pathname).toBe("/api/people/activity");
    expect(Object.fromEntries(url.searchParams)).toEqual({ date: "2026-11-09", departmentId: D });
    expect(row).toMatchObject({ name: "Esterno", tasksClosed: [], commits: [], departmentIds: [] });
  });
});
