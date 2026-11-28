import type { PasskeyAuthenticationOptions } from "@stubwise/shared";
import { PRF_INPUT } from "@stubwise/vault-crypto";
import { fromBase64Url, toBase64Url } from "./bytes";
import { primitives } from "./primitives";

// La cerimonia della passkey per la cassaforte, l'unica cosa della
// cassaforte che resta nella PAGINA (revisione di sicurezza I-1). Il salt
// PRF è quello LOCALE (`PRF_INPUT`, M-1: il worker rifiuta un server che ne
// chiede un altro).
//
// I-A: la PRF si legge e si consegna PER PRIMA, dentro il callback del
// `then` catturato (niente `await` sulla promessa della piattaforma), in modo
// sincrono: il `getClientExtensionResults` catturato, il riconoscimento
// dell'`ArrayBuffer` col `byteLength` catturato (niente `instanceof`), e
// `stash` la TRASFERISCE al worker. Solo dopo si leggono le altre proprietà
// della credenziale, coi getter catturati, per la risposta che il worker
// manda alla verifica, SENZA i risultati PRF.
//
// I-B: le opzioni di `credentials.get` nascono con prototipo NULL a ogni
// livello (la conversione WebIDL legge anche i membri assenti: `signal`,
// `mediation`, `evalByCredential`…, e la lettura non deve arrivare a un
// getter su `Object.prototype`); e nessuna assegnazione tocca la PRF (un
// [[Set]] troverebbe un setter sulla catena: lo vieta una guardia sul
// sorgente, `ceremony.guard.test.ts`).

export type CeremonyOutcome =
  | { ok: true; credentialId: string; assertion: unknown }
  | { ok: false; code: "passkey_failed" | "passkey_unsupported" };

type Fail = Extract<CeremonyOutcome, { ok: false }>;
const failed: Fail = { ok: false, code: "passkey_failed" };

/** `stash` riceve l'uscita PRF e la deve trasferire SUBITO (la pagina la perde). */
export function ceremony(options: PasskeyAuthenticationOptions, stash: (prf: ArrayBuffer) => void): Promise<CeremonyOutcome> {
  const publicKey = {
    __proto__: null,
    challenge: fromBase64Url(options.challenge),
    ...(options.rpId ? { rpId: options.rpId } : {}),
    ...(options.timeout ? { timeout: options.timeout } : {}),
    ...(options.userVerification ? { userVerification: options.userVerification } : {}),
    allowCredentials: (options.allowCredentials ?? []).map((c) => ({
      __proto__: null,
      type: "public-key" as const,
      id: fromBase64Url(c.id),
      ...(c.transports ? { transports: c.transports as AuthenticatorTransport[] } : {}),
    })),
    extensions: {
      __proto__: null,
      prf: { __proto__: null, eval: { __proto__: null, first: PRF_INPUT } },
    } as AuthenticationExtensionsClientInputs,
  } as unknown as PublicKeyCredentialRequestOptions;
  return primitives.newPromise<CeremonyOutcome>((resolve) => {
    let platform: Promise<Credential | null>;
    try {
      platform = primitives.credentialsGet({ __proto__: null, publicKey } as unknown as CredentialRequestOptions);
    } catch {
      resolve(failed);
      return;
    }
    primitives.then(
      platform,
      (credential) => {
        let out: CeremonyOutcome;
        try {
          out = credential ? onCredential(credential, stash) : failed;
        } catch {
          out = failed;
        }
        resolve(out);
      },
      () => resolve(failed),
    );
  });
}

function onCredential(credential: Credential, stash: (prf: ArrayBuffer) => void): CeremonyOutcome {
  // 1. La PRF, prima di ogni altra proprietà.
  const results = primitives.extensionResults(credential) as { prf?: { results?: { first?: unknown } } };
  const prf = primitives.ownBuffer(results?.prf?.results?.first);
  // Senza PRF al worker (e al server) non va niente: nemmeno la verifica.
  if (!prf) return { ok: false, code: "passkey_unsupported" };
  stash(prf);
  // 2. Il resto, coi getter catturati.
  return assertionOf(credential);
}

/** La risposta per la verifica del server, coi getter catturati e SENZA risultati PRF. */
function assertionOf(credential: Credential): CeremonyOutcome {
  const response = primitives.credential(credential, "response");
  const bytes = (v: unknown) => toBase64Url(v as ArrayBuffer);
  const userHandle = primitives.assertionResponse(response, "userHandle");
  const attachment = primitives.credential(credential, "authenticatorAttachment");
  const id = primitives.credential(credential, "id") as string;
  const assertion = {
    id,
    rawId: bytes(primitives.credential(credential, "rawId")),
    type: primitives.credential(credential, "type"),
    response: {
      authenticatorData: bytes(primitives.assertionResponse(response, "authenticatorData")),
      clientDataJSON: bytes(primitives.assertionResponse(response, "clientDataJSON")),
      signature: bytes(primitives.assertionResponse(response, "signature")),
      ...(userHandle ? { userHandle: bytes(userHandle) } : {}),
    },
    // Il segreto PRF NON va al server.
    clientExtensionResults: {},
    ...(attachment ? { authenticatorAttachment: attachment } : {}),
  };
  return { ok: true, credentialId: id, assertion };
}

/**
 * I-1 (revisione della fase 2): una presenza FRESCA per il recupero col kit.
 * Una passkey qualunque della persona, SENZA l'estensione PRF (chi recupera
 * può non avere una chiave): le opzioni sono quelle della riconferma normale,
 * e la risposta la verifica il worker col server.
 */
export function plainCeremony(options: PasskeyAuthenticationOptions): Promise<CeremonyOutcome> {
  const publicKey = {
    __proto__: null,
    challenge: fromBase64Url(options.challenge),
    ...(options.rpId ? { rpId: options.rpId } : {}),
    ...(options.timeout ? { timeout: options.timeout } : {}),
    ...(options.userVerification ? { userVerification: options.userVerification } : {}),
    allowCredentials: (options.allowCredentials ?? []).map((c) => ({
      __proto__: null,
      type: "public-key" as const,
      id: fromBase64Url(c.id),
      ...(c.transports ? { transports: c.transports as AuthenticatorTransport[] } : {}),
    })),
  } as unknown as PublicKeyCredentialRequestOptions;
  return primitives.newPromise<CeremonyOutcome>((resolve) => {
    let platform: Promise<Credential | null>;
    try {
      platform = primitives.credentialsGet({ __proto__: null, publicKey } as unknown as CredentialRequestOptions);
    } catch {
      resolve(failed);
      return;
    }
    primitives.then(
      platform,
      (credential) => {
        let out: CeremonyOutcome;
        try {
          out = credential ? assertionOf(credential) : failed;
        } catch {
          out = failed;
        }
        resolve(out);
      },
      () => resolve(failed),
    );
  });
}
