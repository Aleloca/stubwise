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

  it("I-A: `ownBuffer` riconosce un ArrayBuffer senza `instanceof`; da una vista, una copia e l'originale azzerato", async () => {
    vi.resetModules();
    const { primitives } = await import("./primitives");
    const hasInstance = vi.fn(() => false);
    Object.defineProperty(ArrayBuffer, Symbol.hasInstance, { value: hasInstance, configurable: true });
    try {
      const ab = new Uint8Array([1, 2, 3]).buffer;
      expect(primitives.ownBuffer(ab)).toBe(ab);
      const backing = new Uint8Array([9, 8, 7, 6]);
      const copy = primitives.ownBuffer(backing.subarray(1, 3))!;
      expect([...new Uint8Array(copy)]).toEqual([8, 7]);
      expect([...backing]).toEqual([9, 0, 0, 6]);
      expect(primitives.ownBuffer({ byteLength: 32 })).toBeNull();
      expect(primitives.ownBuffer(undefined)).toBeNull();
      expect(hasInstance).not.toHaveBeenCalled();
    } finally {
      delete (ArrayBuffer as unknown as Record<symbol, unknown>)[Symbol.hasInstance];
    }
  });

  it("I-A: il `then` e la lista di transfer non passano dai prototipi sostituiti dopo il boot", async () => {
    vi.resetModules();
    const { primitives } = await import("./primitives");
    const origThen = Promise.prototype.then;
    const origIter = Array.prototype[Symbol.iterator];
    const thenSpy = vi.fn(origThen);
    const iterSpy = vi.fn(origIter);
    Promise.prototype.then = thenSpy as never;
    Array.prototype[Symbol.iterator] = iterSpy as never;
    let got: unknown;
    let sent: unknown[] = [];
    try {
      const value = { secret: 1 };
      primitives.then(Promise.resolve(value), (v) => (got = v), () => {});
      const ab = new ArrayBuffer(4);
      const fakeWorker = { postMessage: (_m: unknown, list: Iterable<unknown>) => {
        const it = (list as { [Symbol.iterator]: () => Iterator<unknown> })[Symbol.iterator]();
        for (let r = it.next(); !r.done; r = it.next()) sent.push(r.value);
      } };
      primitives.postToWorker(fakeWorker as unknown as Worker, {}, [ab]);
      // Prima di ogni `expect` (che a sua volta itera gli array).
      const iterCalls = iterSpy.mock.calls.length;
      const thenCalls = thenSpy.mock.calls.length;
      Promise.prototype.then = origThen;
      Array.prototype[Symbol.iterator] = origIter;
      expect(sent.length === 1 && sent[0] === ab).toBe(true);
      expect(iterCalls).toBe(0);
      expect(thenCalls).toBe(0);
      sent = [];
    } finally {
      Promise.prototype.then = origThen;
      Array.prototype[Symbol.iterator] = origIter;
    }
    await new Promise((r) => setTimeout(r, 0));
    expect(got).toEqual({ secret: 1 });
  });

  it("I-A: i getter della credenziale sono quelli del primo import", async () => {
    class Cred {
      get response() {
        return "native";
      }
    }
    vi.stubGlobal("PublicKeyCredential", Cred);
    vi.resetModules();
    const { primitives } = await import("./primitives");
    const hostile = vi.fn(() => "hostile");
    Object.defineProperty(Cred.prototype, "response", { get: hostile, configurable: true });
    expect(primitives.credential(new Cred(), "response")).toBe("native");
    expect(hostile).not.toHaveBeenCalled();
  });

  it("I-A: `harden` congela ciò che gli si dà", async () => {
    vi.resetModules();
    const { harden } = await import("./primitives");
    const proto = { then: () => {} };
    const ctor = function () {} as unknown as { prototype: object };
    harden([ctor, proto, null]);
    expect(Object.isFrozen(proto)).toBe(true);
    expect(Object.isFrozen(ctor)).toBe(true);
    expect(() => Object.defineProperty(proto, "constructor", { get: () => Object })).toThrow(TypeError);
  });
});

