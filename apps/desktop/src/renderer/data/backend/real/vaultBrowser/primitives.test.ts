import { afterEach, describe, expect, it, vi } from "vitest";

// Cassaforte nel browser, design §2.4 (C2): le primitive si catturano al
// PRIMO import, prima di qualunque altro codice dell'app; uno script arrivato
// dopo non le sostituisce più per la cassaforte.

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("le primitive catturate", () => {
  it("fetch e la cerimonia della passkey restano quelle del primo import", async () => {
    const realFetch = vi.fn(async () => new Response("{}"));
    const realGet = vi.fn(async () => null);
    vi.stubGlobal("fetch", realFetch);
    vi.stubGlobal("navigator", { ...navigator, credentials: { get: realGet, create: vi.fn() } });
    vi.resetModules();
    const { primitives } = await import("./primitives");
    // Arriva uno script dopo e li sostituisce.
    const hostileFetch = vi.fn();
    const hostileGet = vi.fn();
    vi.stubGlobal("fetch", hostileFetch);
    vi.stubGlobal("navigator", { ...navigator, credentials: { get: hostileGet, create: vi.fn() } });
    await primitives.fetch("/api/x");
    await primitives.credentialsGet({ publicKey: {} as PublicKeyCredentialRequestOptions });
    expect(realFetch).toHaveBeenCalledWith("/api/x");
    expect(realGet).toHaveBeenCalled();
    expect(hostileFetch).not.toHaveBeenCalled();
    expect(hostileGet).not.toHaveBeenCalled();
  });

  it("è congelato: non si riassegna", async () => {
    vi.resetModules();
    const { primitives } = await import("./primitives");
    expect(Object.isFrozen(primitives)).toBe(true);
  });
});
