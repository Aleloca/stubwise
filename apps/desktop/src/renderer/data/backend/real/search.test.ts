import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setAppClientForTests } from "./client";
import { installFakeServer, serverProject } from "./fakeServer";
import { search } from "./search";

// ⌘K nella build app: la ricerca globale con `citable` (area 5, fetta 1), così
// il gruppo Docs non porta le note di rilascio, che non sono pagine.

beforeEach(() => {
  setAppClientForTests(null);
  vi.stubEnv("VITE_STUBWISE_BUILD", "app");
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  setAppClientForTests(null);
});

const empty = { items: [], hasMore: false };

describe("⌘K nella build app", () => {
  it("chiede la ricerca globale con citable=true", async () => {
    const { seen } = installFakeServer({
      "GET /api/projects": { body: [serverProject()] },
      "GET /api/search": { body: { tickets: empty, projects: empty, repositories: empty, docs: empty } },
    });
    const rows = await search("audin");
    const call = seen.find((r) => r.path.startsWith("/api/search"))!;
    expect(new URL(`http://x${call.path}`).searchParams.get("citable")).toBe("true");
    expect(rows.map((r) => r.kind)).toEqual(["project"]);
  });
});
