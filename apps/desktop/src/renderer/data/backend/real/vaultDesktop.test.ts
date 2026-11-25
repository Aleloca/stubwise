// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
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

afterEach(() => vi.unstubAllGlobals());

describe("la cassaforte nella build app, dal main", () => {
  it("lo stato della barra dal main: stato, Touch ID, impronta del Mac", async () => {
    bridge();
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
});
