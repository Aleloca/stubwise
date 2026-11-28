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

  it("la cronologia: lettura (con lo spazio), registrazione, togliere una voce, svuotare", async () => {
    const fetchImpl = vi.fn<(url: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(async (url) =>
      String(url).startsWith("/api/search/history") && !String(url).includes("/ticket/")
        ? new Response(JSON.stringify([{ type: "project", entityId: "p1", title: "Web", subtitle: "WEB", route: "#/p/WEB/tasks", repositoryId: null, clickedAt: "2026-11-27T10:00:00.000Z" }]), { status: 200, headers: { "content-type": "application/json" } })
        : new Response(null, { status: 204 }),
    );
    const c = createStubwiseClient({ baseUrl: "", getAuthHeader: () => null, fetch: fetchImpl });
    expect(await c.search.history("11111111-1111-4111-8111-111111111111")).toHaveLength(1);
    expect(String(fetchImpl.mock.calls.at(-1)![0])).toBe("/api/search/history?repositoryId=11111111-1111-4111-8111-111111111111");
    await c.search.remember({ type: "ticket", entityId: "t1", title: "Fix", subtitle: "WEB-1", route: "#/p/WEB/tasks?task=WEB-1" });
    expect(fetchImpl.mock.calls.at(-1)![1]?.method).toBe("POST");
    await c.search.forget("ticket", "a:b/c");
    expect(String(fetchImpl.mock.calls.at(-1)![0])).toBe("/api/search/history/ticket/a%3Ab%2Fc");
    expect(fetchImpl.mock.calls.at(-1)![1]?.method).toBe("DELETE");
    await c.search.clearHistory();
    expect(String(fetchImpl.mock.calls.at(-1)![0])).toBe("/api/search/history");
    expect(fetchImpl.mock.calls.at(-1)![1]?.method).toBe("DELETE");
  });
});
