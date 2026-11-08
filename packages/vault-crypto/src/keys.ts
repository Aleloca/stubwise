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

/** Prefisso dell'AAD del sigillo; segue lo SHA-256 del punto pubblico (65 byte, `raw`). */
const SEAL_AAD_PREFIX = "stubwise/vault/v1/seal:";

/** Il punto pubblico non compresso (65 byte), dalla pubblica JWK. */
async function rawPublicPoint(publicKey: string): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(await subtle().exportKey("raw", await importPublicKey(publicKey)));
}

/**
 * AAD del sigillo: `stubwise/vault/v1/seal:` ‖ SHA-256(punto pubblico). Lega
 * il sigillo alla SUA pubblica: se il server presentasse un'altra pubblica
 * accanto al sigillo (per farsi cifrare le copie per una chiave sua), il
 * sigillo non si aprirebbe.
 */
async function sealAad(publicKey: string): Promise<Uint8Array<ArrayBuffer>> {
  const digest = new Uint8Array(await subtle().digest("SHA-256", await rawPublicPoint(publicKey)));
  const prefix = utf8(SEAL_AAD_PREFIX);
  const out = new Uint8Array(prefix.length + digest.length);
  out.set(prefix);
  out.set(digest, prefix.length);
  return out;
}

/**
 * Verifica che la privata pkcs8 sia la metà di `publicKey`: la si importa un
 * attimo come estraibile per leggerne il punto pubblico (`x`, `y` del JWK) e
 * lo si confronta con quello di `publicKey`. Lancia se non coincidono.
 */
async function assertPairMatches(pkcs8: Uint8Array<ArrayBuffer>, publicKey: string): Promise<void> {
  const privateKey = await subtle().importKey("pkcs8", pkcs8, ECDH, true, ["deriveBits"]);
  const jwk = await subtle().exportKey("jwk", privateKey);
  const expected = JSON.parse(await exportPublicKey(await importPublicKey(publicKey))) as JsonWebKey;
  // Il JWK della privata porta anche `d`: non esce da questa funzione.
  delete jwk.d;
  if (jwk.x !== expected.x || jwk.y !== expected.y) {
    throw new Error("la chiave privata non corrisponde alla chiave pubblica");
  }
}

/**
 * Sigilla la privata pkcs8 con la chiave di sblocco ricavata dall'uscita PRF,
 * con AAD legato alla sua `publicKey` ({@link sealAad}). Lancia se la privata
 * non è la metà di `publicKey`.
 */
export async function sealPrivateKey(prfOutput: ArrayBuffer, pkcs8: Uint8Array, publicKey: string): Promise<string> {
  const plain = bytes(pkcs8);
  try {
    await assertPairMatches(plain, publicKey);
    const key = await hkdfAesKey(prfOutput, HKDF_INFO.unlock);
    const iv = randomIv();
    const ct = await subtle().encrypt({ name: "AES-GCM", iv, additionalData: await sealAad(publicKey) }, key, plain);
    return formatEnvelope({ iv, ct });
  } finally {
    plain.fill(0);
  }
}

/** Decifra il sigillo (AAD della pubblica) e verifica la coppia; la pkcs8 resta al chiamante da azzerare. */
async function unsealPkcs8(prfOutput: ArrayBuffer, sealed: string, publicKey: string): Promise<Uint8Array<ArrayBuffer>> {
  const { iv, ct } = parseEnvelope(sealed, ["iv", "ct"]);
  const key = await hkdfAesKey(prfOutput, HKDF_INFO.unlock);
  const pkcs8 = new Uint8Array(
    await subtle().decrypt({ name: "AES-GCM", iv, additionalData: await sealAad(publicKey) }, key, ct),
  );
  try {
    await assertPairMatches(pkcs8, publicKey);
  } catch (error) {
    pkcs8.fill(0);
    throw error;
  }
  return pkcs8;
}

/**
 * Apre la privata sigillata della chiave `publicKey` (quella che il server
 * dice essere la propria). Lancia se l'uscita PRF non è quella giusta, o se
 * il sigillo non è della chiave `publicKey`: chi apre fallisce chiuso invece
 * di cifrare copie per una pubblica che non è la sua.
 */
export async function openPrivateKey(prfOutput: ArrayBuffer, sealed: string, publicKey: string): Promise<CryptoKey> {
  const pkcs8 = await unsealPkcs8(prfOutput, sealed, publicKey);
  try {
    return await importPrivateKey(pkcs8);
  } finally {
    pkcs8.fill(0);
  }
}

/**
 * Sigilla per una passkey NUOVA la privata già sigillata per un'altra: apre
 * il sigillo col PRF della vecchia, lo richiude col PRF della nuova, entrambi
 * con l'AAD di `publicKey`. La privata in chiaro (pkcs8) resta dentro questa
 * funzione e si azzera prima di uscire: il chiamante non la vede mai, e la
 * `CryptoKey` aperta altrove resta non estraibile. Lancia se `prfOld` non
 * apre `sealed` o se il sigillo non è della chiave `publicKey`.
 */
export async function resealPrivateKey(
  prfOld: ArrayBuffer,
  sealed: string,
  prfNew: ArrayBuffer,
  publicKey: string,
): Promise<string> {
  const pkcs8 = await unsealPkcs8(prfOld, sealed, publicKey);
  try {
    return await sealPrivateKey(prfNew, pkcs8, publicKey);
  } finally {
    pkcs8.fill(0);
  }
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
