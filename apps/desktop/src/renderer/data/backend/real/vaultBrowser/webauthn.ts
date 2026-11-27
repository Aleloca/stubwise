import type { PasskeyAuthenticationOptions } from "@stubwise/shared";
import { PRF_INPUT } from "@stubwise/vault-crypto";
import { fromBase64Url, toBase64Url } from "./bytes";
import { primitives } from "./primitives";

// La cerimonia della passkey per la cassaforte, l'unica cosa della
// cassaforte che resta nella PAGINA (revisione di sicurezza I-1): sul
// `credentials.get` e sul `getClientExtensionResults` catturati al boot. Il
// salt PRF è quello LOCALE (`PRF_INPUT`, M-1: il worker rifiuta un server che
// ne chiede un altro). L'uscita PRF non resta qui: la si consegna al worker
// per transfer (`unlock.ts`), insieme alla risposta SENZA i risultati PRF,
// che il worker manda alla verifica.

export type CeremonyOutcome =
  | { ok: true; credentialId: string; assertion: unknown; prf: ArrayBuffer }
  | { ok: false; code: "passkey_failed" | "passkey_unsupported" };

export async function ceremony(options: PasskeyAuthenticationOptions): Promise<CeremonyOutcome> {
  let credential: PublicKeyCredential | null;
  try {
    credential = (await primitives.credentialsGet({
      publicKey: {
        challenge: fromBase64Url(options.challenge),
        ...(options.rpId ? { rpId: options.rpId } : {}),
        ...(options.timeout ? { timeout: options.timeout } : {}),
        ...(options.userVerification ? { userVerification: options.userVerification } : {}),
        allowCredentials: (options.allowCredentials ?? []).map((c) => ({
          type: "public-key" as const,
          id: fromBase64Url(c.id),
          ...(c.transports ? { transports: c.transports as AuthenticatorTransport[] } : {}),
        })),
        extensions: { prf: { eval: { first: PRF_INPUT } } } as AuthenticationExtensionsClientInputs,
      },
    })) as PublicKeyCredential | null;
  } catch {
    return { ok: false, code: "passkey_failed" };
  }
  if (!credential) return { ok: false, code: "passkey_failed" };
  const first = (primitives.extensionResults(credential) as { prf?: { results?: { first?: BufferSource } } }).prf?.results
    ?.first;
  // Senza PRF al worker (e al server) non va niente: nemmeno la verifica.
  if (!first) return { ok: false, code: "passkey_unsupported" };
  // Un ArrayBuffer si TRASFERISCE così com'è (la pagina lo perde); una vista si copia col `slice` catturato.
  const prf = first instanceof ArrayBuffer ? first : primitives.copyBuffer(first as ArrayBufferView);
  const r = credential.response as AuthenticatorAssertionResponse;
  const assertion = {
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
  return { ok: true, credentialId: credential.id, assertion, prf };
}
