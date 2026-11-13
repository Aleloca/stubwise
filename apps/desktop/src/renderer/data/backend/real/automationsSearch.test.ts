import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { automations } from ".";
import { setAppClientForTests } from "./client";
import { installFakeServer } from "./fakeServer";

// ⌘K delle Automations nella build app (area 7, F1): il gruppo
// `automations` di `GET /api/search`, che filtra già per visibilità. A
// destinazione spenta (il flag) non si cerca: un risultato porterebbe a una
// pagina «in arrivo».

const flag = vi.hoisted(() => ({ on: false }));
vi.mock("../../integration", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../integration")>();
  return {
    ...actual,
    isIntegrated: (t: Parameters<typeof actual.isIntegrated>[0]) =>
      (flag.on && t.kind === "destination" && t.name === "automations") || actual.isIntegrated(t),
  };
});

const group = <T>(items: T[]) => ({ items, hasMore: false });
const hit = {
  kind: "automation",
  id: "77777777-7777-4777-8777-777777777771",
  code: "AUD-A1",
  label: "Avvio",
  route: "#/automations/AUD-A1",
  status: "active",
};
const results = {
  tickets: group([]),
  projects: group([]),
  repositories: group([]),
  docs: group([]),
  automations: group([hit]),
};

beforeEach(() => {
  setAppClientForTests(null);
  vi.stubEnv("VITE_STUBWISE_BUILD", "app");
});
afterEach(() => {
  flag.on = false;
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  setAppClientForTests(null);
});

describe("⌘K: automazioni ed esecuzioni dal server", () => {
  it("a destinazione accesa, il gruppo `automations` della ricerca", async () => {
    flag.on = true;
    const { seen } = installFakeServer({ "GET /api/search": { body: results } });
    expect(await automations.searchAutomations("avv")).toEqual([hit]);
    expect(seen.map((r) => r.path)).toEqual(["/api/search?q=avv&citable=true"]);
  });

  it("a destinazione spenta non si chiede niente", async () => {
    const { seen } = installFakeServer({ "GET /api/search": { body: results } });
    expect(await automations.searchAutomations("avv")).toEqual([]);
    expect(seen).toEqual([]);
  });

  it("un server senza il gruppo (più vecchio): nessun risultato", async () => {
    flag.on = true;
    const { automations: _omit, ...old } = results;
    void _omit;
    installFakeServer({ "GET /api/search": { body: old } });
    expect(await automations.searchAutomations("avv")).toEqual([]);
  });
});
