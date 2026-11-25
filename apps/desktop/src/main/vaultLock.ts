import type { DeviceIdentity, StoredDevice } from "./vaultDevice";

// La cassaforte nel processo main (lotto 10, design
// `docs/plans/2026-11-24-cassaforte-desktop-design.md`, §3–§5, decisioni del
// maintainer in §12, 24 nov 2026).
//
// La privata di persona si apre dal sigillo del dispositivo e vive SOLO qui,
// come `CryptoKey` non estraibile: il renderer chiede operazioni (`use`) e
// riceve esiti, mai la chiave. Le regole:
// - D-1: si riapre col Touch ID; D-1b: senza tocco solo la prima apertura
//   subito dopo l'associazione (in memoria: al riavvio il tocco torna);
//   D-1a: un Mac senza Touch ID non si riapre da solo, si apre dal browser
//   con la passkey e il sigillo resta;
// - D-2: si chiude (la chiave si dimentica, il dispositivo resta) dopo
//   15 minuti senza usarla, a schermo bloccato e in stop (`lock()`, dai
//   segnali di `powerMonitor`);
// - D-5: un sigillo revocato dal server lascia il login: il file del
//   dispositivo sparisce e lo stato è `revoked` (si riassocia dal browser);
// - un cambio di sessione cancella il locale: il dispositivo è di quel login.
//
// La crittografia del sigillo e le rotte del server sono dipendenze: le dà
// chi crea il controllore (`index.ts`), i test le fingono.

/** D-2: la chiusura dopo questo tempo senza usarla. */
export const VAULT_IDLE_MS = 15 * 60 * 1000;

/** M1 (revisione di sicurezza): quanto vale l'apertura senza tocco dopo l'associazione. */
export const FRESH_PAIRING_MS = 10_000;

/** `disabled`: l'istanza non abilita la cassaforte dal desktop (`VAULT_DESKTOP` spento). */
export type VaultState = "unpaired" | "locked" | "open" | "revoked" | "disabled";

/** Ciò che il renderer vede: lo stato e l'impronta della chiave del dispositivo. */
export interface VaultStatus {
  state: VaultState;
  fingerprint: string | null;
}

export type UnlockCode =
  | "interrupted"
  | "disabled"
  | "no_session"
  | "unpaired"
  | "revoked"
  | "touch_id_unavailable"
  | "touch_id_cancelled"
  | "unavailable"
  | "open_failed";

export type UnlockResult = { ok: true } | { ok: false; code: UnlockCode };

/**
 * Il sigillo come lo dà il server (`GET /api/vault/device-seals/mine`, 72),
 * o la sua revoca (404 `device_seal_not_found`).
 */
export type SealResponse =
  | { id: string; deviceName: string; seal: string; personKeyId: string; personPublicKey: string }
  | { revoked: true }
  | { disabled: true };

export interface VaultLockDeps {
  /** La sessione desktop di adesso; null senza login. */
  identity: () => DeviceIdentity | null;
  store: { read: (me: DeviceIdentity) => StoredDevice | null; forget: () => void };
  devicePrivateKey: (device: StoredDevice) => Promise<CryptoKey>;
  touchId: { available: () => boolean; prompt: (reason: string) => Promise<void> };
  /** `GET /api/vault/device-seals/mine` (72). */
  fetchSeal: () => Promise<SealResponse>;
  /**
   * Apre il sigillo con la privata del dispositivo (`openDeviceSeal` di
   * `@stubwise/vault-crypto`): restituisce la privata di persona NON
   * estraibile dopo aver verificato che sia la metà di `personPublicKey`, e
   * lancia per un altro Mac, altri id o un'altra pubblica (§1).
   */
  openSeal: (input: {
    deviceSeal: string;
    devicePrivateKey: CryptoKey;
    personPublicKey: string;
    personKeyId: string;
    deviceId: string;
  }) => Promise<CryptoKey>;
  /** `DELETE /api/vault/device-seals/mine` (72), best-effort. */
  forgetRemote: () => Promise<void>;
  fingerprint: (publicKey: string) => Promise<string>;
  /** Avvisa il renderer di un cambio di stato (`vault:changed`). */
  onChange: (status: VaultStatus) => void;
  /** Il testo del Touch ID («Stubwise vuole <reason>»). */
  touchReason?: string;
}

export interface VaultLock {
  status: () => Promise<VaultStatus>;
  /** `afterPairing`: SOLO dal ritorno dell'associazione (`receiveVaultUrl`), l'apertura senza tocco (D-1b, M1). */
  unlock: (options?: { afterPairing?: boolean }) => Promise<UnlockResult>;
  lock: () => void;
  /**
   * Un'operazione con la privata di persona, dentro il main, con l'id della
   * chiave di persona del sigillo (per la prova); chiusa: `vault_locked`.
   */
  use: <T>(run: (key: CryptoKey, personKeyId: string) => Promise<T>) => Promise<T>;
  /** «Dimentica questo Mac»: il sigillo sul server (best-effort), il file e la chiave. */
  forget: () => Promise<{ ok: true; remote: boolean }>;
  /** Appena associato: la prossima apertura è senza tocco (D-1b). */
  markPaired: () => void;
  /**
   * Login nuovo, cambio d'istanza, 401: toglie il sigillo sul server
   * (best-effort, M3) e cancella il locale. Va chiamata PRIMA che il token
   * cambi: la chiamata al server parte subito e legge il token di adesso.
   */
  sessionChanged: () => void;
  /** Il server dice `device_seal_required` (Mac tolto, chiave ricreata): D-5, il login resta. */
  markRevoked: () => void;
  /** L'istanza non abilita la cassaforte dal desktop: si apre dal browser (il Mac associato resta). */
  markDisabled: () => void;
}

export function createVaultLock(deps: VaultLockDeps): VaultLock {
  let key: CryptoKey | null = null;
  let personKeyId: string | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let revoked = false;
  /** `VAULT_DESKTOP` spento sull'istanza: finché non cambia la sessione. */
  let disabled = false;
  /** M1: quando il Mac è stato appena associato (null: nessuna apertura senza tocco). */
  let pairedAt: number | null = null;
  /**
   * I3 (revisione di sicurezza): cresce a ogni `lock()` e a ogni cancellazione
   * del locale. Un'apertura che finisce in un'epoca diversa da quella in cui è
   * partita scarta la chiave: una chiusura durante l'apertura vince.
   */
  let epoch = 0;

  const device = (): StoredDevice | null => {
    const me = deps.identity();
    return me ? deps.store.read(me) : null;
  };

  async function status(): Promise<VaultStatus> {
    if (disabled) return { state: "disabled", fingerprint: null };
    const d = device();
    if (!d) return { state: revoked ? "revoked" : "unpaired", fingerprint: null };
    return { state: key ? "open" : "locked", fingerprint: await deps.fingerprint(d.publicKey) };
  }

  const changed = () => {
    void status().then(deps.onChange, () => {});
  };

  const disarm = () => {
    clearTimeout(timer);
    timer = undefined;
  };
  const arm = () => {
    disarm();
    timer = setTimeout(() => lock(), VAULT_IDLE_MS);
  };

  function lock(): void {
    const was = key !== null;
    epoch += 1;
    pairedAt = null;
    key = null;
    personKeyId = null;
    disarm();
    if (was) changed();
  }

  function dropLocal(): void {
    epoch += 1;
    key = null;
    personKeyId = null;
    disarm();
    pairedAt = null;
    deps.store.forget();
  }

  async function unlock(options: { afterPairing?: boolean } = {}): Promise<UnlockResult> {
    if (!deps.identity()) return { ok: false, code: "no_session" };
    const d = device();
    if (!d) return { ok: false, code: revoked ? "revoked" : "unpaired" };
    if (key) return { ok: true };
    const started = epoch;
    const fresh =
      options.afterPairing === true &&
      pairedAt !== null &&
      Date.now() - pairedAt <= FRESH_PAIRING_MS;
    pairedAt = null;
    if (!fresh) {
      if (!deps.touchId.available()) return { ok: false, code: "touch_id_unavailable" };
      try {
        await deps.touchId.prompt(deps.touchReason ?? "open the vault");
      } catch {
        return { ok: false, code: "touch_id_cancelled" };
      }
    }
    if (epoch !== started) return { ok: false, code: "interrupted" };
    let seal: SealResponse;
    try {
      seal = await deps.fetchSeal();
    } catch {
      return { ok: false, code: "unavailable" };
    }
    if (epoch !== started) return { ok: false, code: "interrupted" };
    if ("disabled" in seal) {
      disabled = true;
      changed();
      return { ok: false, code: "disabled" };
    }
    if ("revoked" in seal) {
      dropLocal();
      revoked = true;
      changed();
      return { ok: false, code: "revoked" };
    }
    let opened: CryptoKey;
    try {
      opened = await deps.openSeal({
        deviceSeal: seal.seal,
        devicePrivateKey: await deps.devicePrivateKey(d),
        personPublicKey: seal.personPublicKey,
        personKeyId: seal.personKeyId,
        deviceId: d.deviceId,
      });
    } catch {
      return { ok: false, code: "open_failed" };
    }
    // Chiusa, o cambiata la sessione, mentre si apriva: la chiave non resta.
    if (epoch !== started) return { ok: false, code: "interrupted" };
    key = opened;
    personKeyId = seal.personKeyId;
    arm();
    changed();
    return { ok: true };
  }

  async function use<T>(run: (k: CryptoKey, id: string) => Promise<T>): Promise<T> {
    if (!key || !personKeyId) throw new Error("vault_locked");
    arm();
    return run(key, personKeyId);
  }

  async function forget(): Promise<{ ok: true; remote: boolean }> {
    let remote = true;
    try {
      await deps.forgetRemote();
    } catch (error) {
      remote = false;
      console.warn(
        "stubwise: cassaforte — sigillo del Mac non tolto dal server (best-effort)",
        error,
      );
    }
    dropLocal();
    revoked = false;
    changed();
    return { ok: true, remote };
  }

  return {
    status,
    unlock,
    lock,
    use,
    forget,
    markPaired: () => {
      revoked = false;
      pairedAt = Date.now();
      changed();
    },
    sessionChanged: () => {
      // M3: il sigillo di questo PAT sul server, finché il token è ancora quello.
      if (device()) {
        void deps.forgetRemote().catch((error: unknown) => {
          console.warn(
            "stubwise: cassaforte — sigillo del Mac non tolto al cambio di sessione (best-effort)",
            error,
          );
        });
      }
      dropLocal();
      revoked = false;
      disabled = false;
      changed();
    },
    markDisabled: () => {
      epoch += 1;
      key = null;
      personKeyId = null;
      disarm();
      disabled = true;
      changed();
    },
    markRevoked: () => {
      dropLocal();
      revoked = true;
      changed();
    },
  };
}
