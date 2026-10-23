// Chiavi d'oggetto (una per credenziale) e loro copie per lettore.
//
// - Password: AES-256-GCM con la chiave d'oggetto, AAD = `credentialId`.
// - Copia della chiave d'oggetto per un destinatario (ECIES su P-256): una
//   coppia ECDH EFFIMERA nuova a ogni copia, ECDH con la pubblica del
//   destinatario → HKDF-SHA-256 (salt = pubblica effimera in formato raw,
//   info `stubwise/vault/v1/wrap`) → AES-256-GCM, AAD =
//   `credentialId + ":" + recipientId`. La pubblica effimera viaggia nella
//   busta (`epk`). L'AAD lega la copia alla sua credenziale e al suo
//   destinatario: incollata altrove non si apre.
//
// La chiave d'oggetto è estraibile perché va ricifrata per altri lettori
// (creazione, conferma di un accesso in attesa); le private no.

import { bytes, formatEnvelope, fromUtf8, parseEnvelope, utf8 } from "./encoding.js";
import { HKDF_INFO, hkdfAesKey, importPublicKey, randomIv } from "./keys.js";

const subtle = () => globalThis.crypto.subtle;

const ECDH = { name: "ECDH", namedCurve: "P-256" } as const;

function copyAad(credentialId: string, recipientId: string): Uint8Array<ArrayBuffer> {
  return utf8(`${credentialId}:${recipientId}`);
}

async function importItemKey(raw: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
  return subtle().importKey("raw", raw, { name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
}

/** Genera una chiave d'oggetto nuova e ci cifra la password. */
export async function encryptPassword(
  credentialId: string,
  password: string,
): Promise<{ ciphertext: string; itemKey: CryptoKey }> {
  const itemKey = await subtle().generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
  const iv = randomIv();
  const ct = await subtle().encrypt(
    { name: "AES-GCM", iv, additionalData: utf8(credentialId) },
    itemKey,
    utf8(password),
  );
  return { ciphertext: formatEnvelope({ iv, ct }), itemKey };
}

/** Decifra la password; lancia se chiave o `credentialId` non sono quelli giusti. */
export async function decryptPassword(credentialId: string, ciphertext: string, itemKey: CryptoKey): Promise<string> {
  const { iv, ct } = parseEnvelope(ciphertext, ["iv", "ct"]);
  const plain = await subtle().decrypt({ name: "AES-GCM", iv, additionalData: utf8(credentialId) }, itemKey, ct);
  return fromUtf8(plain);
}

/** Cifra la chiave d'oggetto per la pubblica di un destinatario. */
export async function wrapItemKey(
  itemKey: CryptoKey,
  recipientPublicKey: string,
  credentialId: string,
  recipientId: string,
): Promise<string> {
  const recipient = await importPublicKey(recipientPublicKey);
  const ephemeral = await subtle().generateKey(ECDH, true, ["deriveBits"]);
  const epk = new Uint8Array(await subtle().exportKey("raw", ephemeral.publicKey));
  const shared = await subtle().deriveBits({ name: "ECDH", public: recipient }, ephemeral.privateKey, 256);
  const wrapKey = await hkdfAesKey(shared, HKDF_INFO.wrap, epk);
  const raw = await subtle().exportKey("raw", itemKey);
  const iv = randomIv();
  const ct = await subtle().encrypt(
    { name: "AES-GCM", iv, additionalData: copyAad(credentialId, recipientId) },
    wrapKey,
    raw,
  );
  return formatEnvelope({ epk, iv, ct });
}

/** Apre la propria copia della chiave d'oggetto; lancia su chiave o AAD sbagliati. */
export async function unwrapItemKey(
  wrapped: string,
  privateKey: CryptoKey,
  credentialId: string,
  recipientId: string,
): Promise<CryptoKey> {
  const { epk, iv, ct } = parseEnvelope(wrapped, ["epk", "iv", "ct"]);
  const ephemeral = await subtle().importKey("raw", epk, ECDH, false, []);
  const shared = await subtle().deriveBits({ name: "ECDH", public: ephemeral }, privateKey, 256);
  const wrapKey = await hkdfAesKey(shared, HKDF_INFO.wrap, epk);
  const raw = await subtle().decrypt(
    { name: "AES-GCM", iv, additionalData: copyAad(credentialId, recipientId) },
    wrapKey,
    ct,
  );
  return importItemKey(bytes(raw));
}

/**
 * Tutto ciò che serve per creare (o sostituire) una password senza poterla
 * leggere: password cifrata più una copia della chiave per ogni
 * destinatario, nello stesso ordine. È l'unica funzione che serve allo
 * script via API.
 */
export async function encryptForInsert(input: {
  credentialId: string;
  password: string;
  recipients: Array<{ recipientId: string; publicKey: string }>;
}): Promise<{ passwordCiphertext: string; copies: Array<{ recipientId: string; wrappedKey: string }> }> {
  const { ciphertext, itemKey } = await encryptPassword(input.credentialId, input.password);
  const copies = await Promise.all(
    input.recipients.map(async ({ recipientId, publicKey }) => ({
      recipientId,
      wrappedKey: await wrapItemKey(itemKey, publicKey, input.credentialId, recipientId),
    })),
  );
  return { passwordCiphertext: ciphertext, copies };
}
