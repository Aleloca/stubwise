import type { DeviceIdentity, StoredDevice } from "./vaultDevice";
import type { SealResponse } from "./vaultLock";
import type { Pairing } from "./vaultRemote";

// L'associazione del Mac alla cassaforte (lotto 10, design §7 lato desktop,
// con la forma delle rotte di 72):
//
// 1. `start()`: il main genera la coppia del dispositivo, chiede
//    l'accoppiamento COL SUO PAT (`POST /api/vault/device-pairings`), apre nel
//    browser `<istanza>/vault-pair?state=<s>` (pagina del web) — nell'URL SOLO lo state
//    (pubblica e nome il browser li legge dal server) — e restituisce
//    l'impronta del dispositivo, che la persona confronta con quella nel
//    browser;
// 2. il browser, con la passkey, sigilla la privata di persona per quella
//    pubblica e riapre `stubwise://vault?state=<s>`;
// 3. `handleUrl()` accetta SOLO lo state pendente, della stessa sessione e
//    non scaduto; scarica il sigillo e lo APRE (la verifica sta in
//    `openDeviceSeal`) PRIMA di scrivere `vault-device.bin`: un sigillo che
//    non si apre non lascia niente su disco. Poi la prima apertura è senza
//    tocco (D-1b).
//
// La privata del dispositivo resta in memoria finché l'associazione non
// finisce; scaduta o annullata, si dimentica.

/** Quanto aspetta l'app il ritorno dal browser (come l'accoppiamento sul server). */
export const PAIRING_TTL_MS = 10 * 60 * 1000;

export type PairingCode =
  | "no_session"
  | "no_pending"
  | "invalid_url"
  | "state_mismatch"
  | "expired"
  | "session_changed"
  | "revoked"
  | "open_failed"
  | "no_secure_storage"
  | "unavailable"
  | "unsupported_build"
  | "touch_id_unavailable"
  | "touch_id_cancelled"
  | (string & {});

export interface VaultPairingDeps {
  identity: () => DeviceIdentity | null;
  deviceName: () => string;
  /** Cosa sa fare questo build su questo Mac: il Secure Enclave e la biometria. */
  supported: () => Promise<{ enclave: boolean; biometry: boolean }>;
  /** Una chiave nuova nel Secure Enclave (`generateDeviceKey`). */
  generate: () => Promise<{
    publicKey: string;
    stored: Pick<StoredDevice, "publicKey" | "keyTag">;
  }>;
  /** L'ECDH dell'enclave, col Touch ID (`deviceAgreement`). */
  agreement: (device: Pick<StoredDevice, "keyTag">) => {
    deriveBits: (ephemeralPublicKey: Uint8Array) => Promise<Uint8Array>;
  };
  pair: (devicePublicKey: string, deviceName: string) => Promise<Pairing>;
  openExternal: (url: string) => Promise<void> | void;
  fetchSeal: () => Promise<SealResponse>;
  openSeal: (input: {
    deviceSeal: string;
    deriveBits: (ephemeralPublicKey: Uint8Array) => Promise<Uint8Array>;
    personPublicKey: string;
    personKeyId: string;
    deviceId: string;
  }) => Promise<CryptoKey>;
  save: (device: Omit<StoredDevice, "v">) => boolean;
  /**
   * Associato: la chiave di persona già aperta (col Touch ID, per verificare
   * il sigillo) passa alla cassaforte (`adopt`, D-1b). Resta nel main: il
   * risultato di `handleUrl`, che va al renderer, non la porta.
   */
  /** `since`: l'epoca della cassaforte presa PRIMA del tocco (M1, `vaultLock.adopt`). */
  paired: (key: CryptoKey, personKeyId: string, since: number) => void;
  /** L'epoca della cassaforte di adesso (`vaultLock.epoch`). */
  epoch: () => number;
  fingerprint: (publicKey: string) => Promise<string>;
  now?: () => number;
}

interface Pending {
  state: string;
  deviceId: string;
  identity: DeviceIdentity;
  stored: Pick<StoredDevice, "publicKey" | "keyTag">;
  until: number;
}

const sameIdentity = (a: DeviceIdentity, b: DeviceIdentity) =>
  a.instanceUrl === b.instanceUrl && a.patId === b.patId;

const fail = (code: PairingCode) => ({ ok: false as const, code });

/** Lo state di `stubwise://vault?state=…`, o null per qualunque altro URL. */
export function vaultStateFromUrl(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "stubwise:" || url.hostname !== "vault") return null;
  const state = url.searchParams.get("state");
  return state && /^[A-Za-z0-9_-]{8,256}$/.test(state) ? state : null;
}

export function createVaultPairing(deps: VaultPairingDeps) {
  const now = deps.now ?? Date.now;
  let pending: Pending | null = null;

  async function start(): Promise<
    { ok: true; fingerprint: string } | { ok: false; code: PairingCode }
  > {
    const identity = deps.identity();
    if (!identity) return fail("no_session");
    pending = null;
    // Senza enclave (o in un build senza la cassaforte) non c'è dove tenere la chiave;
    // senza biometria la chiave dell'enclave non si userebbe: dal browser.
    const support = await deps.supported();
    if (!support.enclave) return fail("unsupported_build");
    if (!support.biometry) return fail("touch_id_unavailable");
    try {
      const pair = await deps.generate();
      const pairing = await deps.pair(pair.publicKey, deps.deviceName());
      pending = {
        state: pairing.state,
        deviceId: pairing.deviceId,
        identity,
        stored: pair.stored,
        until: now() + PAIRING_TTL_MS,
      };
      await deps.openExternal(
        `${identity.instanceUrl}/vault-pair?state=${encodeURIComponent(pairing.state)}`,
      );
      return { ok: true, fingerprint: await deps.fingerprint(pair.publicKey) };
    } catch (error) {
      pending = null;
      return fail(error instanceof Error ? error.message : "unavailable");
    }
  }

  /** M1: avanza a ogni `cancel`, anche a richiesta già presa da `handleUrl`. */
  let cancelled = 0;

  async function handleUrl(raw: string): Promise<{ ok: true } | { ok: false; code: PairingCode }> {
    const state = vaultStateFromUrl(raw);
    if (!state) return fail("invalid_url");
    if (!pending) return fail("no_pending");
    if (state !== pending.state) return fail("state_mismatch");
    const p = pending;
    // Uso singolo: da qui la richiesta non c'è più, comunque vada.
    pending = null;
    // M1: prese PRIMA del tocco; un annullamento o una chiusura nel frattempo vincono.
    const generation = cancelled;
    const since = deps.epoch();
    if (now() > p.until) return fail("expired");
    const identity = deps.identity();
    if (!identity || !sameIdentity(identity, p.identity)) return fail("session_changed");
    let seal: SealResponse;
    try {
      seal = await deps.fetchSeal();
    } catch {
      return fail("unavailable");
    }
    if ("revoked" in seal) return fail("revoked");
    if ("disabled" in seal) return fail("vault_desktop_disabled");
    let opened: CryptoKey;
    try {
      // Il Touch ID lo chiede l'enclave qui: la verifica del sigillo È l'apertura.
      opened = await deps.openSeal({
        deviceSeal: seal.seal,
        ...deps.agreement(p.stored),
        personPublicKey: seal.personPublicKey,
        personKeyId: seal.personKeyId,
        deviceId: p.deviceId,
      });
    } catch (error) {
      const code = error instanceof Error ? error.message : "";
      if (code === "cancelled") return fail("touch_id_cancelled");
      if (code === "no_biometry" || code === "lockout") return fail("touch_id_unavailable");
      return fail("open_failed");
    }
    // M1: durante il tocco l'associazione è stata annullata o la sessione è cambiata.
    const after = deps.identity();
    if (cancelled !== generation || !after || !sameIdentity(after, p.identity)) {
      return fail("session_changed");
    }
    if (
      !deps.save({
        ...p.identity,
        deviceId: p.deviceId,
        personKeyId: seal.personKeyId,
        ...p.stored,
      })
    ) {
      return fail("no_secure_storage");
    }
    deps.paired(opened, seal.personKeyId, since);
    return { ok: true };
  }

  return {
    start,
    handleUrl,
    cancel: () => {
      pending = null;
      cancelled += 1;
    },
    isPending: () => pending !== null && now() <= pending.until,
  };
}
