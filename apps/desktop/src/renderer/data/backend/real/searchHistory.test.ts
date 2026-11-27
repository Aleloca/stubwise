import { afterEach, describe, expect, it } from "vitest";
import { setAppClientForTests } from "./client";
import { installFakeServer } from "./fakeServer";
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
  it("la lettura: il codice da subtitle; via le voci del web vecchio; lo spazio passa come repositoryId", async () => {
    const { seen } = installFakeServer({
      "GET /api/search/history": { body: [row({}), row({ entityId: "x", route: "/tickets/x" })] },
    });
    expect(await liveSearchHistory.listRecentResults!("11111111-1111-4111-8111-111111111111")).toEqual([
      { type: "ticket", entityId: "44444444-4444-4444-8444-444444444444", code: "AUD-9", title: "Fix the export", route: "#/p/AUD/tasks?task=AUD-9", repositoryId: null, openedAt: "2026-11-27T10:00:00.000Z" },
    ]);
    expect(seen.at(-1)!.path).toBe("/api/search/history?repositoryId=11111111-1111-4111-8111-111111111111");
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
