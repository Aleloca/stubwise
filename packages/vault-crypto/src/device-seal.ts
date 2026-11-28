// Il sigillo del dispositivo (lotto 10, `docs/plans/2026-11-24-cassaforte-desktop-design.md`
// §1): la privata di PERSONA avvolta per la pubblica di un Mac associato.
//
// - La coppia del dispositivo è ECDH P-256 e nasce nel Secure Enclave (review
//   I1): la pubblica arriva da lì (`devicePublicKeyFromRaw` → JWK), la
//   privata non esce mai dall'enclave e l'ECDH lo fa lui (`deriveBits`).
// - Il browser sigilla a partire dal sigillo della PASSKEY e dalla sua uscita
//   PRF (come `resealPrivateKey`): la privata in chiaro non esce mai da questo
//   modulo, e la CryptoKey aperta nel browser resta non estraibile.
// - Forma: ECDH effimera-statica verso il Mac → HKDF (`info` suo, salt =
//   l'effimera) → AES-256-GCM della pkcs8. La busta è `{ v: 1, epk, iv, ct }`.
// - AAD: `stubwise/vault/v1/device-seal:<personKeyId>:<deviceId>:` ‖
//   SHA-256(punto pubblico di persona). Lega il sigillo alla sua riga (non si
//   sposta su un altro Mac né su una chiave ricreata) e alla pubblica di
//   persona: se il server ne presentasse un'altra, il Mac non apre nulla. Chi
//   apre verifica anche che la privata sia la metà di quella pubblica.

import { bytes, formatEnvelope, parseEnvelope, utf8 } from "./encoding.js";
import {
  HKDF_INFO,
  assertPairMatches,
  exportPublicKey,
  hkdfAesKey,
  importPrivateKey,
  importPublicKey,
  randomIv,
  rawPublicPoint,
  unsealPkcs8,
} from "./keys.js";
import { subtle } from "./runtime.js";

const ECDH = { name: "ECDH", namedCurve: "P-256" } as const;
const AAD_PREFIX = "stubwise/vault/v1/device-seal:";

function assertId(id: string, name: string): void {
  if (id.length === 0 || id.includes(":")) throw new Error(`id non valido: ${name}`);
}

async function deviceSealAad(personKeyId: string, deviceId: string, personPublicKey: string): Promise<Uint8Array<ArrayBuffer>> {
  assertId(personKeyId, "personKeyId");
  assertId(deviceId, "deviceId");
  const digest = new Uint8Array(await subtle().digest("SHA-256", await rawPublicPoint(personPublicKey)));
  const prefix = utf8(`${AAD_PREFIX}${personKeyId}:${deviceId}:`);
  const out = new Uint8Array(prefix.length + digest.length);
  out.set(prefix);
  out.set(digest, prefix.length);
  return out;
}

/**
 * Nel browser, a cassaforte aperta con la passkey: apre il sigillo della
 * passkey (`sealed`, con la sua uscita PRF), verifica la coppia e avvolge la
 * privata di persona per il Mac. Lancia su PRF sbagliato, su una pubblica di
 * persona che non è quella del sigillo, su una pubblica del Mac non valida.
 */
export async function sealForDevice(input: {
  prfOutput: ArrayBuffer;
  sealed: string;
  personPublicKey: string;
  personKeyId: string;
  devicePublicKey: string;
  deviceId: string;
}): Promise<string> {
  const aad = await deviceSealAad(input.personKeyId, input.deviceId, input.personPublicKey);
  const device = await importPublicKey(input.devicePublicKey);
  const pkcs8 = await unsealPkcs8(input.prfOutput, input.sealed, input.personPublicKey);
  try {
    const ephemeral = await subtle().generateKey(ECDH, true, ["deriveBits"]);
    const epk = new Uint8Array(await subtle().exportKey("raw", ephemeral.publicKey));
    const shared = await subtle().deriveBits({ name: "ECDH", public: device }, ephemeral.privateKey, 256);
    const key = await hkdfAesKey(shared, HKDF_INFO.deviceSeal, epk);
    const iv = randomIv();
    const ct = await subtle().encrypt({ name: "AES-GCM", iv, additionalData: aad }, key, pkcs8);
    return formatEnvelope({ epk, iv, ct });
  } finally {
    pkcs8.fill(0);
  }
}

/**
 * La pubblica di una chiave del Mac nata FUORI da WebCrypto (Secure Enclave,
 * review I1: il punto non compresso, 65 byte, che dà CryptoKit) come JWK con
 * i soli campi pubblici, la forma che il server vuole. Lancia se non è un
 * punto P-256.
 */
export async function devicePublicKeyFromRaw(raw: Uint8Array): Promise<string> {
  const key = await subtle().importKey("raw", bytes(raw), ECDH, true, []);
  return exportPublicKey(key);
}

/**
 * L'ECDH col Mac — review I1, la chiave nel Secure Enclave (Keychain di data
 * protection): una funzione che riceve il punto effimero della busta (non
 * compresso, 65 byte) e restituisce i 32 byte del segreto condiviso (la
 * coordinata x, come `sharedSecretFromKeyAgreement` di CryptoKit). Review 2,
 * M8: è l'UNICA via; quella con la privata come CryptoKey nel processo (la
 * vecchia, senza tocco) non c'è più, e i test usano `@stubwise/vault-crypto/testing`.
 */
export type DeviceKeyAgreement = {
  deriveBits: (ephemeralPublicKey: Uint8Array) => Promise<ArrayBuffer | Uint8Array>;
};

async function sharedSecret(agreement: DeviceKeyAgreement, epk: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  if (typeof agreement.deriveBits !== "function") throw new Error("serve deriveBits (l'ECDH del Secure Enclave)");
  const shared = bytes(await agreement.deriveBits(new Uint8Array(epk)));
  if (shared.length !== 32) throw new Error("il segreto condiviso dev'essere di 32 byte");
  return shared;
}

/**
 * Nel main del desktop: apre il sigillo del Mac con l'ECDH dell'enclave
 * ({@link DeviceKeyAgreement}) e dà
 * la privata di persona come CryptoKey NON estraibile, dopo aver verificato
 * che sia la metà di `personPublicKey` (la pubblica CONFERMATA che dice il
 * server). Lancia su un altro Mac, su id o pubblica che non sono i suoi.
 */
export async function openDeviceSeal(
  input: {
    deviceSeal: string;
    personPublicKey: string;
    personKeyId: string;
    deviceId: string;
  } & DeviceKeyAgreement,
): Promise<CryptoKey> {
  const aad = await deviceSealAad(input.personKeyId, input.deviceId, input.personPublicKey);
  const { epk, iv, ct } = parseEnvelope(input.deviceSeal, ["epk", "iv", "ct"]);
  const shared = await sharedSecret(input, epk);
  const key = await hkdfAesKey(shared, HKDF_INFO.deviceSeal, epk);
  const pkcs8 = bytes(await subtle().decrypt({ name: "AES-GCM", iv, additionalData: aad }, key, ct));
  try {
    await assertPairMatches(pkcs8, input.personPublicKey);
    return await importPrivateKey(pkcs8);
  } finally {
    pkcs8.fill(0);
  }
}

