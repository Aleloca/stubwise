// Sfida di possesso della chiave di persona: il server cifra per la pubblica
// della chiave CONFERMATA di chi agisce un segreto casuale di 32 byte (stessa
// busta delle copie della chiave, come se fosse una chiave d'oggetto) e ne
// tiene solo l'hash; il browser con la cassaforte aperta lo apre e lo rimanda
// come prova. Senza, un login rubato (anche di un full admin) confermerebbe,
// condividerebbe o ruoterebbe il kit senza avere una chiave della cassaforte.
//
// AAD: `actor-challenge:<id>:<personKeyId>`. Né una copia di credenziale (AAD
// `<uuid credenziale>:<destinatario>`) né una sfida del kit di recupero (AAD
// `recovery-challenge:<id>:recovery`) si aprono come questa sfida, quindi chi
// rimanda il segreto non può farsi aprire altro.

import { toBase64Url } from "./encoding.js";
import { unwrapItemKey, wrapItemKey } from "./items.js";

const CHALLENGE_BYTES = 32;

function challengeAad(challengeId: string): string {
  return `actor-challenge:${challengeId}`;
}

/** Cifra il segreto della sfida `challengeId` per la pubblica della chiave `personKeyId`. */
export async function wrapActorChallenge(
  secret: Uint8Array,
  personPublicKey: string,
  challengeId: string,
  personKeyId: string,
): Promise<string> {
  if (secret.length !== CHALLENGE_BYTES) throw new Error("la sfida vuole un segreto di 32 byte");
  const key = await globalThis.crypto.subtle.importKey(
    "raw",
    new Uint8Array(secret),
    { name: "AES-GCM", length: 256 },
    true,
    ["encrypt", "decrypt"],
  );
  return wrapItemKey(key, personPublicKey, challengeAad(challengeId), personKeyId);
}

/** Apre la sfida con la propria privata: la prova (segreto in base64url). Lancia se non è sua. */
export async function openActorChallenge(
  wrapped: string,
  privateKey: CryptoKey,
  challengeId: string,
  personKeyId: string,
): Promise<string> {
  const key = await unwrapItemKey(wrapped, privateKey, challengeAad(challengeId), personKeyId);
  return toBase64Url(await globalThis.crypto.subtle.exportKey("raw", key));
}
