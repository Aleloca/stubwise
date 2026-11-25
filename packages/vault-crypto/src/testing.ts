// SOLO per i test (review 2, M8): un «Mac di software» al posto del Secure
// Enclave, per provare l'associazione e l'apertura del sigillo senza l'helper
// Swift. Esce da `@stubwise/vault-crypto/testing`, mai dall'API pubblica
// (`index.ts`): la vecchia via con la chiave del Mac nel processo era quella
// senza tocco, e il prodotto non deve poterla usare.
//
// La privata è NON estraibile e resta in memoria; `deriveBits` fa l'ECDH sul
// punto effimero come l'enclave (32 byte, la coordinata x).

import { devicePublicKeyFromRaw } from "./device-seal.js";

export async function softwareDeviceKey(): Promise<{
  publicKey: string;
  privateKey: CryptoKey;
  deriveBits: (ephemeralPublicKey: Uint8Array) => Promise<Uint8Array>;
}> {
  const subtle = globalThis.crypto.subtle;
  const ecdh = { name: "ECDH", namedCurve: "P-256" } as const;
  const pair = await subtle.generateKey(ecdh, false, ["deriveBits"]);
  const raw = new Uint8Array(await subtle.exportKey("raw", pair.publicKey));
  return {
    publicKey: await devicePublicKeyFromRaw(raw),
    privateKey: pair.privateKey,
    deriveBits: async (ephemeralPublicKey) => {
      const eph = await subtle.importKey("raw", new Uint8Array(ephemeralPublicKey), ecdh, false, []);
      return new Uint8Array(await subtle.deriveBits({ name: "ECDH", public: eph }, pair.privateKey, 256));
    },
  };
}
