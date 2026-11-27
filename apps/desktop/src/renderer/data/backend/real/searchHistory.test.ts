import { afterEach, describe, expect, it } from "vitest";
import { setAppClientForTests } from "./client";
import { installFakeServer, serverProject, serverTicketDetail } from "./fakeServer";
import { liveSearchHistory } from "./searchHistory";

// I recenti della ⌘K sulla cronologia del server.

afterEach(() => setAppClientForTests(null));

const row = (over: Record<string, unknown>) => ({
  type: "ticket",
  entityId: "44444444-4444-4444-8444-444444444444",
  title: "Fix the export",
  subtitle: "AUD-9",
  route: "#/p/AUD/tasks?task=AUD-9",
  repositoryId: null,
  clickedAt: "2026-11-27T10:00:00.000Z",
  ...over,
});

describe("i recenti della ⌘K sul server", () => {
  it("I1 (a): l'indirizzo si ricostruisce da tipo e oggetto, anche per le voci del web vecchio; tipi ignoti e oggetti spariti fuori (M5)", async () => {
    const P = "22222222-2222-4222-8222-222222222222";
    const R = "33333333-3333-4333-8333-333333333333";
    const T = "44444444-4444-4444-8444-444444444444";
    const { seen } = installFakeServer({
      "GET /api/search/history": {
        body: [
          row({ type: "ticket", entityId: T, route: `/tickets/${T}`, subtitle: "Audin" }),
          row({ type: "project", entityId: P, title: "Audin", route: `/projects/${P}`, subtitle: null }),
          row({ type: "doc", entityId: "guide", title: "Guide", route: "/docs/x/guide", repositoryId: R, subtitle: null }),
          row({ type: "doc", entityId: `${R}:setup`, title: "Setup", route: "#/vecchio", repositoryId: R, subtitle: "AUD-D3" }),
          row({ type: "repository", entityId: R, title: "web", route: "/docs/x", subtitle: null }),
          row({ type: "mail", entityId: "m1", title: "Una mail", route: "#/mail/m1" }),
          row({ type: "ticket", entityId: "55555555-5555-4555-8555-555555555555", route: "#/p/AUD/tasks?task=AUD-1" }),
        ],
      },
      "GET /api/projects": { body: [serverProject({ id: P, code: "AUD" })] },
      "GET /api/repositories": {
        body: [{ id: R, projectId: P, name: "web", slug: "web", provider: "github", repoUrl: "https://github.com/acme/web", defaultBranch: "main", createdAt: "2026-01-01T00:00:00.000Z" }],
      },
      [`GET /api/tickets/${T}`]: { body: serverTicketDetail({ id: T, projectId: P, number: 9 }) },
    });
    const out = await liveSearchHistory.listRecentResults!("11111111-1111-4111-8111-111111111111");
    expect(out.map((r) => [r.type, r.code, r.route])).toEqual([
      ["ticket", "AUD-9", "#/p/AUD/tasks?task=AUD-9"],
      ["project", "AUD", "#/p/AUD/tasks"],
      ["doc", null, "#/p/AUD/docs/web/guide"],
      ["doc", "AUD-D3", "#/p/AUD/docs/web/setup"],
      ["repository", null, "#/p/AUD/docs/web"],
    ]);
    expect(seen[0]!.path).toBe("/api/search/history?repositoryId=11111111-1111-4111-8111-111111111111");
  });

  it("registrare, togliere, svuotare: le rotte del server, il codice in subtitle", async () => {
    const { seen } = installFakeServer({
      "POST /api/search/history": { status: 204 },
      "DELETE /api/search/history/doc/r1%3Aguide": { status: 204 },
      "DELETE /api/search/history": { status: 204 },
    });
    await liveSearchHistory.rememberResult!({ type: "doc", entityId: "r1:guide", code: "AUD-D3", title: "Guide", route: "#/p/AUD/docs/web/guide", repositoryId: "r1" });
    expect(seen.at(-1)).toMatchObject({ method: "POST", body: { type: "doc", entityId: "r1:guide", subtitle: "AUD-D3", repositoryId: "r1" } });
    await liveSearchHistory.forgetResult!("doc", "r1:guide");
    expect(seen.at(-1)).toMatchObject({ method: "DELETE", path: "/api/search/history/doc/r1%3Aguide" });
    await liveSearchHistory.clearRecentResults!();
    expect(seen.at(-1)).toMatchObject({ method: "DELETE", path: "/api/search/history" });
  });
});
