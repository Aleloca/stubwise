import { startAuthentication } from "@simplewebauthn/browser";
import type { PasskeyAuthenticationOptions, VaultStatusResponse } from "@stubwise/shared";
import {
  generatePersonKeyPair,
  openPrivateKey,
  sealPrivateKey,
} from "@stubwise/vault-crypto";
import {
  getMyVaultKey,
  postReauthPasskeyOptions,
  postReauthPasskeyVerify,
  postVaultKey,
} from "../api";

/**
 * Sblocco della cassaforte nel browser (design
 * `docs/plans/2026-10-23-cassaforte-credenziali-design.md`, «Il modello delle
 * chiavi»), senza React: il `VaultProvider` (`vault-context.tsx`) ne tiene
 * l'esito in memoria.
 *
 * Lo sblocco È una riconferma con passkey (decisione V2 del piano): le
 * opzioni di `/reauth/passkey/options` con `purpose: "vault"` chiedono la
 * PRF, la verifica è quella di sempre. Il segreto PRF che la passkey produce
 * NON lascia mai il browser: si toglie dalla risposta prima di mandarla al
 * server (`withoutPrf`), perché chi lo ha apre la chiave privata.
 */

/** Errori dello sblocco che la web spiega con un messaggio suo (chiavi `vault:errors.*`). */
export type VaultErrorCode =
  /** Annullata, scaduta o rifiutata dal browser: al server non è arrivato niente. */
  | "passkey_failed"
  /** Nessuna delle passkey registrate apre la propria chiave (sigilli spariti con le passkey). */
  | "no_seal"
  /** La passkey usata non è fra quelle della persona (stato vecchio): si riprova. */
  | "passkey_unknown"
  /** Il sigillo non si apre con il segreto di questa passkey. */
  | "open_failed";

export class VaultError extends Error {
  constructor(readonly code: VaultErrorCode) {
    super(code);
    this.name = "VaultError";
  }
}

/** Il risultato di uno sblocco: la chiave privata (non estraibile) e il suo id. */
export interface UnlockedKey {
  privateKey: CryptoKey;
  personKeyId: string;
}

export type UnlockResult = { kind: "unsupported" } | ({ kind: "unlocked" } & UnlockedKey);

/** Una chiave «viva»: si apre col sigillo. Rifiutata (o assente) va creata da capo. */
export function hasLiveKey(status: Pick<VaultStatusResponse, "myKey">): boolean {
  const key = status.myKey;
  return key !== null && (key.status === "pending" || key.status === "confirmed");
}

// --- base64url ↔ byte (la forma JSON di WebAuthn) ---

function fromBase64Url(text: string): Uint8Array<ArrayBuffer> {
  const base64 = text.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
  const binary = atob(padded);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

function copyToArrayBuffer(view: ArrayBufferView): ArrayBuffer {
  const out = new Uint8Array(view.byteLength);
  out.set(new Uint8Array(view.buffer, view.byteOffset, view.byteLength));
  return out.buffer;
}

/**
 * Le opzioni del server pronte per `startAuthentication`: `@simplewebauthn/
 * browser` 13 converte challenge e `allowCredentials` ma passa `extensions`
 * così com'è a `navigator.credentials.get()`, che per la PRF vuole BYTE, non
 * la stringa base64url del JSON. Con `onlyCredentialIds` la scelta si
 * restringe alle passkey che aprono la chiave (le altre farebbero solo
 * fallire lo sblocco dopo il tocco).
 */
export function toVaultRequestOptions(
  options: PasskeyAuthenticationOptions,
  onlyCredentialIds?: readonly string[],
): Record<string, unknown> {
  const first = options.extensions?.prf?.eval?.first;
  const allowCredentials =
    onlyCredentialIds === undefined
      ? options.allowCredentials
      : (options.allowCredentials ?? []).filter((c) => onlyCredentialIds.includes(c.id));
  return {
    ...options,
    allowCredentials,
    extensions:
      typeof first === "string" ? { prf: { eval: { first: fromBase64Url(first) } } } : undefined,
  };
}

/**
 * Il segreto PRF della risposta del browser, o `null` se la passkey (o il
 * browser) non supporta la PRF. Il browser lo dà come `ArrayBuffer`;
 * accettiamo anche una vista o la stringa base64url, nel caso una versione
 * della libreria lo serializzi.
 */
export function prfOutputOf(response: unknown): ArrayBuffer | null {
  const results = (response as { clientExtensionResults?: { prf?: { results?: { first?: unknown } } } })
    ?.clientExtensionResults?.prf?.results;
  const first = results?.first;
  if (first === undefined || first === null) return null;
  if (typeof first === "string") {
    return first === "" ? null : copyToArrayBuffer(fromBase64Url(first));
  }
  if (ArrayBuffer.isView(first)) return first.byteLength > 0 ? copyToArrayBuffer(first) : null;
  // `instanceof ArrayBuffer` fallisce fra realm diversi: basta la forma.
  if (typeof first === "object" && typeof (first as ArrayBuffer).byteLength === "number") {
    const buffer = first as ArrayBuffer;
    return buffer.byteLength > 0 ? buffer.slice(0) : null;
  }
  return null;
}

/** La risposta senza i risultati PRF: il segreto non va MAI al server. */
export function withoutPrf<T>(response: T): T {
  const r = response as { clientExtensionResults?: Record<string, unknown> };
  if (!r || typeof r !== "object" || !r.clientExtensionResults) return response;
  const rest = { ...r.clientExtensionResults };
  delete rest.prf;
  return { ...r, clientExtensionResults: rest } as T;
}

/**
 * Descrizione corta del dispositivo (browser e sistema), mostrata a chi
 * conferma la chiave: «Chrome · macOS». Solo ciò che il browser dichiara;
 * entro il limite del server (200 caratteri).
 */
export function deviceDescription(nav: Pick<Navigator, "userAgent"> & { userAgentData?: { platform?: string } } = navigator): string {
  const ua = nav.userAgent ?? "";
  const browser = /Edg\//.test(ua)
    ? "Edge"
    : /OPR\//.test(ua)
      ? "Opera"
      : /Firefox\//.test(ua)
        ? "Firefox"
        : /Chrome\/|CriOS\//.test(ua)
          ? "Chrome"
          : /Safari\//.test(ua)
            ? "Safari"
            : null;
  const platform = nav.userAgentData?.platform;
  const os =
    platform !== undefined && platform !== ""
      ? platform
      : /iPhone/.test(ua)
        ? "iOS"
        : /iPad/.test(ua)
          ? "iPadOS"
          : /Android/.test(ua)
            ? "Android"
            : /Mac OS X|Macintosh/.test(ua)
              ? "macOS"
              : /Windows/.test(ua)
                ? "Windows"
                : /CrOS/.test(ua)
                  ? "ChromeOS"
                  : /Linux/.test(ua)
                    ? "Linux"
                    : null;
  const text = [browser, os].filter((part) => part !== null).join(" · ");
  return text.slice(0, 200);
}

/** L'esito della passkey: il suo id WebAuthn e il segreto PRF (solo in memoria). */
interface VaultAssertion {
  credentialId: string;
  prfOutput: ArrayBuffer;
}

/**
 * La passkey con la PRF, poi la verifica sul server (che vale come
 * riconferma). `null` se la PRF manca: in quel caso il server non riceve
 * NIENTE, né la verifica né, dopo, una chiave che nessuna passkey saprebbe
 * aprire (Review Focus 5).
 */
async function assertWithPrf(status: VaultStatusResponse): Promise<VaultAssertion | null> {
  // Con una chiave viva solo le passkey che la aprono; senza, tutte.
  const only = hasLiveKey(status) ? (status.seals ?? []).map((s) => s.credentialIdB64url) : undefined;
  if (only !== undefined && only.length === 0) throw new VaultError("no_seal");
  const options = await postReauthPasskeyOptions("vault");
  const requestOptions = toVaultRequestOptions(options, only);
  if (only !== undefined && ((requestOptions.allowCredentials as unknown[] | undefined) ?? []).length === 0) {
    throw new VaultError("no_seal");
  }
  let response: Awaited<ReturnType<typeof startAuthentication>>;
  try {
    response = await startAuthentication({
      optionsJSON: requestOptions as unknown as Parameters<typeof startAuthentication>[0]["optionsJSON"],
    });
  } catch {
    throw new VaultError("passkey_failed");
  }
  const prfOutput = prfOutputOf(response);
  if (!prfOutput) return null;
  await postReauthPasskeyVerify(withoutPrf(response));
  return { credentialId: response.id, prfOutput };
}

/** Apre la chiave viva col sigillo della passkey appena usata. */
async function openLiveKey(assertion: VaultAssertion): Promise<UnlockedKey> {
  const mine = await getMyVaultKey();
  const seal = (mine.seals ?? []).find((s) => s.credentialIdB64url === assertion.credentialId);
  if (!seal) throw new VaultError("no_seal");
  try {
    return {
      privateKey: await openPrivateKey(assertion.prfOutput, seal.sealedPrivateKey),
      personKeyId: mine.id,
    };
  } catch {
    throw new VaultError("open_failed");
  }
}

/**
 * Crea la chiave della persona: la coppia nasce nel browser, la privata si
 * sigilla col segreto PRF della passkey usata e al server va solo così, con
 * la pubblica. La privata in chiaro (pkcs8) non esce da questa funzione:
 * resta la `CryptoKey` non estraibile.
 */
async function createKey(status: VaultStatusResponse, assertion: VaultAssertion): Promise<UnlockedKey> {
  const passkey = (status.passkeys ?? []).find((p) => p.credentialIdB64url === assertion.credentialId);
  if (!passkey) throw new VaultError("passkey_unknown");
  const pair = await generatePersonKeyPair();
  const sealedPrivateKey = await sealPrivateKey(assertion.prfOutput, pair.privateKeyPkcs8);
  pair.privateKeyPkcs8.fill(0);
  const created = await postVaultKey({
    publicKey: pair.publicKey,
    seals: [{ passkeyId: passkey.passkeyId, sealedPrivateKey }],
    device: deviceDescription(),
  });
  return { privateKey: pair.privateKey, personKeyId: created.id };
}

/**
 * Lo sblocco intero: passkey con PRF, verifica, poi la chiave aperta (se
 * c'è) o creata (se manca o è stata rifiutata). `beforeKey` gira dopo la
 * verifica e prima di toccare la chiave: l'attivazione ci mette la `POST
 * /activate`, così una passkey senza PRF ferma tutto PRIMA di attivare e
 * l'admin non resta con una cassaforte attiva e nessuna chiave.
 */
export async function unlockVault(
  status: VaultStatusResponse,
  beforeKey?: () => Promise<void>,
): Promise<UnlockResult> {
  const assertion = await assertWithPrf(status);
  if (!assertion) return { kind: "unsupported" };
  if (beforeKey) await beforeKey();
  const key = hasLiveKey(status) ? await openLiveKey(assertion) : await createKey(status, assertion);
  return { kind: "unlocked", ...key };
}
