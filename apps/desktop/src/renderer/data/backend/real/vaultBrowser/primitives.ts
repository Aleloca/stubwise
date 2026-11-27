import { useCrypto } from "@stubwise/vault-crypto";

// Le primitive della cassaforte nel browser, CATTURATE al primo import
// (design §2.4, C2). La build web importa questo modulo per PRIMO
// (`@backend/vault-boot` in `main.tsx`), prima di qualunque altro codice
// dell'app; da lì la cassaforte usa solo queste copie:
// - `crypto.subtle` e `getRandomValues`, iniettate in `@stubwise/vault-crypto`
//   (`useCrypto`, una volta sola);
// - `navigator.credentials.get` e `.create`, per la cerimonia della passkey;
// - `fetch`, per le rotte della cassaforte (`http.ts`).
// Uno script arrivato DOPO che le sostituisse non le cambia più per la
// cassaforte. È un argine, non un muro: chi gira PRIMA vince, ed è per questo
// che vengono prima la CSP e i Trusted Types.

const realCrypto = globalThis.crypto;
const realCredentials = typeof navigator !== "undefined" ? navigator.credentials : undefined;
const realFetch = globalThis.fetch;

const credentialsGet = realCredentials?.get?.bind(realCredentials);
const credentialsCreate = realCredentials?.create?.bind(realCredentials);

try {
  useCrypto({ subtle: realCrypto.subtle, getRandomValues: realCrypto.getRandomValues.bind(realCrypto) });
} catch {
  // Già iniettate (un secondo import dello stesso modulo): restano quelle di prima.
}

export const primitives = Object.freeze({
  fetch: realFetch.bind(globalThis) as typeof fetch,
  /** `navigator.credentials.get` del primo import; senza (un browser senza WebAuthn) rifiuta. */
  credentialsGet: (options: CredentialRequestOptions): Promise<Credential | null> =>
    credentialsGet ? credentialsGet(options) : Promise.reject(new Error("webauthn_unavailable")),
  credentialsCreate: (options: CredentialCreationOptions): Promise<Credential | null> =>
    credentialsCreate ? credentialsCreate(options) : Promise.reject(new Error("webauthn_unavailable")),
});
