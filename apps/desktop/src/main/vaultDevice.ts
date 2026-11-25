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
// sistema. Su disco, in `vault-device.bin` cifrato con `safeStorage`, sta
// solo il suo `dataRepresentation` — un blob opaco che solo l'enclave di
// questo Mac sa usare — con la pubblica e gli id. Senza cifratura del sistema
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

/** Ciò che si scrive (cifrato) su disco. La versione 1 (con la pkcs8) non vale più. */
export interface StoredDevice extends DeviceIdentity {
  v: 2;
  /** L'id del sigillo sul server (`vault_device_seals.id`, nell'AAD). */
  deviceId: string;
  /** La chiave di persona sigillata; null finché il server non lo dice. */
  personKeyId: string | null;
  /** La pubblica del dispositivo, JWK (come le chiavi di persona). */
  publicKey: string;
  /** La chiave nel Secure Enclave: il suo `dataRepresentation` (base64), inutile fuori da questo Mac. */
  enclaveKey: string;
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
  stored: Pick<StoredDevice, "publicKey" | "enclaveKey">;
}> {
  const made = await helper.create();
  const publicKey = await devicePublicKeyFromRaw(made.publicKey);
  return { publicKey, stored: { publicKey, enclaveKey: made.key } };
}

/**
 * L'accordo di chiave del dispositivo per `openDeviceSeal`: l'ECDH lo fa
 * l'enclave (Touch ID con `reason`, a ogni uso), HKDF e AES-GCM restano in
 * `@stubwise/vault-crypto`.
 */
export function deviceAgreement(
  device: Pick<StoredDevice, "enclaveKey">,
  helper: Pick<KeyHelper, "ecdh">,
  reason: string,
): { deriveBits: (ephemeralPublicKey: Uint8Array) => Promise<Uint8Array> } {
  return { deriveBits: (eph) => helper.ecdh(device.enclaveKey, eph, reason) };
}

/** Scrive il file; `false` (e niente su disco) senza cifratura del sistema. */
export function saveDevice(device: Omit<StoredDevice, "v">): boolean {
  if (!safeStorage.isEncryptionAvailable()) return false;
  const stored: StoredDevice = { v: 2, ...device };
  writeFileSync(file(), safeStorage.encryptString(JSON.stringify(stored)));
  return true;
}

const sameIdentity = (a: DeviceIdentity, b: DeviceIdentity) =>
  a.instanceUrl === b.instanceUrl && a.patId === b.patId;

function isStored(value: unknown): value is StoredDevice {
  const d = value as Partial<StoredDevice> | null;
  return (
    !!d &&
    d.v === 2 &&
    [d.instanceUrl, d.patId, d.deviceId, d.publicKey, d.enclaveKey].every(
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

/**
 * La revoca locale: il file sparisce (la chiave di persona in memoria la
 * toglie `vaultLock`). La chiave nell'enclave resta, inutilizzabile senza il
 * blob.
 */
export function forgetDevice(): void {
  rmSync(file(), { force: true });
}
