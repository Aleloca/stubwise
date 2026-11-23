import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setAppClientForTests } from "./client";
import { installFakeServer } from "./fakeServer";
import { onInstanceChange } from "./index";
import { instance } from "./instanceChat";

// Registro, «I blocchi dell'istanza fuori dalla pausa» (72, 344fff90a): «si
// possono caricare file adesso» da `GET /api/storage/uploads` (`{ allowed }`,
// a chiunque sia autenticato, senza dati della configurazione). Nella build
// app i blocchi si rileggono alla lettura dopo: `onInstanceChange` non
// avvisa mai, e smettere di ascoltare non fa niente.

beforeEach(() => setAppClientForTests(null));
afterEach(() => {
  vi.unstubAllGlobals();
  setAppClientForTests(null);
});

describe("i blocchi dell'istanza nella build app", () => {
  it("storage configurato e valido: i caricamenti passano", async () => {
    const { seen } = installFakeServer({ "GET /api/storage/uploads": { body: { allowed: true } } });
    expect(await instance.getUploadsAllowed()).toBe(true);
    expect(seen.map((r) => `${r.method} ${r.path}`)).toContain("GET /api/storage/uploads");
  });

  it("storage non configurato: i caricamenti no", async () => {
    installFakeServer({ "GET /api/storage/uploads": { body: { allowed: false } } });
    expect(await instance.getUploadsAllowed()).toBe(false);
  });

  it("un server di prima, senza la rotta (404): non si blocca niente", async () => {
    installFakeServer({});
    expect(await instance.getUploadsAllowed()).toBe(true);
  });

  it("`onInstanceChange` non avvisa, e smettere di ascoltare non lancia", () => {
    const fn = vi.fn();
    const stop = onInstanceChange(fn);
    expect(() => stop()).not.toThrow();
    expect(fn).not.toHaveBeenCalled();
  });
});
