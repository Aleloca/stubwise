// @vitest-environment node
import { describe, expect, it } from "vitest";
import { createVaultPairing, PAIRING_TTL_MS, type VaultPairingDeps } from "./vaultPairing";

// Lotto 10, design §7 (lato desktop) con la forma di 72: il main genera la
// coppia, chiede l'accoppiamento col PAT, apre il browser con SOLO lo state;
// al ritorno (`stubwise://vault?state=…`) scarica il sigillo e lo APRE prima
// di scrivere `vault-device.bin`: un sigillo che non si apre non lascia
// niente su disco.

const ME = { instanceUrl: "https://stubwise.example", patId: "pat-1" };
const STATE = "state-abcdefghijklmnop";

function setup(over: Partial<VaultPairingDeps> = {}) {
  const calls: string[] = [];
  let now = 1_000;
  const deps: VaultPairingDeps = {
    identity: () => ME,
    deviceName: () => "MacBook Pro",
    generate: async () => ({
      publicKey: '{"kty":"EC"}',
      stored: { publicKey: '{"kty":"EC"}', privateKey: "pk8" },
    }),
    devicePrivateKey: async () => ({}) as CryptoKey,
    pair: async (pub, name) => {
      calls.push(`pair:${name}`);
      return { state: STATE, deviceId: "d-1", expiresAt: "x" };
    },
    openExternal: async (url) => {
      calls.push(`open:${url}`);
    },
    fetchSeal: async () => ({
      id: "d-1",
      deviceName: "Mac",
      seal: "env",
      personKeyId: "pk-1",
      personPublicKey: "ppub",
    }),
    openSeal: async () => ({}) as CryptoKey,
    save: (d) => {
      calls.push(`save:${d.deviceId}:${d.personKeyId}`);
      return true;
    },
    paired: () => {
      calls.push("paired");
    },
    fingerprint: async () => "fp",
    now: () => now,
    ...over,
  };
  return { p: createVaultPairing(deps), calls, advance: (ms: number) => (now += ms) };
}

describe("l'associazione del Mac", () => {
  it("chiede l'accoppiamento col PAT e apre il browser con SOLO lo state; dice l'impronta da confrontare", async () => {
    const { p, calls } = setup();
    expect(await p.start()).toEqual({ ok: true, fingerprint: "fp" });
    expect(calls).toEqual([
      "pair:MacBook Pro",
      // La pagina sta nel web (89bd14da2), accanto alle altre della cassaforte.
      `open:https://stubwise.example/vault-pair?state=${STATE}`,
    ]);
  });

  it("il ritorno con lo state giusto: apre il sigillo, POI scrive il file e lo segna appena associato", async () => {
    const { p, calls } = setup();
    await p.start();
    expect(await p.handleUrl(`stubwise://vault?state=${STATE}`)).toEqual({ ok: true });
    expect(calls.slice(2)).toEqual(["save:d-1:pk-1", "paired"]);
    // Uso singolo.
    expect(await p.handleUrl(`stubwise://vault?state=${STATE}`)).toEqual({
      ok: false,
      code: "no_pending",
    });
  });

  it("un sigillo che non si apre: niente su disco", async () => {
    const { p, calls } = setup({ openSeal: async () => Promise.reject(new Error("open_failed")) });
    await p.start();
    expect(await p.handleUrl(`stubwise://vault?state=${STATE}`)).toEqual({
      ok: false,
      code: "open_failed",
    });
    expect(calls.some((c) => c.startsWith("save"))).toBe(false);
  });

  it("uno state diverso, un altro schema o scaduto: rifiutato, niente su disco", async () => {
    const { p, calls, advance } = setup();
    await p.start();
    expect(await p.handleUrl("stubwise://vault?state=another-state-xxxxxxx")).toEqual({
      ok: false,
      code: "state_mismatch",
    });
    expect(await p.handleUrl(`https://evil.example/vault?state=${STATE}`)).toEqual({
      ok: false,
      code: "invalid_url",
    });
    advance(PAIRING_TTL_MS + 1);
    expect(await p.handleUrl(`stubwise://vault?state=${STATE}`)).toEqual({
      ok: false,
      code: "expired",
    });
    expect(calls.some((c) => c.startsWith("save"))).toBe(false);
  });

  it("il login cambiato mentre il browser era aperto: rifiutato", async () => {
    let me: typeof ME | null = ME;
    const { p, calls } = setup({ identity: () => me });
    await p.start();
    me = { ...ME, patId: "pat-2" };
    expect(await p.handleUrl(`stubwise://vault?state=${STATE}`)).toEqual({
      ok: false,
      code: "session_changed",
    });
    expect(calls.some((c) => c.startsWith("save"))).toBe(false);
  });

  it("senza cifratura del sistema non si associa: lo dice", async () => {
    const { p } = setup({ save: () => false });
    await p.start();
    expect(await p.handleUrl(`stubwise://vault?state=${STATE}`)).toEqual({
      ok: false,
      code: "no_secure_storage",
    });
  });

  it("senza sessione non parte; un errore del server si dice", async () => {
    expect(await setup({ identity: () => null }).p.start()).toEqual({
      ok: false,
      code: "no_session",
    });
    const { p } = setup({ pair: async () => Promise.reject(new Error("vault_not_active")) });
    expect(await p.start()).toEqual({ ok: false, code: "vault_not_active" });
  });

  it("l'associazione senza la riconferma del desktop (189c3a1af): `reauth_required`, e il browser non si apre", async () => {
    const { p, calls } = setup({ pair: async () => Promise.reject(new Error("reauth_required")) });
    expect(await p.start()).toEqual({ ok: false, code: "reauth_required" });
    expect(calls.some((c) => c.startsWith("open:"))).toBe(false);
  });
});
