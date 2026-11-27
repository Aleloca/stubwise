import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setAppClientForTests } from "./client";
import { docs } from "./docs";
import { installFakeServer } from "./fakeServer";

// Lo zip di una categoria e il `graph.json` veri dei Docs nella build app
// (ritiro del web vecchio, inventario 1.5): prima erano uno zip finto (un
// indice di testo) e un JSON composto dallo stato.

const REPO = "11111111-1111-4111-8111-111111111111";

beforeEach(() => {
  setAppClientForTests(null);
  vi.stubEnv("VITE_STUBWISE_BUILD", "app");
  URL.createObjectURL = vi.fn(() => "blob:x");
  URL.revokeObjectURL = vi.fn();
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  setAppClientForTests(null);
});

describe("lo zip di una categoria", () => {
  it("nel browser: la rotta del server col cookie, e il file salvato col suo nome", async () => {
    const zip = new Uint8Array([0x50, 0x4b, 3, 4]);
    const fetch = vi.fn(async () => new Response(zip, { status: 200, headers: { "content-disposition": 'attachment; filename="manual.zip"' } }));
    vi.stubGlobal("fetch", fetch);
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    expect(await docs.exportCategory(REPO, "manual")).toEqual({ ok: true });
    expect(fetch).toHaveBeenCalledWith(`/api/repositories/${REPO}/docs/export?kind=manual`, { credentials: "include" });
    expect(click).toHaveBeenCalled();
    expect((click.mock.instances[0] as unknown as HTMLAnchorElement).download).toBe("manual.zip");
  });

  it("sull'app desktop: si apre nel browser di sistema (la rotta risponde col file, non con un 302)", async () => {
    const openWeb = vi.fn(async () => ({ ok: true }));
    vi.stubGlobal("stubwise", { api: {}, openWeb });
    expect(await docs.exportCategory(REPO, "technical")).toEqual({ ok: true });
    expect(openWeb).toHaveBeenCalledWith(`/api/repositories/${REPO}/docs/export?kind=technical`);
  });

  it("un 404 dice che non c'è, senza salvare niente", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 404 })));
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    expect(await docs.exportCategory(REPO, "manual")).toEqual({ ok: false, reason: "not_found" });
    expect(click).not.toHaveBeenCalled();
  });
});

describe("graph.json", () => {
  it("il file vero del server, salvato come graph.json", async () => {
    installFakeServer({ [`GET /api/repositories/${REPO}/graph/json`]: { body: { nodes: [{ id: "a" }], links: [] } } });
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    expect(await docs.downloadGraphJson(REPO)).toEqual({ ok: true });
    expect((click.mock.instances[0] as unknown as HTMLAnchorElement).download).toBe("graph.json");
  });

  it("senza grafo (404): non c'è", async () => {
    installFakeServer({});
    expect(await docs.downloadGraphJson(REPO)).toEqual({ ok: false, reason: "not_found" });
  });
});
