import { describe, expect, it, vi } from "vitest";
import { createStubwiseClient } from "../client.js";

// La ricerca globale: `citable` chiede il gruppo docs delle sole pagine
// citabili (niente note di rilascio), per «#» e ⌘K del desktop.

const empty = {
  tickets: { items: [], hasMore: false },
  projects: { items: [], hasMore: false },
  repositories: { items: [], hasMore: false },
  docs: { items: [], hasMore: false },
};

function client() {
  const fetchImpl = vi.fn<(url: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(
    async () => new Response(JSON.stringify(empty), { status: 200, headers: { "content-type": "application/json" } }),
  );
  return { c: createStubwiseClient({ baseUrl: "", getAuthHeader: () => null, fetch: fetchImpl }), fetchImpl };
}

describe("endpoints search", () => {
  it("global senza opzioni: solo q (il comportamento di prima)", async () => {
    const { c, fetchImpl } = client();
    await c.search.global("auth");
    expect(String(fetchImpl.mock.calls.at(-1)![0])).toBe("/api/search?q=auth");
  });

  it("global con citable: aggiunge citable=true", async () => {
    const { c, fetchImpl } = client();
    await c.search.global("auth", undefined, { citable: true });
    expect(String(fetchImpl.mock.calls.at(-1)![0])).toBe("/api/search?q=auth&citable=true");
  });
});
