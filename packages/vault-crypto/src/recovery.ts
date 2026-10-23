// Kit di recupero: una coppia ECDH P-256 la cui privata si stampa e si
// custodisce fuori da Stubwise. Testo = base32 (RFC 4648, senza padding)
// di `pkcs8 ‖ checksum`, dove il checksum sono i primi 5 byte di
// SHA-256(pkcs8), a gruppi di 5 caratteri separati da trattini. La lettura
// tollera minuscole, spazi e a capo, e rifiuta un checksum sbagliato (la
// decodifica base32 è stretta: ogni carattere cambiato cambia i byte).

import { fromBase32, toBase32 } from "./encoding.js";
import { generateExportableKeyPair, importPrivateKey } from "./keys.js";

const CHECKSUM_BYTES = 5;
const GROUP = 5;

async function checksum(pkcs8: Uint8Array<ArrayBuffer>): Promise<Uint8Array> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", pkcs8);
  return new Uint8Array(digest, 0, CHECKSUM_BYTES);
}

export async function generateRecoveryKit(): Promise<{ publicKey: string; kitText: string }> {
  const { publicKey, privateKeyPkcs8 } = await generateExportableKeyPair();
  const payload = new Uint8Array(privateKeyPkcs8.length + CHECKSUM_BYTES);
  payload.set(privateKeyPkcs8);
  payload.set(await checksum(privateKeyPkcs8), privateKeyPkcs8.length);
  const text = toBase32(payload);
  const groups = text.match(new RegExp(`.{1,${GROUP}}`, "g")) ?? [];
  return { publicKey, kitText: groups.join("-") };
}

/** Ricava la privata (non estraibile) dal testo del kit; lancia se non torna. */
export async function parseRecoveryKit(kitText: string): Promise<CryptoKey> {
  const normalized = kitText.toUpperCase().replace(/[\s-]/g, "");
  const payload = fromBase32(normalized);
  if (payload.length <= CHECKSUM_BYTES) throw new Error("kit di recupero non valido");
  const pkcs8 = payload.slice(0, payload.length - CHECKSUM_BYTES);
  const expected = await checksum(pkcs8);
  const actual = payload.subarray(payload.length - CHECKSUM_BYTES);
  if (!expected.every((b, i) => b === actual[i])) throw new Error("kit di recupero: checksum errato");
  return importPrivateKey(pkcs8);
}
