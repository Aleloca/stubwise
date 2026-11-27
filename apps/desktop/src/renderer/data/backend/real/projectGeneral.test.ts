import { ApiError } from "@stubwise/api-client";
import { describe, expect, it, vi } from "vitest";
import { isIntegrated } from "../../integration";
import { aiChoicesOf, createRealProjectGeneral, type ProjectGeneralApi } from "./projectGeneral";

// Settings → General e AI nella build app (ritiro del web vecchio, inventario
// 1.3) sulla `PATCH /api/projects/:id`.

const PRJ = "11111111-1111-4111-8111-111111111111";

function fakeApi(over: Partial<ProjectGeneralApi> = {}) {
  const api: ProjectGeneralApi = {
    get: vi.fn(async () => ({ id: PRJ, modules: ["releases"] })),
    patch: vi.fn(async () => ({})),
    providers: vi.fn(async () => []),
    ...over,
  };
  return api;
}

describe("General", () => {
  it("nome e descrizione ripuliti; una descrizione vuota si toglie (null)", async () => {
    const api = fakeApi();
    const real = createRealProjectGeneral(api);
    expect(await real.updateProjectGeneral(PRJ, { name: "  Acquedotto ", description: "   " })).toEqual({ ok: true });
    expect(api.patch).toHaveBeenCalledWith(PRJ, { name: "Acquedotto", description: null });
  });

  it("un nome vuoto si rifiuta senza chiamare il server", async () => {
    const api = fakeApi();
    expect(await createRealProjectGeneral(api).updateProjectGeneral(PRJ, { name: " " })).toMatchObject({
      ok: false,
      error: "invalid",
      reason: "name",
    });
    expect(api.patch).not.toHaveBeenCalled();
  });

  it("il modulo Docs: l'insieme intero dei moduli, con docs acceso; già acceso, nessuna scrittura", async () => {
    const api = fakeApi();
    const real = createRealProjectGeneral(api);
    expect(await real.setDocsModule(PRJ, true)).toEqual({ ok: true });
    expect(api.patch).toHaveBeenCalledWith(PRJ, { modules: ["releases", "docs"] });
    const on = fakeApi({ get: vi.fn(async () => ({ modules: ["docs"] })) });
    expect(await createRealProjectGeneral(on).setDocsModule(PRJ, true)).toEqual({ ok: true });
    expect(on.patch).not.toHaveBeenCalled();
  });

  it("i rifiuti del server come quelli del prototipo", async () => {
    const real = createRealProjectGeneral(
      fakeApi({
        patch: vi.fn(async () => {
          throw new ApiError(403, "forbidden", "forbidden");
        }),
      }),
    );
    expect(await real.updateProjectGeneral(PRJ, { name: "Nuovo" })).toEqual({ ok: false, error: "forbidden" });
  });
});

describe("AI", () => {
  it("l'account e «Use only this account»; senza account, esclusivo è sempre spento", async () => {
    const api = fakeApi();
    const real = createRealProjectGeneral(api);
    await real.setProjectAi(PRJ, { providerId: "prv-1", exclusive: true });
    expect(api.patch).toHaveBeenLastCalledWith(PRJ, { aiProviderId: "prv-1", aiProviderExclusive: true });
    await real.setProjectAi(PRJ, { providerId: null, exclusive: true });
    expect(api.patch).toHaveBeenLastCalledWith(PRJ, { aiProviderId: null, aiProviderExclusive: false });
  });

  it("le scelte nell'ordine del server; «Automatic» prova gli abbonamenti accesi, se no le chiavi API", () => {
    const providers = [
      { id: "b", label: "Max backup", kind: "account", position: 2, enabled: true, limitedUntil: null },
      { id: "a", label: "Max", kind: "account", position: 1, enabled: true, limitedUntil: "2026-11-28T00:00:00Z" },
      { id: "k", label: "API key", kind: "api_key", position: 3, enabled: true, limitedUntil: null },
    ];
    const r = aiChoicesOf(providers);
    expect(r.choices.map((c) => [c.id, c.kind, c.limited])).toEqual([
      ["a", "subscription", true],
      ["b", "subscription", false],
      ["k", "api_key", false],
    ]);
    expect(r.automaticChain).toEqual(["Max", "Max backup"]);
    expect(aiChoicesOf([providers[2]!]).automaticChain).toEqual(["API key"]);
  });
});

describe("integrazione", () => {
  it("General e AI sono sezioni integrate nella build app", () => {
    vi.stubEnv("VITE_STUBWISE_BUILD", "app");
    expect(isIntegrated({ kind: "projectSettings", name: "usage" })).toBe(false);
    expect(isIntegrated({ kind: "projectSettings", name: "general" })).toBe(true);
    expect(isIntegrated({ kind: "projectSettings", name: "ai" })).toBe(true);
    vi.unstubAllEnvs();
  });
});
