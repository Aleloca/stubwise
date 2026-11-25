// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createVaultLock, VAULT_IDLE_MS, type VaultLockDeps } from "./vaultLock";
import type { DeviceIdentity, StoredDevice } from "./vaultDevice";

// Lotto 10, design §3–§5 e §12 (decisioni del maintainer, 24 nov 2026):
// - la privata di persona vive SOLO nella memoria del main, non estraibile;
// - si riapre col Touch ID (D-1) chiesto dal Secure Enclave per l'ECDH del
//   sigillo (revisione I1): qui il `deriveBits` finto registra «touch»;
//   dopo l'associazione la chiave già aperta passa con `adopt` (D-1b, un
//   tocco solo); un Mac senza biometria si apre dal browser (D-1a), un build
//   o un Mac senza enclave è `unsupported`;
// - si chiude dopo 15 minuti senza usarla, a schermo bloccato, in stop (D-2);
// - un sigillo revocato lascia il login (D-5): lo stato è `revoked`.

const ME: DeviceIdentity = { instanceUrl: "https://stubwise.example", patId: "pat-1" };
const DEVICE: StoredDevice = {
  v: 3,
  ...ME,
  deviceId: "d-1",
  personKeyId: "pk-1",
  publicKey: "pub",
  keyTag: "enclave-blob",
};
const PERSON_KEY = { type: "private", extractable: false } as unknown as CryptoKey;

function setup(
  over: Partial<VaultLockDeps> = {},
  touch: "works" | "cancelled" | "lockout" = "works",
) {
  const calls: string[] = [];
  let stored: StoredDevice | null = DEVICE;
  const deps: VaultLockDeps = {
    identity: () => ME,
    store: {
      read: () => stored,
      forget: () => {
        calls.push("forget-local");
        stored = null;
      },
    },
    supported: async () => ({ enclave: true, biometry: true }),
    // Il Touch ID lo chiede l'enclave, nell'ECDH del sigillo.
    agreement: (device) => ({
      deriveBits: async () => {
        calls.push(device.keyTag === "enclave-blob" ? "touch" : `touch:${device.keyTag}`);
        if (touch !== "works") throw new Error(touch);
        return new Uint8Array(32);
      },
    }),
    fetchSeal: async () => ({
      id: "d-1",
      deviceName: "Mac",
      seal: "sealed",
      personKeyId: "pk-1",
      personPublicKey: "ppub",
    }),
    openSeal: async (input) => {
      await input.deriveBits(new Uint8Array(65));
      return PERSON_KEY;
    },
    forgetRemote: async () => {
      calls.push("forget-remote");
    },
    fingerprint: async (pub) => `fp(${pub})`,
    onChange: () => {},
    ...over,
  };
  return {
    lock: createVaultLock(deps),
    calls,
    setStored: (d: StoredDevice | null) => (stored = d),
  };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("la cassaforte nel main", () => {
  it("senza un dispositivo associato: `unpaired`, e non si apre", async () => {
    const { lock, setStored } = setup();
    setStored(null);
    expect(await lock.status()).toEqual({ state: "unpaired", fingerprint: null, touchId: true });
    expect(await lock.unlock()).toEqual({ ok: false, code: "unpaired" });
  });

  it("si apre col Touch ID; lo stato dice l'impronta del dispositivo, mai la chiave", async () => {
    const { lock, calls } = setup();
    expect(await lock.status()).toEqual({ state: "locked", fingerprint: "fp(pub)", touchId: true });
    expect(await lock.unlock()).toEqual({ ok: true });
    expect(calls).toEqual(["touch"]);
    const status = await lock.status();
    expect(status).toEqual({ state: "open", fingerprint: "fp(pub)", touchId: true });
    expect(JSON.stringify(status)).not.toContain("priv");
    // L'operazione riceve la chiave DENTRO il main, con l'id della chiave di
    // persona del sigillo (serve alla prova della propria chiave).
    expect(
      await lock.use(async (key, personKeyId) => key === PERSON_KEY && personKeyId === "pk-1"),
    ).toBe(true);
  });

  it("D-1b: la chiave che l'associazione ha già aperto passa con `adopt` (un tocco solo); poi sempre col tocco", async () => {
    const { lock, calls } = setup();
    lock.adopt(PERSON_KEY, "pk-1", lock.epoch());
    expect((await lock.status()).state).toBe("open");
    expect(calls).toEqual([]);
    lock.lock();
    expect(await lock.unlock()).toEqual({ ok: true });
    expect(calls).toEqual(["touch"]);
  });

  it("M1: non c'è più un'apertura senza tocco: ogni `unlock` passa dall'enclave", async () => {
    const { lock, calls } = setup();
    await lock.unlock();
    lock.lock();
    await lock.unlock();
    expect(calls).toEqual(["touch", "touch"]);
  });

  it("un build senza la cassaforte o un Mac senza enclave: `unsupported`, si apre dal browser", async () => {
    const { lock, calls } = setup({ supported: async () => ({ enclave: false, biometry: true }) });
    expect(await lock.status()).toEqual({
      state: "unsupported",
      fingerprint: null,
      touchId: false,
    });
    expect(await lock.unlock()).toEqual({ ok: false, code: "unsupported" });
    expect(calls).toEqual([]);
  });

  // Revisione di sicurezza, I3: un `lock()` o un cambio di sessione mentre
  // un'apertura è in corso vincono: l'apertura che finisce dopo scarta la chiave.
  it("I3: un lock() durante un'apertura in corso non viene annullato", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { lock } = setup({
      fetchSeal: async () => {
        await gate;
        return {
          id: "d-1",
          deviceName: "Mac",
          seal: "sealed",
          personKeyId: "pk-1",
          personPublicKey: "ppub",
        };
      },
    });
    const pending = lock.unlock();
    await Promise.resolve();
    lock.lock();
    release();
    expect(await pending).toEqual({ ok: false, code: "interrupted" });
    expect((await lock.status()).state).toBe("locked");
    await expect(lock.use(async () => 1)).rejects.toThrow("vault_locked");
  });

  it("I3: un cambio di sessione durante un'apertura in corso: niente chiave in memoria", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { lock } = setup({
      openSeal: async () => {
        await gate;
        return PERSON_KEY;
      },
    });
    const pending = lock.unlock();
    // Fino a dentro `openSeal` (timer finti: si avanza a microtask).
    for (let i = 0; i < 10; i++) await Promise.resolve();
    lock.sessionChanged();
    release();
    expect(await pending).toEqual({ ok: false, code: "interrupted" });
    await expect(lock.use(async () => 1)).rejects.toThrow("vault_locked");
  });

  it("D-1a: un Mac senza Touch ID non si riapre da solo (dal browser), e il sigillo resta", async () => {
    const { lock, calls } = setup({ supported: async () => ({ enclave: true, biometry: false }) });
    expect(await lock.unlock()).toEqual({ ok: false, code: "touch_id_unavailable" });
    expect(calls).toEqual([]);
    expect((await lock.status()).state).toBe("locked");
  });

  it("un tocco annullato non apre; la biometria bloccata dice di aprire dal browser", async () => {
    const { lock } = setup({}, "cancelled");
    expect(await lock.unlock()).toEqual({ ok: false, code: "touch_id_cancelled" });
    await expect(lock.use(async () => 1)).rejects.toThrow("vault_locked");
    expect(await setup({}, "lockout").lock.unlock()).toEqual({
      ok: false,
      code: "touch_id_unavailable",
    });
  });

  it("un sigillo che non si apre (un altro Mac, un'altra pubblica di persona: `openDeviceSeal` lancia) è `open_failed`, e non resta niente in memoria", async () => {
    let seen: unknown = null;
    const { lock } = setup({
      openSeal: async (input) => {
        seen = input;
        throw new Error("open_failed");
      },
    });
    expect(await lock.unlock()).toEqual({ ok: false, code: "open_failed" });
    expect((await lock.status()).state).toBe("locked");
    // L'apertura riceve gli id e la pubblica di persona che il server dice (la verifica è lì).
    expect(seen).toMatchObject({
      deviceSeal: "sealed",
      deviceId: "d-1",
      personKeyId: "pk-1",
      personPublicKey: "ppub",
    });
  });

  it("il server irraggiungibile: `unavailable`, niente cancellato", async () => {
    const { lock, calls } = setup({ fetchSeal: async () => Promise.reject(new Error("offline")) });
    expect(await lock.unlock()).toEqual({ ok: false, code: "unavailable" });
    expect(calls).not.toContain("forget-local");
    expect((await lock.status()).state).toBe("locked");
  });

  it("D-2: si chiude dopo 15 minuti senza usarla; usarla sposta la scadenza", async () => {
    const { lock } = setup();
    await lock.unlock();
    vi.advanceTimersByTime(VAULT_IDLE_MS - 1000);
    await lock.use(async () => null);
    vi.advanceTimersByTime(VAULT_IDLE_MS - 1000);
    expect((await lock.status()).state).toBe("open");
    vi.advanceTimersByTime(2000);
    expect((await lock.status()).state).toBe("locked");
    await expect(lock.use(async () => 1)).rejects.toThrow("vault_locked");
  });

  it("schermo bloccato o stop: `lock()` dimentica la chiave, il dispositivo resta", async () => {
    const { lock, calls } = setup();
    await lock.unlock();
    lock.lock();
    expect((await lock.status()).state).toBe("locked");
    expect(calls).not.toContain("forget-local");
  });

  it("D-5: un sigillo revocato dal server lascia il login; il file sparisce, lo stato è `revoked`", async () => {
    const { lock, calls } = setup({ fetchSeal: async () => ({ revoked: true }) });
    expect(await lock.unlock()).toEqual({ ok: false, code: "revoked" });
    expect(calls).toContain("forget-local");
    expect(await lock.status()).toEqual({ state: "revoked", fingerprint: null, touchId: true });
  });

  it("«Dimentica questo Mac»: il file, la chiave e il sigillo sul server; il server giù non ferma il locale", async () => {
    const { lock, calls } = setup({
      forgetRemote: async () => {
        calls.push("forget-remote");
        throw new Error("offline");
      },
    });
    await lock.unlock();
    expect(await lock.forget()).toEqual({ ok: true, remote: false });
    expect(calls).toEqual(["touch", "forget-remote", "forget-local"]);
    expect((await lock.status()).state).toBe("unpaired");
  });

  it("un cambio di sessione (login di un altro, logout) chiude e cancella il locale", async () => {
    const { lock, calls } = setup();
    await lock.unlock();
    lock.sessionChanged();
    expect(calls).toContain("forget-local");
    expect((await lock.status()).state).toBe("unpaired");
  });

  // M3 (revisione di sicurezza): al cambio d'istanza, al 401 e al nuovo
  // login il sigillo sul server si toglie best-effort, PRIMA che il token
  // cambi: la chiamata parte subito (il token si legge allora), poi il locale.
  it("M3: il cambio di sessione toglie il sigillo sul server, subito e prima del locale; un errore non ferma niente", async () => {
    const { lock, calls } = setup({
      forgetRemote: () => {
        calls.push("forget-remote");
        return Promise.reject(new Error("offline"));
      },
    });
    lock.sessionChanged();
    // Sincrono: niente `await` fra la chiamata e il controllo.
    expect(calls).toEqual(["forget-remote", "forget-local"]);
    await Promise.resolve();
    expect((await lock.status()).state).toBe("unpaired");
  });

  it("M3: senza un Mac associato non si chiama il server", async () => {
    const { lock, calls, setStored } = setup();
    setStored(null);
    lock.sessionChanged();
    expect(calls).not.toContain("forget-remote");
  });

  it("senza sessione: niente stato da mostrare, niente apertura", async () => {
    const { lock } = setup({ identity: () => null });
    expect(await lock.status()).toEqual({ state: "unpaired", fingerprint: null, touchId: true });
    expect(await lock.unlock()).toEqual({ ok: false, code: "no_session" });
  });

  it("un 403 `device_seal_required` dal server (Mac tolto, chiave ricreata): `markRevoked` chiude e cancella il locale; il login resta", async () => {
    const { lock, calls } = setup();
    await lock.unlock();
    lock.markRevoked();
    expect(calls).toContain("forget-local");
    expect(await lock.status()).toEqual({ state: "revoked", fingerprint: null, touchId: true });
    await expect(lock.use(async () => 1)).rejects.toThrow("vault_locked");
  });

  it("VAULT_DESKTOP spento (785387279): l'apertura dice `disabled`, la barra pure; il Mac associato resta", async () => {
    const { lock, calls } = setup({ fetchSeal: async () => ({ disabled: true }) });
    expect(await lock.unlock()).toEqual({ ok: false, code: "disabled" });
    expect(await lock.status()).toEqual({ state: "disabled", fingerprint: null, touchId: false });
    expect(calls).not.toContain("forget-local");
  });

  // M5 (revisione di sicurezza): un'azione che PASSA l'accesso (condividere,
  // confermare, rifiutare) chiede un Touch ID vero a sé, non basta la
  // cassaforte aperta: il sigillo si riapre dall'enclave per quell'azione.
  it("M5: `useWithTouch` riapre dall'enclave (un tocco) e usa quella chiave", async () => {
    const { lock, calls } = setup();
    await lock.unlock();
    expect(await lock.useWithTouch(async (key, id) => key === PERSON_KEY && id === "pk-1")).toBe(
      true,
    );
    expect(calls).toEqual(["touch", "touch"]);
  });

  // Review M7: un solo Touch ID per azione. A cassaforte chiusa l'azione
  // apre il sigillo per sé (un tocco) e la cassaforte resta chiusa: il
  // renderer non la apre prima (che sarebbe il secondo tocco).
  it("M7: a cassaforte chiusa `useWithTouch` fa l'azione con UN tocco, e la cassaforte resta chiusa", async () => {
    const { lock, calls } = setup();
    expect(await lock.useWithTouch(async (key) => key === PERSON_KEY)).toBe(true);
    expect(calls).toEqual(["touch"]);
    expect((await lock.status()).state).toBe("locked");
  });

  it("M7: senza Mac associato `useWithTouch` resta `vault_locked`", async () => {
    const { lock, setStored } = setup();
    setStored(null);
    await expect(lock.useWithTouch(async () => 1)).rejects.toThrow("vault_locked");
  });

  it("M5: un tocco annullato ferma l'azione (`touch_id_cancelled`), la cassaforte resta aperta", async () => {
    let cancel = false;
    const { lock } = setup({
      agreement: () => ({
        deriveBits: async () => {
          if (cancel) throw new Error("cancelled");
          return new Uint8Array(32);
        },
      }),
    });
    await lock.unlock();
    cancel = true;
    await expect(lock.useWithTouch(async () => 1)).rejects.toThrow("touch_id_cancelled");
    expect((await lock.status()).state).toBe("open");
  });

  // M1 (seconda revisione): l'associazione aspetta un tocco che può durare.
  // Se nel frattempo la cassaforte è stata chiusa o la sessione è cambiata,
  // la chiave aperta non passa: `adopt` porta l'epoca di quando è partita.
  it("M1: `adopt` con un'epoca vecchia (chiusa o sessione cambiata durante il tocco) non apre", async () => {
    const { lock } = setup();
    const since = lock.epoch();
    lock.lock();
    lock.adopt(PERSON_KEY, "pk-1", since);
    expect((await lock.status()).state).toBe("locked");
  });

  it("M1: `use` a cassaforte aperta ma col dispositivo sparito (file cancellato): `vault_locked`", async () => {
    const { lock, setStored } = setup();
    await lock.unlock();
    setStored(null);
    await expect(lock.use(async () => 1)).rejects.toThrow("vault_locked");
  });

  // La barra del renderer dice «questo Mac non ha Touch ID» (D-1a): lo stato
  // porta la biometria del Mac; senza, la cassaforte resta chiusa e si apre
  // dal browser.
  it("un Mac senza Touch ID: `locked` con `touchId: false`", async () => {
    const { lock } = setup({ supported: async () => ({ enclave: true, biometry: false }) });
    expect(await lock.status()).toEqual({
      state: "locked",
      fingerprint: "fp(pub)",
      touchId: false,
    });
  });
});
