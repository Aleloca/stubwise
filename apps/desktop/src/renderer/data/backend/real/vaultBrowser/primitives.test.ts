import { afterEach, describe, expect, it, vi } from "vitest";

// Cassaforte nel browser, design §2.4 e revisione I-1: le primitive della
// pagina si catturano al PRIMO import, e i METODI in forma uncurried; uno
// script arrivato dopo non le sostituisce più per la cassaforte.

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
    vi.stubGlobal("fetch", vi.fn());
    vi.stubGlobal("navigator", { ...navigator, credentials: { get: vi.fn(), create: vi.fn() } });
    await primitives.fetch("/api/x");
    await primitives.credentialsGet({ publicKey: {} as PublicKeyCredentialRequestOptions });
    expect(realFetch).toHaveBeenCalledWith("/api/x");
    expect(realGet).toHaveBeenCalled();
  });

  it("I-1: un METODO sostituito sul prototipo dopo il boot non cambia quello catturato", async () => {
    class Cred {
      getClientExtensionResults() {
        return { prf: { results: { first: new ArrayBuffer(1) } } };
      }
    }
    vi.stubGlobal("PublicKeyCredential", Cred);
    vi.resetModules();
    const { primitives } = await import("./primitives");
    const hostile = vi.fn(() => ({}));
    Cred.prototype.getClientExtensionResults = hostile as never;
    const originalSlice = ArrayBuffer.prototype.slice;
    const slice = vi.fn(originalSlice);
    ArrayBuffer.prototype.slice = slice as never;
    try {
      expect(primitives.extensionResults(new Cred() as unknown as Credential)).toMatchObject({ prf: { results: {} } });
      expect(primitives.copyBuffer(new Uint8Array([1, 2, 3]).subarray(1)).byteLength).toBe(2);
      expect(hostile).not.toHaveBeenCalled();
      expect(slice).not.toHaveBeenCalled();
    } finally {
      ArrayBuffer.prototype.slice = originalSlice;
    }
  });

  it("è congelato: non si riassegna", async () => {
    vi.resetModules();
    const { primitives } = await import("./primitives");
    expect(Object.isFrozen(primitives)).toBe(true);
  });
});
