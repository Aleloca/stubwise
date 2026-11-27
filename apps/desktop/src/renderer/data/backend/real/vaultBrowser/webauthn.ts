import type { PasskeyAuthenticationOptions } from "@stubwise/shared";
import { vaultHttp } from "./http";
import { primitives } from "./primitives";

// La cerimonia della passkey per la cassaforte (design §2.4, §3): sul
// `navigator.credentials.get` CATTURATO, non su `@simplewebauthn` (che
// leggerebbe il globale al momento della chiamata). È la riconferma con
// `purpose: "vault"`: le opzioni chiedono la PRF, la verifica è quella di
// sempre. Il segreto PRF NON lascia mai la scheda: la risposta va al server
// senza (`clientExtensionResults` vuoto). Senza PRF il server non riceve
// NIENTE, né la verifica.

export type WebauthnFailure = "passkey_failed" | "no_seal";

export class VaultBrowserError extends Error {
  constructor(readonly code: WebauthnFailure | "open_failed") {
    super(code);
  }
}

/** L'esito della passkey: il suo id e il segreto PRF (solo in memoria, lo azzera chi lo usa). */
export interface PrfAssertion {
  credentialId: string;
  prfOutput: ArrayBuffer;
}

export function fromBase64Url(text: string): Uint8Array<ArrayBuffer> {
  const base64 = text.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(base64 + "=".repeat((4 - (base64.length % 4)) % 4));
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

export function toBase64Url(bytes: ArrayBuffer | ArrayBufferView): string {
  const view = bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let binary = "";
  for (const b of view) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Azzera un segreto appena non serve più (best effort: è memoria JS). */
export function wipe(buffer: ArrayBuffer | ArrayBufferView): void {
  if (buffer instanceof ArrayBuffer) new Uint8Array(buffer).fill(0);
  else new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength).fill(0);
}

/**
 * Una cerimonia con la PRF fra le sole passkey che aprono la chiave
 * (`onlyCredentialIds`), poi la verifica sul server. `null` se la passkey (o
 * il browser) non dà la PRF: al server non è arrivato niente.
 */
export async function assertWithPrf(onlyCredentialIds: readonly string[]): Promise<PrfAssertion | null> {
  const options = await vaultHttp<PasskeyAuthenticationOptions>("POST", "/api/me/security/reauth/passkey/options", {
    purpose: "vault",
  });
  const first = options.extensions?.prf?.eval?.first;
  const allow = (options.allowCredentials ?? []).filter((c) => onlyCredentialIds.includes(c.id));
  if (allow.length === 0) throw new VaultBrowserError("no_seal");
  if (typeof first !== "string") return null;
  let credential: PublicKeyCredential | null;
  try {
    credential = (await primitives.credentialsGet({
      publicKey: {
        challenge: fromBase64Url(options.challenge),
        ...(options.rpId ? { rpId: options.rpId } : {}),
        ...(options.timeout ? { timeout: options.timeout } : {}),
        ...(options.userVerification ? { userVerification: options.userVerification } : {}),
        allowCredentials: allow.map((c) => ({
          type: "public-key" as const,
          id: fromBase64Url(c.id),
          ...(c.transports ? { transports: c.transports as AuthenticatorTransport[] } : {}),
        })),
        extensions: { prf: { eval: { first: fromBase64Url(first) } } } as AuthenticationExtensionsClientInputs,
      },
    })) as PublicKeyCredential | null;
  } catch {
    throw new VaultBrowserError("passkey_failed");
  }
  if (!credential) throw new VaultBrowserError("passkey_failed");
  const results = (credential.getClientExtensionResults() as { prf?: { results?: { first?: BufferSource } } }).prf
    ?.results?.first;
  if (!results) return null;
  // Una copia sola resta in memoria; l'originale nella risposta del browser si azzera subito.
  const source =
    results instanceof ArrayBuffer
      ? new Uint8Array(results)
      : new Uint8Array((results as ArrayBufferView).buffer, (results as ArrayBufferView).byteOffset, (results as ArrayBufferView).byteLength);
  const prfOutput = source.slice().buffer;
  source.fill(0);
  const r = credential.response as AuthenticatorAssertionResponse;
  const response = {
    id: credential.id,
    rawId: toBase64Url(credential.rawId),
    type: credential.type,
    response: {
      authenticatorData: toBase64Url(r.authenticatorData),
      clientDataJSON: toBase64Url(r.clientDataJSON),
      signature: toBase64Url(r.signature),
      ...(r.userHandle ? { userHandle: toBase64Url(r.userHandle) } : {}),
    },
    // Il segreto PRF NON va al server.
    clientExtensionResults: {},
    ...(credential.authenticatorAttachment ? { authenticatorAttachment: credential.authenticatorAttachment } : {}),
  };
  try {
    await vaultHttp("POST", "/api/me/security/reauth/passkey/verify", { response });
  } catch (cause) {
    wipe(prfOutput);
    throw cause;
  }
  return { credentialId: credential.id, prfOutput };
}
