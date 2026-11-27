// Le primitive WebCrypto della cassaforte (cassaforte nel browser, design
// §2.4, C2). Nella build web la scheda le CATTURA al primo import
// (`vaultBrowser/primitives.ts`) e le inietta qui con `useCrypto`, una volta
// sola: uno script arrivato dopo che sostituisse `crypto.subtle` o
// `getRandomValues` non le cambia più per la cassaforte. È un argine, non un
// muro (chi gira PRIMA vince): per questo vengono prima la CSP e i Trusted
// Types. Senza iniezione (main del desktop, server, web vecchio) vale il
// globale, come prima.

export interface VaultCryptoProvider {
  subtle: SubtleCrypto;
  getRandomValues: Crypto["getRandomValues"];
}

let provider: VaultCryptoProvider | null = null;

/** Inietta le primitive catturate. Una seconda volta lancia `crypto_already_set`. */
export function useCrypto(next: VaultCryptoProvider): void {
  if (provider) throw new Error("crypto_already_set");
  provider = { subtle: next.subtle, getRandomValues: next.getRandomValues };
}

/** `SubtleCrypto` della cassaforte: quella iniettata, o il globale. */
export const subtle = (): SubtleCrypto => provider?.subtle ?? globalThis.crypto.subtle;

/** `getRandomValues` della cassaforte: quella iniettata, o il globale. */
export function getRandomValues<T extends ArrayBufferView>(array: T): T {
  return provider ? provider.getRandomValues(array) : globalThis.crypto.getRandomValues(array);
}
