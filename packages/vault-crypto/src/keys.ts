// Chiavi di persona (ECDH P-256) e loro sigillo con l'uscita PRF della
// passkey. La pubblica viaggia come JWK serializzato con i soli campi
// pubblici; la privata esce in pkcs8 UNA volta sola, alla generazione,
// perché il chiamante la sigilli per ogni passkey — poi vive solo come
// CryptoKey non estraibile.

import { bytes, formatEnvelope, parseEnvelope, utf8 } from "./encoding.js";

const subtle = () => globalThis.crypto.subtle;

const ECDH = { name: "ECDH", namedCurve: "P-256" } as const;

/** Etichette HKDF `info`, una per derivazione (namespace `stubwise/vault/v1/`). */
export const HKDF_INFO = {
  /** Chiave di sblocco: HKDF(uscita PRF) → AES-256-GCM che sigilla la privata. */
  unlock: "stubwise/vault/v1/unlock",
  /** Chiave di wrapping: HKDF(ECDH effimera-statica) → AES-256-GCM che cifra la chiave d'oggetto. */
  wrap: "stubwise/vault/v1/wrap",
} as const;

/**
 * Input fisso della valutazione PRF della passkey:
 * `SHA-256("stubwise/vault/v1/prf")`, precalcolato (il test lo ricalcola).
 */
export const PRF_INPUT: Uint8Array<ArrayBuffer> = new Uint8Array([
  0xc4, 0xa0, 0xa6, 0x6f, 0x02, 0xec, 0x39, 0xc8, 0xc2, 0xda, 0x8d, 0x52, 0x8c, 0x1f, 0x91, 0x23,
  0x47, 0x9b, 0x7d, 0x73, 0xff, 0xb1, 0xa5, 0xb2, 0x77, 0xcf, 0x5b, 0xb1, 0xd4, 0x74, 0xec, 0xa2,
]);

/** Esporta la pubblica come JWK con i soli campi pubblici, in ordine fisso. */
export async function exportPublicKey(key: CryptoKey): Promise<string> {
  const jwk = await subtle().exportKey("jwk", key);
  return JSON.stringify({ kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y });
}

/** Importa una pubblica JWK P-256; lancia se non lo è. */
export async function importPublicKey(publicKey: string): Promise<CryptoKey> {
  const jwk = JSON.parse(publicKey) as Record<string, unknown>;
  if (
    jwk.kty !== "EC" ||
    jwk.crv !== "P-256" ||
    typeof jwk.x !== "string" ||
    typeof jwk.y !== "string" ||
    "d" in jwk
  ) {
    throw new Error("chiave pubblica non valida");
  }
  return subtle().importKey("jwk", { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y }, ECDH, true, []);
}

/** Importa una privata pkcs8 come chiave ECDH NON estraibile. */
export async function importPrivateKey(pkcs8: Uint8Array): Promise<CryptoKey> {
  return subtle().importKey("pkcs8", bytes(pkcs8), ECDH, false, ["deriveBits"]);
}

/** Genera una coppia ECDH P-256 e ne esporta pubblica (JWK) e privata (pkcs8). */
export async function generateExportableKeyPair(): Promise<{ publicKey: string; privateKeyPkcs8: Uint8Array<ArrayBuffer> }> {
  const pair = await subtle().generateKey(ECDH, true, ["deriveBits"]);
  return {
    publicKey: await exportPublicKey(pair.publicKey),
    privateKeyPkcs8: new Uint8Array(await subtle().exportKey("pkcs8", pair.privateKey)),
  };
}

export async function generatePersonKeyPair(): Promise<{
  publicKey: string;
  privateKey: CryptoKey;
  privateKeyPkcs8: Uint8Array;
}> {
  const { publicKey, privateKeyPkcs8 } = await generateExportableKeyPair();
  return { publicKey, privateKey: await importPrivateKey(privateKeyPkcs8), privateKeyPkcs8 };
}

/** HKDF-SHA-256 (salt vuoto se assente) → chiave AES-256-GCM non estraibile. */
export async function hkdfAesKey(
  secret: ArrayBuffer | Uint8Array,
  info: string,
  salt: Uint8Array = new Uint8Array(0),
): Promise<CryptoKey> {
  const base = await subtle().importKey("raw", bytes(secret), "HKDF", false, ["deriveKey"]);
  return subtle().deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: bytes(salt), info: utf8(info) },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

export function randomIv(): Uint8Array<ArrayBuffer> {
  return globalThis.crypto.getRandomValues(new Uint8Array(12));
}

/** Sigilla la privata pkcs8 con la chiave di sblocco ricavata dall'uscita PRF. */
export async function sealPrivateKey(prfOutput: ArrayBuffer, pkcs8: Uint8Array): Promise<string> {
  const key = await hkdfAesKey(prfOutput, HKDF_INFO.unlock);
  const iv = randomIv();
  const ct = await subtle().encrypt({ name: "AES-GCM", iv }, key, bytes(pkcs8));
  return formatEnvelope({ iv, ct });
}

/** Apre la privata sigillata; lancia se l'uscita PRF non è quella giusta. */
export async function openPrivateKey(prfOutput: ArrayBuffer, sealed: string): Promise<CryptoKey> {
  const { iv, ct } = parseEnvelope(sealed, ["iv", "ct"]);
  const key = await hkdfAesKey(prfOutput, HKDF_INFO.unlock);
  const pkcs8 = await subtle().decrypt({ name: "AES-GCM", iv }, key, ct);
  return importPrivateKey(new Uint8Array(pkcs8));
}

/**
 * Impronta di una pubblica, da mostrare nella conferma: prime 16 cifre
 * esadecimali dello SHA-256 del punto non compresso (65 byte, formato
 * `raw`), a gruppi di 4 separati da spazio. Si calcola sul punto, non sul
 * JSON, così non dipende dalla serializzazione.
 */
export async function keyFingerprint(publicKey: string): Promise<string> {
  const raw = await subtle().exportKey("raw", await importPublicKey(publicKey));
  const digest = new Uint8Array(await subtle().digest("SHA-256", raw));
  const hex = Array.from(digest.subarray(0, 8), (b) => b.toString(16).padStart(2, "0")).join("");
  return hex.match(/.{4}/g)!.join(" ");
}
