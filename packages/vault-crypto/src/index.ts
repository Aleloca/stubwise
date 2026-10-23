// Nucleo crittografico della cassaforte delle credenziali: lo usano server,
// web e lo script di inserimento via API. Solo WebCrypto
// (`globalThis.crypto.subtle`): ECDH P-256, HKDF-SHA-256, AES-256-GCM.

export {
  PRF_INPUT,
  generatePersonKeyPair,
  keyFingerprint,
  openPrivateKey,
  resealPrivateKey,
  sealPrivateKey,
} from "./keys.js";
export {
  decryptPassword,
  encryptForInsert,
  encryptPassword,
  unwrapItemKey,
  wrapItemKey,
} from "./items.js";
export {
  generateRecoveryKit,
  openRecoveryChallenge,
  parseRecoveryKit,
  wrapRecoveryChallenge,
} from "./recovery.js";
