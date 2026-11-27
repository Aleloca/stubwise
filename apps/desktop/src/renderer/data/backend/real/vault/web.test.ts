import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// La cassaforte della build web (design §5, §8, §9): lo stato della barra dal
// server e dalla chiave della scheda; la sessione persa e «Esci» la chiudono.

let status: Record<string, unknown>;

beforeEach(() => {
  vi.stubEnv("VITE_STUBWISE_BUILD", "app");
  vi.stubEnv("VITE_STUBWISE_TARGET", "web");
  status = {
    activated: true,
    myKey: { id: "11111111-1111-4111-8111-111111111111", status: "confirmed", createdAt: "2026-11-01T00:00:00.000Z" },
    seals: [],
    passkeys: [],
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (path: string) =>
      path === "/api/vault/status"
        ? new Response(JSON.stringify(status), { status: 200 })
        : new Response('{"code":"not_found"}', { status: 404 }),
    ),
  );
  vi.resetModules();
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

const load = async () => {
  const key = await import("../vaultBrowser/key");
  key.__resetKeyForTests();
  const { vault } = await import("./web");
  const events = await import("../../../sessionEvents");
  return { vault, key, events };
};

const someKey = () => crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt"]);

describe("la cassaforte della build web", () => {
  it("gli stati dal server: non attivata, senza chiave, chiave da confermare", async () => {
    const { vault } = await load();
    status = { ...status, activated: false };
    expect((await vault.getVaultStatus()).state).toBe("inactive");
    status = { ...status, activated: true, myKey: null };
    expect((await vault.getVaultStatus()).state).toBe("no_key");
    status = { ...status, myKey: { id: "11111111-1111-4111-8111-111111111111", status: "pending", createdAt: "2026-11-01T00:00:00.000Z" } };
    expect((await vault.getVaultStatus()).state).toBe("key_pending");
  });

  it("con la chiave confermata decide la scheda: chiusa, aperta, chiusa dopo «Lock»", async () => {
    const { vault, key } = await load();
    expect((await vault.getVaultStatus()).state).toBe("locked");
    key.open(await someKey(), "p-ada", "e0");
    expect((await vault.getVaultStatus()).state).toBe("open");
    await vault.lock();
    expect((await vault.getVaultStatus()).state).toBe("locked");
  });

  it("I5: la sessione persa (401) e «Esci» chiudono la cassaforte della scheda", async () => {
    const { key, events } = await load();
    key.open(await someKey(), "p-ada", "e0");
    events.emitSessionLost();
    expect(key.status().state).toBe("locked");
    key.open(await someKey(), "p-ada", "e1");
    events.emitLoggedOut();
    expect(key.status().state).toBe("locked");
  });

  it("dopo una sessione persa, una chiave aperta con l'epoca vecchia non si usa più", async () => {
    const { key, events } = await load();
    key.open(await someKey(), "p-ada", "e0");
    events.emitSessionLost();
    key.open(await someKey(), "p-ada", "e0");
    // La prossima `use` della build web passa l'epoca di adesso.
    expect(() => key.use("p-ada", "e1")).toThrow("vault_locked");
  });

  it("Show a cassaforte chiusa: `vault_locked`, e un 429 del server arriva coi suoi secondi", async () => {
    // Il fetch si cattura al primo import (design §2.4): la risposta 429 va messa prima.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response('{"code":"vault_reveal_rate_limited"}', { status: 429, headers: { "retry-after": "600" } })),
    );
    vi.resetModules();
    const { vault, key } = await load();
    const client = await import("../client");
    client.session.personId = "p-ada";
    expect(await vault.show("33333333-3333-4333-8333-333333333333")).toEqual({ ok: false, code: "vault_locked" });
    key.open(await someKey(), "p-ada", "e0");
    expect(await vault.copy("33333333-3333-4333-8333-333333333333")).toEqual({
      ok: false,
      code: "vault_reveal_rate_limited",
      retryAfterSeconds: 600,
    });
    client.session.personId = null;
  });
});
