import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const ALGORITHM = "aes-256-gcm";

/** IV di 12 byte: la dimensione raccomandata per AES-GCM. */
const IV_LENGTH = 12;

/**
 * Cifra `plaintext` con AES-256-GCM e un IV casuale per chiamata.
 * Restituisce `iv.authTag.ciphertext`, ciascun segmento in base64: tutto il
 * necessario per decifrare viaggia nel payload, la chiave resta fuori banda.
 */
export function encrypt(plaintext: string, key: Buffer): string {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return [
    iv.toString("base64"),
    cipher.getAuthTag().toString("base64"),
    ciphertext.toString("base64"),
  ].join(".");
}

/**
 * Decifra un payload prodotto da {@link encrypt}. Lancia se il formato non è
 * `iv.authTag.ciphertext` o se l'auth tag GCM non torna (chiave sbagliata o
 * payload manomesso: GCM autentica, non solo cifra).
 */
export function decrypt(payload: string, key: Buffer): string {
  const [ivB64, authTagB64, ciphertextB64, ...rest] = payload.split(".");
  if (!ivB64 || !authTagB64 || !ciphertextB64 || rest.length > 0) {
    throw new Error("payload cifrato non valido: attesi tre segmenti iv.authTag.ciphertext");
  }
  const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(authTagB64, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertextB64, "base64")),
    decipher.final(),
  ]).toString("utf8");
}
