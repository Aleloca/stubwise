import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { generateDeviceKeyPair, importDeviceKey } from "@stubwise/vault-crypto";
import { app, safeStorage } from "electron";

// La chiave del dispositivo della cassaforte (lotto 10, design
// `docs/plans/2026-11-24-cassaforte-desktop-design.md`, §1–§2 e §4).
//
// Sul Mac non si salva la privata di persona: si salva una coppia P-256
// del DISPOSITIVO, e il server tiene la privata di persona sigillata per la
// sua pubblica. La privata del dispositivo sta in `vault-device.bin`,
// cifrata con `safeStorage` (su Mac la chiave è nel portachiavi di login),
// accanto a `session.bin`; senza cifratura del sistema non si salva niente.
// Il file vale SOLO per la sessione con cui è nato (istanza e PAT):
// un altro login non lo eredita, e un file che non coincide si cancella.
// Niente di questo modulo lascia il processo main.

/**
 * A chi appartiene il file: la sessione desktop di adesso. Un PAT è di una
 * persona sola, quindi istanza + PAT dicono anche la persona (un altro login,
 * anche della stessa persona, è un altro PAT).
 */
export interface DeviceIdentity {
  instanceUrl: string;
  patId: string;
}

/** Ciò che si scrive (cifrato) su disco. */
export interface StoredDevice extends DeviceIdentity {
  v: 1;
  /** L'id del sigillo sul server (`vault_device_seals.id`, nell'AAD). */
  deviceId: string;
  /** La chiave di persona sigillata; null finché il server non lo dice. */
  personKeyId: string | null;
  /** La pubblica del dispositivo, JWK (come le chiavi di persona). */
  publicKey: string;
  /** La privata del dispositivo, PKCS#8 in base64url. */
  privateKey: string;
}

const file = () => join(app.getPath("userData"), "vault-device.bin");

/**
 * Una coppia nuova del dispositivo (`generateDeviceKeyPair` di
 * `@stubwise/vault-crypto`). La pubblica (JWK) va al server con
 * l'accoppiamento; `stored` è ciò che `saveDevice` scrive, dopo che il
 * sigillo si è aperto (design §7, passo 4). I byte del pkcs8 si azzerano
 * appena codificati: da lì in poi solo `importDeviceKey`.
 */
export async function generateDeviceKey(): Promise<{
  publicKey: string;
  stored: Pick<StoredDevice, "publicKey" | "privateKey">;
}> {
  const pair = await generateDeviceKeyPair();
  const privateKey = Buffer.from(pair.privateKeyPkcs8).toString("base64url");
  pair.privateKeyPkcs8.fill(0);
  return { publicKey: pair.publicKey, stored: { publicKey: pair.publicKey, privateKey } };
}

/** La privata del dispositivo per usarla: NON estraibile (`importDeviceKey`). */
export async function devicePrivateKey(
  device: Pick<StoredDevice, "privateKey">,
): Promise<CryptoKey> {
  const pkcs8 = new Uint8Array(Buffer.from(device.privateKey, "base64url"));
  try {
    return await importDeviceKey(pkcs8);
  } finally {
    pkcs8.fill(0);
  }
}

/** Scrive il file; `false` (e niente su disco) senza cifratura del sistema. */
export function saveDevice(device: Omit<StoredDevice, "v">): boolean {
  if (!safeStorage.isEncryptionAvailable()) return false;
  const stored: StoredDevice = { v: 1, ...device };
  writeFileSync(file(), safeStorage.encryptString(JSON.stringify(stored)));
  return true;
}

const sameIdentity = (a: DeviceIdentity, b: DeviceIdentity) =>
  a.instanceUrl === b.instanceUrl && a.patId === b.patId;

function isStored(value: unknown): value is StoredDevice {
  const d = value as Partial<StoredDevice> | null;
  return (
    !!d &&
    d.v === 1 &&
    [d.instanceUrl, d.patId, d.deviceId, d.publicKey, d.privateKey].every(
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

/** La revoca locale: il file sparisce (la privata in memoria la toglie `vaultLock`). */
export function forgetDevice(): void {
  rmSync(file(), { force: true });
}
