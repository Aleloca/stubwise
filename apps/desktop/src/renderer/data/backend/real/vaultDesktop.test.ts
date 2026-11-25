// @vitest-environment happy-dom
import { keyFingerprint } from "@stubwise/vault-crypto";
import { softwareDeviceKey } from "@stubwise/vault-crypto/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setAppClientForTests } from "./client";
import { installFakeServer } from "./fakeServer";
import * as vault from "./vaultDesktop";

// La cassaforte nella build app (lotto 10, fetta 1 dell'adattatore): stato,
// apertura, chiusura, associazione, i propri Mac dal main
// (`window.stubwise.vault`), con le firme del prototipo. La chiave non passa
// mai di qui: il main dà stati ed esiti.

function bridge(over: Record<string, unknown> = {}) {
  let changed: ((s: unknown) => void) | null = null;
  let paired: ((r: unknown) => void) | null = null;
  const v = {
    status: vi.fn(async () => ({
      state: "locked",
      fingerprint: "91be 4c07 2a3f d6e5",
      touchId: true,
    })),
    unlock: vi.fn(async () => ({ ok: true })),
    lock: vi.fn(async () => ({ ok: true })),
    forget: vi.fn(async () => ({ ok: true, remote: true })),
    pairStart: vi.fn(async () => ({ ok: true, fingerprint: "3f9a 1c2e 07d4 91be" })),
    pairCancel: vi.fn(async () => ({ ok: true })),
    macs: vi.fn(async () => ({
      ok: true,
      items: [
        {
          id: "m-1",
          name: "MacBook Pro di Laura",
          pairedAt: "2026-11-24T09:00:00.000Z",
          lastUsedAt: null,
          current: true,
          fingerprint: "91be 4c07 2a3f d6e5",
        },
      ],
    })),
    removeMac: vi.fn(async () => ({ ok: true })),
    onChanged: vi.fn((cb: (s: unknown) => void) => {
      changed = cb;
      return () => (changed = null);
    }),
    onPaired: vi.fn((cb: (r: unknown) => void) => {
      paired = cb;
      return () => (paired = null);
    }),
    ...over,
  };
  vi.stubGlobal("stubwise", { vault: v });
  return { v, change: (s: unknown) => changed?.(s), pair: (r: unknown) => paired?.(r) };
}

beforeEach(() => setAppClientForTests(null));
afterEach(() => vi.unstubAllGlobals());

const KEY = "aaaaaaaa-0000-4000-8000-000000000001";
const statusOf = (body: unknown) => installFakeServer({ "GET /api/vault/status": { body } });

describe("la cassaforte nella build app, dal main", () => {
  it("lo stato della barra dal main: stato, Touch ID, impronta del Mac", async () => {
    bridge();
    statusOf({
      activated: true,
      myKey: { id: KEY, status: "confirmed", createdAt: "2026-11-20T10:00:00.000Z" },
      seals: [],
      passkeys: [],
    });
    expect(await vault.getVaultStatus()).toEqual({
      state: "locked",
      touchId: true,
      macFingerprint: "91be 4c07 2a3f d6e5",
      ownFingerprint: null,
      pairing: null,
    });
  });

  it("senza il ponte (la build web): `unsupported`, si apre dal browser", async () => {
    vi.stubGlobal("stubwise", {});
    expect((await vault.getVaultStatus()).state).toBe("unsupported");
  });

  it("aprire e chiudere: gli esiti del main, i codici così come sono", async () => {
    const { v } = bridge({
      unlock: vi.fn(async () => ({ ok: false, code: "touch_id_cancelled" })),
    });
    expect(await vault.unlock()).toEqual({ ok: false, code: "touch_id_cancelled" });
    expect(await vault.lock()).toEqual({ ok: true });
    expect(v.lock).toHaveBeenCalled();
  });

  it("l'associazione: inizio, annullo, e l'esito dal ritorno del browser", async () => {
    const { pair } = bridge();
    expect(await vault.startPairing()).toEqual({ ok: true, fingerprint: "3f9a 1c2e 07d4 91be" });
    const seen: unknown[] = [];
    const off = vault.subscribePairing((r) => seen.push(r));
    pair({ ok: false, code: "expired" });
    off();
    pair({ ok: true });
    expect(seen).toEqual([{ ok: false, code: "expired" }]);
  });

  it("«changed» dal main arriva a chi ascolta", async () => {
    const { change } = bridge();
    let n = 0;
    const off = vault.subscribeVaultChanges(() => (n += 1));
    change({ state: "open", fingerprint: null, touchId: true });
    off();
    change({ state: "locked", fingerprint: null, touchId: true });
    expect(n).toBe(1);
  });

  it("i miei Mac e Remove; un rifiuto del main resta un codice (`reauth_required`)", async () => {
    const { v } = bridge({
      removeMac: vi.fn(async () => ({ ok: false, code: "reauth_required" })),
    });
    expect(await vault.listMyMacs()).toEqual([
      {
        id: "m-1",
        name: "MacBook Pro di Laura",
        pairedAt: "2026-11-24T09:00:00.000Z",
        lastUsedAt: null,
        current: true,
        fingerprint: "91be 4c07 2a3f d6e5",
      },
    ]);
    expect(await vault.removeMac("m-2")).toEqual({ ok: false, code: "reauth_required" });
    expect(v.removeMac).toHaveBeenCalledWith("m-2");
    expect(await vault.forgetThisMac()).toEqual({ ok: true, remote: true });
  });

  // Fetta 2a: lo stato della propria chiave dal server (`GET /api/vault/status`,
  // `desktopRead` di 72): la barra dice quando non c'è niente da aprire dal Mac.
  describe("lo stato del server", () => {
    it("cassaforte dell'istanza non attivata: `inactive`", async () => {
      bridge();
      statusOf({ activated: false, myKey: null, seals: [], passkeys: [] });
      expect((await vault.getVaultStatus()).state).toBe("inactive");
    });

    it("senza chiave, o con una rifiutata: `no_key`", async () => {
      bridge();
      statusOf({ activated: true, myKey: null, seals: [], passkeys: [] });
      expect((await vault.getVaultStatus()).state).toBe("no_key");
      setAppClientForTests(null);
      statusOf({
        activated: true,
        myKey: { id: KEY, status: "rejected", createdAt: "2026-11-20T10:00:00.000Z" },
        seals: [],
        passkeys: [],
      });
      expect((await vault.getVaultStatus()).state).toBe("no_key");
    });

    it("chiave da confermare: `key_pending`, con l'impronta della propria chiave", async () => {
      bridge();
      const own = await softwareDeviceKey();
      statusOf({
        activated: true,
        myKey: {
          id: KEY,
          status: "pending",
          createdAt: "2026-11-20T10:00:00.000Z",
          publicKey: own.publicKey,
        },
        seals: [],
        passkeys: [],
      });
      const s = await vault.getVaultStatus();
      expect(s.state).toBe("key_pending");
      expect(s.ownFingerprint).toBe(await keyFingerprint(own.publicKey));
    });

    it("`VAULT_DESKTOP` spento sul server: `disabled`", async () => {
      bridge();
      installFakeServer({
        "GET /api/vault/status": {
          status: 404,
          body: { code: "vault_desktop_disabled", message: "x" },
        },
      });
      expect((await vault.getVaultStatus()).state).toBe("disabled");
    });

    it("il main dice già `unsupported`: il server non si chiede", async () => {
      bridge({
        status: vi.fn(async () => ({ state: "unsupported", fingerprint: null, touchId: false })),
      });
      const { seen } = statusOf({ activated: true, myKey: null, seals: [], passkeys: [] });
      expect((await vault.getVaultStatus()).state).toBe("unsupported");
      expect(seen).toHaveLength(0);
    });
  });
});
