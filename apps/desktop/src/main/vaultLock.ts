import type { DeviceIdentity, StoredDevice } from "./vaultDevice";

// La cassaforte nel processo main (lotto 10, design
// `docs/plans/2026-11-24-cassaforte-desktop-design.md`, §3–§5, decisioni del
// maintainer in §12, 24 nov 2026).
//
// La privata di persona si apre dal sigillo del dispositivo e vive SOLO qui,
// come `CryptoKey` non estraibile: il renderer chiede operazioni (`use`) e
// riceve esiti, mai la chiave. Le regole:
// - D-1: si riapre col Touch ID, e il tocco lo chiede il SISTEMA: l'ECDH
//   del sigillo lo fa il Secure Enclave, con la biometria a ogni uso
//   (revisione di sicurezza I1; prima era un blocco d'interfaccia,
//   aggirabile). D-1b: dopo l'associazione la chiave aperta per verificare
//   il sigillo passa qui (`adopt`): un tocco solo, e nessuna apertura senza
//   tocco esiste più. D-1a: un Mac senza biometria non si apre da qui, si
//   apre dal browser con la passkey e il sigillo resta. Un build senza la
//   cassaforte (`MAIN_VITE_VAULT_DESKTOP`) o un Mac senza enclave:
//   `unsupported`, dal browser;
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

/**
 * `disabled`: l'istanza non abilita la cassaforte dal desktop (`VAULT_DESKTOP`
 * spento). `unsupported`: questo build o questo Mac non la sanno tenere
 * (niente flag di build, niente Secure Enclave): si apre dal browser.
 */
export type VaultState = "unpaired" | "locked" | "open" | "revoked" | "disabled" | "unsupported";

/** Ciò che il renderer vede: lo stato e l'impronta della chiave del dispositivo. */
export interface VaultStatus {
  state: VaultState;
  fingerprint: string | null;
  /** Il Mac ha Touch ID (D-1a: senza, la cassaforte si apre dal browser). */
  touchId: boolean;
}

export type UnlockCode =
  | "interrupted"
  | "disabled"
  | "unsupported"
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
  /**
   * Cosa sa fare questo build su questo Mac: il Secure Enclave (e il flag di
   * build della cassaforte) e la biometria.
   */
  supported: () => Promise<{ enclave: boolean; biometry: boolean }>;
  /** L'accordo di chiave del dispositivo: l'ECDH dell'enclave, col Touch ID (`deviceAgreement`). */
  agreement: (device: StoredDevice) => {
    deriveBits: (ephemeralPublicKey: Uint8Array) => Promise<Uint8Array>;
  };
  /** `GET /api/vault/device-seals/mine` (72). */
  fetchSeal: () => Promise<SealResponse>;
  /**
   * Apre il sigillo con l'accordo dell'enclave (`openDeviceSeal` di
   * `@stubwise/vault-crypto`, `deriveBits`): restituisce la privata di persona
   * NON estraibile dopo aver verificato che sia la metà di `personPublicKey`,
   * e lancia per un altro Mac, altri id o un'altra pubblica (§1); un tocco
   * annullato lancia `cancelled`.
   */
  openSeal: (input: {
    deviceSeal: string;
    deriveBits: (ephemeralPublicKey: Uint8Array) => Promise<Uint8Array>;
    personPublicKey: string;
    personKeyId: string;
    deviceId: string;
  }) => Promise<CryptoKey>;
  /** `DELETE /api/vault/device-seals/mine` (72), best-effort. */
  forgetRemote: () => Promise<void>;
  fingerprint: (publicKey: string) => Promise<string>;
  /** Avvisa il renderer di un cambio di stato (`vault:changed`). */
  onChange: (status: VaultStatus) => void;
}

export interface VaultLock {
  status: () => Promise<VaultStatus>;
  /** Apre col Touch ID dell'enclave. */
  unlock: () => Promise<UnlockResult>;
  lock: () => void;
  /**
   * Un'operazione con la privata di persona, dentro il main, con l'id della
   * chiave di persona del sigillo (per la prova); chiusa: `vault_locked`.
   */
  use: <T>(run: (key: CryptoKey, personKeyId: string) => Promise<T>) => Promise<T>;
  /**
   * M5 (revisione di sicurezza): un'azione che PASSA l'accesso (condividere,
   * confermare, rifiutare, togliere un lettore) a cassaforte aperta riapre il
   * sigillo dall'enclave — un Touch ID vero per quell'azione — e usa quella
   * chiave. Chiusa: `vault_locked`; tocco annullato: `touch_id_cancelled`.
   */
  useWithTouch: <T>(run: (key: CryptoKey, personKeyId: string) => Promise<T>) => Promise<T>;
  /** «Dimentica questo Mac»: il sigillo sul server (best-effort), il file e la chiave. */
  forget: () => Promise<{ ok: true; remote: boolean }>;
  /**
   * D-1b: la chiave di persona che l'associazione ha GIÀ aperto (col Touch ID,
   * per verificare il sigillo prima di scriverlo) passa qui, senza un secondo
   * tocco. Solo dal ritorno dell'associazione (`receiveVaultUrl`).
   */
  adopt: (key: CryptoKey, personKeyId: string, since: number) => void;
  /**
   * M1 (seconda revisione): l'epoca di adesso. L'associazione la prende PRIMA
   * del tocco e la passa ad `adopt`: una chiusura o un cambio di sessione nel
   * frattempo la fa avanzare, e la chiave aperta si scarta.
   */
  epoch: () => number;
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
    if (disabled) return { state: "disabled", fingerprint: null, touchId: false };
    const support = await deps.supported();
    if (!support.enclave) return { state: "unsupported", fingerprint: null, touchId: false };
    const touchId = support.biometry;
    const d = device();
    if (!d) return { state: revoked ? "revoked" : "unpaired", fingerprint: null, touchId };
    return {
      state: key ? "open" : "locked",
      fingerprint: await deps.fingerprint(d.publicKey),
      touchId,
    };
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
    deps.store.forget();
  }

  async function unlock(): Promise<UnlockResult> {
    if (!deps.identity()) return { ok: false, code: "no_session" };
    const support = await deps.supported();
    if (!support.enclave) return { ok: false, code: "unsupported" };
    const d = device();
    if (!d) return { ok: false, code: revoked ? "revoked" : "unpaired" };
    if (key) return { ok: true };
    // D-1a: senza biometria la chiave dell'enclave non si usa: dal browser.
    if (!support.biometry) return { ok: false, code: "touch_id_unavailable" };
    const started = epoch;
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
      // Il Touch ID lo chiede l'enclave qui, per l'ECDH del sigillo.
      opened = await deps.openSeal({
        deviceSeal: seal.seal,
        ...deps.agreement(d),
        personPublicKey: seal.personPublicKey,
        personKeyId: seal.personKeyId,
        deviceId: d.deviceId,
      });
    } catch (error) {
      const code = error instanceof Error ? error.message : "";
      if (code === "cancelled") return { ok: false, code: "touch_id_cancelled" };
      if (code === "no_biometry" || code === "lockout")
        return { ok: false, code: "touch_id_unavailable" };
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
    // M1: il dispositivo sparito (file cancellato, sessione cambiata) chiude.
    if (!device()) {
      lock();
      throw new Error("vault_locked");
    }
    arm();
    return run(key, personKeyId);
  }

  async function useWithTouch<T>(run: (k: CryptoKey, id: string) => Promise<T>): Promise<T> {
    const d = device();
    // Review M7: a cassaforte chiusa l'azione apre il sigillo per sé (un
    // solo tocco) e la cassaforte resta chiusa; serve un Mac associato.
    if (!d || !deps.identity()) throw new Error("vault_locked");
    const wasOpen = key !== null;
    const started = epoch;
    let seal: SealResponse;
    try {
      seal = await deps.fetchSeal();
    } catch {
      // Come all'apertura: il sigillo che non arriva è «irraggiungibile»
      // (quarta revisione, punto 4), e il tocco non si chiede.
      throw new Error("unavailable");
    }
    if ("disabled" in seal) {
      disabled = true;
      lock();
      throw new Error("disabled");
    }
    if ("revoked" in seal) {
      dropLocal();
      revoked = true;
      changed();
      throw new Error("revoked");
    }
    let fresh: CryptoKey;
    try {
      fresh = await deps.openSeal({
        deviceSeal: seal.seal,
        ...deps.agreement(d),
        personPublicKey: seal.personPublicKey,
        personKeyId: seal.personKeyId,
        deviceId: d.deviceId,
      });
    } catch (error) {
      const code = error instanceof Error ? error.message : "";
      if (code === "cancelled") throw new Error("touch_id_cancelled");
      if (code === "no_biometry" || code === "lockout") throw new Error("touch_id_unavailable");
      throw new Error("open_failed");
    }
    // Chiusa o cambiata la sessione mentre si chiedeva il tocco: l'azione non parte.
    if (epoch !== started || (wasOpen && !key)) throw new Error("vault_locked");
    if (wasOpen) arm();
    return run(fresh, seal.personKeyId);
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
    useWithTouch,
    forget,
    epoch: () => epoch,
    adopt: (opened, id, since) => {
      if (disabled || since !== epoch || !device()) return;
      revoked = false;
      key = opened;
      personKeyId = id;
      arm();
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
