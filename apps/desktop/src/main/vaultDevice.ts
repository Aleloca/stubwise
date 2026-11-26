import { randomBytes } from "node:crypto";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { devicePublicKeyFromRaw } from "@stubwise/vault-crypto";
import { app, safeStorage } from "electron";
import type { KeyHelper } from "./keyHelper";

// La chiave del dispositivo della cassaforte (lotto 10, design
// `docs/plans/2026-11-24-cassaforte-desktop-design.md`, §1–§2 e §4; revisione
// di sicurezza I1: nel Secure Enclave).
//
// Sul Mac non si salva la privata di persona, e nemmeno quella del
// dispositivo: la chiave del dispositivo è NEL Secure Enclave
// (`stubwise-keyhelper`), non esportabile, e ogni uso chiede il Touch ID al
// sistema. Dalla seconda revisione (I1) è una voce del Keychain di data
// protection con l'access group del Team ID: solo i binari firmati del team
// la usano (prima era un `dataRepresentation` su disco, che qualunque
// binario poteva dare all'enclave). Su disco, in `vault-device.bin` cifrato
// con `safeStorage`, stanno solo gli id, il TAG della voce e la pubblica.
// Senza cifratura del sistema
// non si salva niente. Il file vale SOLO per la sessione con cui è nato
// (istanza e PAT): un altro login non lo eredita, e un file che non coincide
// (o di una versione vecchia, con la pkcs8) si cancella. Niente di questo
// modulo lascia il processo main.

/**
 * A chi appartiene il file: la sessione desktop di adesso. Un PAT è di una
 * persona sola, quindi istanza + PAT dicono anche la persona (un altro login,
 * anche della stessa persona, è un altro PAT).
 */
export interface DeviceIdentity {
  instanceUrl: string;
  patId: string;
}

/** Ciò che si scrive (cifrato) su disco. Le versioni 1 (pkcs8) e 2 (blob dell'enclave) non valgono più. */
export interface StoredDevice extends DeviceIdentity {
  v: 3;
  /** L'id del sigillo sul server (`vault_device_seals.id`, nell'AAD). */
  deviceId: string;
  /** La chiave di persona sigillata; null finché il server non lo dice. */
  personKeyId: string | null;
  /** La pubblica del dispositivo, JWK (come le chiavi di persona). */
  publicKey: string;
  /** Il tag della voce del Keychain (la chiave nell'enclave): `stubwise.vault.<32 hex>`. */
  keyTag: string;
}

const file = () => join(app.getPath("userData"), "vault-device.bin");

/**
 * Una chiave nuova del dispositivo, NEL Secure Enclave (`helper.create`). La
 * pubblica (JWK, `devicePublicKeyFromRaw` dai 65 byte dell'enclave) va al
 * server con l'accoppiamento; `stored` è ciò che `saveDevice` scrive, dopo
 * che il sigillo si è aperto (design §7, passo 4).
 */
export async function generateDeviceKey(helper: Pick<KeyHelper, "create">): Promise<{
  publicKey: string;
  stored: Pick<StoredDevice, "publicKey" | "keyTag">;
}> {
  const keyTag = `stubwise.vault.${randomBytes(16).toString("hex")}`;
  const made = await helper.create(keyTag);
  const publicKey = await devicePublicKeyFromRaw(made.publicKey);
  return { publicKey, stored: { publicKey, keyTag } };
}

/**
 * L'accordo di chiave del dispositivo per `openDeviceSeal`: l'ECDH lo fa
 * l'enclave (Touch ID a ogni uso, con la frase fissata nell'helper), HKDF e
 * AES-GCM restano in `@stubwise/vault-crypto`.
 */
export function deviceAgreement(
  device: Pick<StoredDevice, "keyTag">,
  helper: Pick<KeyHelper, "ecdh">,
): { deriveBits: (ephemeralPublicKey: Uint8Array) => Promise<Uint8Array> } {
  return { deriveBits: (eph) => helper.ecdh(device.keyTag, eph) };
}

/** Scrive il file; `false` (e niente su disco) senza cifratura del sistema. */
export function saveDevice(device: Omit<StoredDevice, "v">): boolean {
  if (!safeStorage.isEncryptionAvailable()) return false;
  const stored: StoredDevice = { v: 3, ...device };
  writeFileSync(file(), safeStorage.encryptString(JSON.stringify(stored)));
  return true;
}

const sameIdentity = (a: DeviceIdentity, b: DeviceIdentity) =>
  a.instanceUrl === b.instanceUrl && a.patId === b.patId;

function isStored(value: unknown): value is StoredDevice {
  const d = value as Partial<StoredDevice> | null;
  return (
    !!d &&
    d.v === 3 &&
    [d.instanceUrl, d.patId, d.deviceId, d.publicKey, d.keyTag].every(
      (x) => typeof x === "string" && x !== "",
    ) &&
    (d.personKeyId === null || typeof d.personKeyId === "string")
  );
}

/**
 * Il file della sessione `me`, o `null`. Un file che non è di `me` (un altro
 * login, un'altra istanza), rotto o di un'altra versione si cancella: un solo
 * dispositivo associato per profilo dell'app (§4).
 */
export function readDevice(me: DeviceIdentity): StoredDevice | null {
  if (!safeStorage.isEncryptionAvailable()) return null;
  let raw: Buffer;
  try {
    raw = readFileSync(file());
  } catch {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(safeStorage.decryptString(raw));
    if (isStored(parsed) && sameIdentity(parsed, me)) return parsed;
  } catch {
    // rotto: si cancella sotto
  }
  forgetDevice();
  return null;
}

let keyDeleter: ((tag: string) => Promise<void>) | null = null;

/** Chi toglie la voce del Keychain quando il file sparisce (il main: l'helper). */
export function setKeyDeleter(deleter: ((tag: string) => Promise<void>) | null): void {
  keyDeleter = deleter;
}

/** Il tag nel file, di chiunque sia (per togliere la voce anche di un file scartato). */
function storedTag(): string | null {
  if (!safeStorage.isEncryptionAvailable()) return null;
  try {
    const parsed = JSON.parse(safeStorage.decryptString(readFileSync(file()))) as {
      keyTag?: unknown;
    };
    return typeof parsed.keyTag === "string" && parsed.keyTag !== "" ? parsed.keyTag : null;
  } catch {
    return null;
  }
}

/**
 * La revoca locale: il file sparisce, e con lui la voce del Keychain
 * (best-effort, mai silenzioso). La chiave di persona in memoria la toglie
 * `vaultLock`.
 */
export function forgetDevice(): void {
  const tag = storedTag();
  rmSync(file(), { force: true });
  if (tag && keyDeleter) {
    void keyDeleter(tag).catch((error: unknown) => {
      console.warn("stubwise: cassaforte — voce del Keychain non tolta (best-effort)", error);
    });
  }
}
