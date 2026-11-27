// Le primitive WebCrypto della cassaforte. Nella build web la crittografia
// gira solo nel worker della cassaforte (`vaultBrowser/worker.ts`, revisione
// di sicurezza I-1), un reame che gli script della pagina non raggiungono:
// lì il `crypto` globale è quello del worker, e non serve catturarlo. Nel
// main del desktop, nel server e nel web vecchio vale il globale.

/** `SubtleCrypto` della cassaforte: il globale del reame in cui gira. */
export const subtle = (): SubtleCrypto => globalThis.crypto.subtle;

/** `getRandomValues` della cassaforte: il globale del reame in cui gira. */
export function getRandomValues<T extends ArrayBufferView>(array: T): T {
  return globalThis.crypto.getRandomValues(array);
}
