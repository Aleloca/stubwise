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
    show: vi.fn(async () => ({ ok: true, password: "Kx4!pa-77Wq" })),
    copy: vi.fn(async () => ({ ok: true })),
    share: vi.fn(async () => ({ ok: true, waiting: ["marco@x.test"] })),
    removeReader: vi.fn(async () => ({ ok: true })),
    pending: vi.fn(async () => ({
      ok: true,
      items: [
        {
          userId: "55555555-5555-4555-8555-555555555555",
          email: "marco@x.test",
          personKeyId: "aaaaaaaa-0000-4000-8000-0000000000a2",
          status: "pending",
          createdAt: "2026-11-24T16:20:00.000Z",
          device: "Chrome on macOS",
          fingerprint: "7d20 e5a9 c31f 6b84",
          credentials: [{ id: "c1", projectId: "prj-1", service: "Aruba hosting", label: null }],
        },
      ],
    })),
    confirm: vi.fn(async () => ({
      ok: true,
      saved: 1,
      keyChanged: 0,
      notAllowed: 0,
      unopenable: 0,
    })),
    reject: vi.fn(async () => ({ ok: true })),
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
/**
 * Lo stato del server dal canale del main (`vault:server-status`, review C1:
 * nell'app il proxy rifiuta `/api/vault*` al renderer). Il bridge deve
 * esserci già (`bridge()`); restituisce la spia del canale.
 */
const statusOf = (body: {
  activated: boolean;
  myKey: { id: string; status: string; createdAt: string; publicKey?: string } | null;
}) => {
  const spy = vi.fn(async () => ({
    ok: true as const,
    activated: body.activated,
    myKey: body.myKey ? { ...body.myKey, publicKey: body.myKey.publicKey ?? null } : null,
  }));
  (
    window as unknown as { stubwise: { vault: Record<string, unknown> } }
  ).stubwise.vault.serverStatus = spy;
  return spy;
};

describe("la cassaforte nella build app, dal main", () => {
  it("lo stato della barra dal main: stato, Touch ID, impronta del Mac", async () => {
    bridge();
    statusOf({
      activated: true,
      myKey: { id: KEY, status: "confirmed", createdAt: "2026-11-20T10:00:00.000Z" },
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
      statusOf({ activated: false, myKey: null });
      expect((await vault.getVaultStatus()).state).toBe("inactive");
    });

    it("senza chiave, o con una rifiutata: `no_key`", async () => {
      bridge();
      statusOf({ activated: true, myKey: null });
      expect((await vault.getVaultStatus()).state).toBe("no_key");
      statusOf({
        activated: true,
        myKey: { id: KEY, status: "rejected", createdAt: "2026-11-20T10:00:00.000Z" },
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
      });
      const s = await vault.getVaultStatus();
      expect(s.state).toBe("key_pending");
      expect(s.ownFingerprint).toBe(await keyFingerprint(own.publicKey));
    });

    it("`VAULT_DESKTOP` spento sul server: `disabled`", async () => {
      bridge();
      (
        window as unknown as { stubwise: { vault: Record<string, unknown> } }
      ).stubwise.vault.serverStatus = vi.fn(async () => ({ ok: false as const, code: "disabled" }));
      expect((await vault.getVaultStatus()).state).toBe("disabled");
    });

    it("il main dice già `unsupported`: il server non si chiede", async () => {
      bridge({
        status: vi.fn(async () => ({ state: "unsupported", fingerprint: null, touchId: false })),
      });
      const spy = statusOf({ activated: true, myKey: null });
      expect((await vault.getVaultStatus()).state).toBe("unsupported");
      expect(spy).not.toHaveBeenCalled();
    });
  });

  // Fetta 3: le operazioni con la chiave, fatte dal main (la password di
  // «Show» arriva dal main; «Copy» non la restituisce mai).
  describe("le operazioni con la chiave", () => {
    it("Show, Copy, Share (personId → userId) e Remove reader passano dal main", async () => {
      const { v } = bridge();
      expect(await vault.show("c1")).toEqual({ ok: true, password: "Kx4!pa-77Wq" });
      expect(await vault.copy("c1")).toEqual({ ok: true });
      expect(await vault.share("c1", { personId: "p-1" })).toEqual({
        ok: true,
        waiting: ["marco@x.test"],
      });
      expect(v.share).toHaveBeenCalledWith("c1", { userId: "p-1" });
      await vault.share("c1", { roleId: "r-1" });
      expect(v.share).toHaveBeenLastCalledWith("c1", { roleId: "r-1" });
      expect(await vault.removeReader("c1", "rd-1")).toEqual({ ok: true });
    });

    it("chi aspetta: dal main, col nome dalla rubrica; a cassaforte chiusa nessuno", async () => {
      bridge();
      installFakeServer({
        "GET /api/people": {
          body: [
            {
              id: "55555555-5555-4555-8555-555555555555",
              name: "Marco Bellini",
              initials: "MB",
              departmentIds: [],
              email: "marco@x.test",
            },
          ],
        },
      });
      const [p] = await vault.listPending();
      expect(p).toMatchObject({
        keyId: "aaaaaaaa-0000-4000-8000-0000000000a2",
        personId: "55555555-5555-4555-8555-555555555555",
        name: "Marco Bellini",
        email: "marco@x.test",
        device: "Chrome on macOS",
        fingerprint: "7d20 e5a9 c31f 6b84",
      });
      expect(p!.credentials.map((c) => [c.service, c.projectId])).toEqual([
        ["Aruba hosting", "prj-1"],
      ]);
      vi.unstubAllGlobals();
      bridge({ pending: vi.fn(async () => ({ ok: false, code: "vault_locked" })) });
      expect(await vault.listPending()).toEqual([]);
    });

    it("Confirm e Reject: gli esiti del main", async () => {
      bridge();
      expect(await vault.confirm("k-1")).toEqual({
        ok: true,
        saved: 1,
        keyChanged: 0,
        notAllowed: 0,
        unopenable: 0,
      });
      expect(await vault.reject("k-1")).toEqual({ ok: true });
    });
  });

  // Review I2: se il main non raggiunge Stubwise per aprire (`unavailable`),
  // la barra lo dice come nella shape («Couldn't reach Stubwise…» · Try
  // again) finché un'apertura non riesce o la cassaforte si chiude.
  it("I2: un'apertura senza server rende la barra `unreachable`; riuscita, torna lo stato del Mac", async () => {
    const unlock = vi.fn(
      async (): Promise<{ ok: boolean; code?: string }> => ({ ok: false, code: "unavailable" }),
    );
    bridge({ unlock });
    statusOf({
      activated: true,
      myKey: { id: KEY, status: "confirmed", createdAt: "2026-11-20T10:00:00.000Z" },
    });
    expect(await vault.unlock()).toEqual({ ok: false, code: "unavailable" });
    expect((await vault.getVaultStatus()).state).toBe("unreachable");
    unlock.mockResolvedValueOnce({ ok: true });
    expect(await vault.unlock()).toEqual({ ok: true });
    expect((await vault.getVaultStatus()).state).toBe("locked");
  });
});
