import { afterEach, describe, expect, it, vi } from "vitest";

// Cassaforte nel browser, design §2.4 (C2): la scheda cattura le primitive al
// primo import e le inietta qui; uno script arrivato dopo, che sostituisse
// `crypto.subtle`, non le cambia più per la cassaforte. Senza iniezione (il
// main del desktop, il server, il web vecchio) vale il globale, come prima.

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

const fresh = async () => {
  vi.resetModules();
  return import("./index.js");
};

describe("useCrypto", () => {
  it("senza iniezione si usa il crypto globale", async () => {
    const vc = await fresh();
    const digest = vi.spyOn(globalThis.crypto.subtle, "exportKey");
    await vc.generatePersonKeyPair();
    expect(digest).toHaveBeenCalled();
    digest.mockRestore();
  });

  it("iniettate, valgono le primitive catturate anche se il globale cambia dopo", async () => {
    const vc = await fresh();
    const real = globalThis.crypto;
    vc.useCrypto({ subtle: real.subtle, getRandomValues: real.getRandomValues.bind(real) });
    const hostile = { subtle: { exportKey: vi.fn(), generateKey: vi.fn(), importKey: vi.fn() }, getRandomValues: vi.fn() };
    vi.stubGlobal("crypto", hostile);
    const pair = await vc.generatePersonKeyPair();
    expect(pair.publicKey).toBeTruthy();
    // Una password cifrata vuole una chiave e un IV a caso: dalle primitive catturate.
    const sealed = await vc.encryptPassword("c-1", "s3cret");
    expect(sealed).toBeTruthy();
    expect(hostile.subtle.generateKey).not.toHaveBeenCalled();
    expect(hostile.getRandomValues).not.toHaveBeenCalled();
  });

  it("si imposta UNA volta: una seconda iniezione è rifiutata", async () => {
    const vc = await fresh();
    const real = globalThis.crypto;
    vc.useCrypto({ subtle: real.subtle, getRandomValues: real.getRandomValues.bind(real) });
    expect(() => vc.useCrypto({ subtle: real.subtle, getRandomValues: real.getRandomValues.bind(real) })).toThrow(
      "crypto_already_set",
    );
  });
});
