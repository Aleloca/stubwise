import {
  credentialRecipientsSchema,
  credentialSharePreviewSchema,
  vaultActorChallengeResponseSchema,
  vaultConfirmResponseSchema,
  vaultDevicePairingLookupResponseSchema,
  vaultPendingResponseSchema,
  vaultRecoveryChallengeResponseSchema,
  vaultRecoveryKeyPreviewSchema,
  type VaultRecoveryKeyPreview,
  type VaultPendingPerson,
  type CredentialRecipients,
  type CredentialSharePreview,
  type CredentialRevealResponse,
  type PasskeyAuthenticationOptions,
  type VaultCreateKeyResponse,
  type VaultMyKeyResponse,
  type VaultActorProof,
  type VaultStatusResponse,
} from "@stubwise/shared";
import {
  PRF_INPUT,
  decryptPassword,
  encryptForInsert,
  generatePersonKeyPair,
  generateRecoveryKit,
  keyFingerprint,
  openActorChallenge,
  openRecoveryChallenge,
  parseRecoveryKit,
  openPrivateKey,
  resealPrivateKey,
  sealForDevice,
  sealPrivateKey,
  unwrapItemKey,
  wrapItemKey,
} from "@stubwise/vault-crypto";
import { toBase64Url } from "./bytes";

// Il cuore della cassaforte nel browser (revisione di sicurezza I-1): gira
// in un Dedicated Worker (`worker.ts`), un reame che gli script della pagina
// non raggiungono. Qui, e solo qui:
// - la rete della cassaforte (`fetch` del worker, stessa origine e cookie):
//   il JSON delle risposte non si manomette dalla pagina;
// - la verifica della passkey, l'apertura del sigillo con la PRF (che arriva
//   per transfer e si azzera subito), la `CryptoKey` di persona;
// - la scadenza a ora di parete, col `Date` e il timer del worker;
// - la decifratura per Show, la cifratura per crea, cambia e condividi, e
//   la prova di possesso (monouso) per condividere e togliere un lettore.
// La pagina riceve solo esiti e, per Show e Copy, la sola password; per crea
// e cambia manda la password digitata, che qui si cifra e non torna.
// `VaultCore` è puro (rete, orologio e timer iniettati): si prova senza un
// worker vero.

/** 15 minuti senza uso (design §7). */
export const IDLE_MS = 15 * 60_000;

/**
 * m-1 (seconda revisione di sicurezza): una pagina ostile può mandare
 * `touch` e `reveal` al worker da sé. Due tetti che nessun messaggio sposta:
 * una durata ASSOLUTA dallo sblocco, e un numero di reveal per sblocco;
 * oltre, la cassaforte si richiude e vuole di nuovo la passkey.
 */
export const MAX_OPEN_MS = 60 * 60_000;
export const REVEALS_PER_UNLOCK = 30;
/** m-B3 (terza revisione): anche le scritture con la chiave hanno un budget per sblocco. */
export const SHARES_PER_UNLOCK = 10;
export const PASSWORD_CHANGES_PER_UNLOCK = 10;

/** I-1 (revisione della fase 2): il kit di recupero letto vale 10 minuti a ora di parete, poi va riletto. */
export const RECOVERY_MS = 10 * 60_000;

/** Quanto resta valida una PRF ricevuta senza lo sblocco che la consuma. */
export const STASH_MS = 2 * 60_000;

export type LockReason =
  | "user"
  | "idle"
  | "expired"
  | "reveal_limit"
  | "write_limit"
  | "logout"
  | "pagehide"
  | "session"
  | "remote"
  | "reauth";

export type CoreRequest =
  /**
   * Stato e opzioni della passkey. `open` (il default): solo le passkey col
   * sigillo della chiave viva. `create` (fase 2): la propria chiave da
   * creare, con TUTTE le passkey; con una chiave viva solo se `recreate`.
   * `seal` (fase 2): la sola passkey `passkeyId`, ancora senza sigillo, per
   * la seconda cerimonia di `sealFinish`. `activate` (fase 2): la cerimonia
   * PRIMA dell'attivazione, con tutte le passkey, così una senza PRF ferma
   * tutto prima di attivare (la PRF poi la consuma `createKey`).
   */
  | { t: "prepare"; purpose?: "open" | "create" | "seal" | "activate"; recreate?: boolean; passkeyId?: string }
  /**
   * I-A: l'uscita PRF, TRASFERITA appena la cerimonia la dà, prima di ogni
   * altra lettura della pagina. Se ne tiene una sola, per {@link STASH_MS};
   * lo sblocco la consuma, `discard` e la chiusura la azzerano.
   */
  | { t: "stash"; prf: ArrayBuffer }
  | {
      t: "unlock";
      /** La risposta della passkey SENZA i risultati PRF. */
      assertion: unknown;
      credentialId: string;
      personId: string;
      sessionTag: string;
    }
  /**
   * Fase 2 (design §10): la propria chiave, creata QUI. La coppia nasce nel
   * worker, la privata si sigilla con la PRF della passkey appena usata e al
   * server va solo così, con la pubblica; poi la cassaforte è aperta.
   * `recreate`: una chiave NUOVA anche se ce n'è una viva (nessuna passkey la
   * apre più); il server mette la vecchia `superseded`.
   */
  | {
      t: "createKey";
      assertion: unknown;
      credentialId: string;
      personId: string;
      sessionTag: string;
      recreate?: boolean;
    }
  /**
   * Fase 2: il kit di recupero nasce QUI. Alla pagina va il testo, una volta,
   * perché la persona lo stampi o lo salvi; il worker tiene solo la pubblica,
   * che è quella che `activate` (o la rotazione) manda al server: la pagina
   * non ne sceglie un'altra. `forgetKit` lo butta.
   */
  /**
   * Fase 2: una passkey già registrata apre anche la cassaforte. Due
   * cerimonie: `sealBegin` con una passkey che APRE già la chiave (la sua PRF
   * resta qui, per {@link STASH_MS}), poi `sealFinish` con la passkey nuova,
   * l'unica offerta. La privata si risigilla qui (la pkcs8 non esce da
   * `@stubwise/vault-crypto`) e le due PRF si azzerano comunque vada.
   */
  | { t: "sealBegin"; assertion: unknown; credentialId: string; personId: string; passkeyId: string }
  | { t: "sealFinish"; assertion: unknown; credentialId: string }
  | { t: "kit"; purpose: "activate" | "rotate" }
  | { t: "forgetKit" }
  /** Attiva la cassaforte dell'istanza con la pubblica del kit generato qui (full admin, riconferma). */
  | { t: "activate" }
  /**
   * Fase 2: il kit nuovo sostituisce il vecchio (full admin, cassaforte
   * aperta). Ogni chiave d'oggetto si apre con la propria copia e si ricifra
   * per la pubblica del kit generato qui; al server con la prova.
   */
  | { t: "rotateKit"; personId: string; sessionTag: string }
  /**
   * Fase 2, il recupero col kit (full admin, riconferma): il testo incollato
   * arriva QUI, se ne ricava la privata (non estraibile) e al server va solo
   * la prova di una sfida aperta col kit. Alla pagina chi aspetta, senza le
   * copie. Il kit resta qui fino a `recoveryForget` (o all'uscita); confermare
   * apre la copia di recupero di ogni credenziale e la ricifra per la persona.
   */
  | { t: "recoveryLoad"; kitText: string; personId: string; sessionTag: string }
  /**
   * I-1: ogni conferma col kit vuole una presenza FRESCA, che il worker
   * verifica col server prima della conferma: una passkey qualunque (senza
   * PRF né sigillo: chi recupera può non avere una chiave) o, senza passkey,
   * il codice dell'app, che qui si inoltra a `POST /reauth` e basta (non si
   * logga, non si tiene).
   */
  | { t: "recoveryConfirm"; personKeyId: string; personId: string; sessionTag: string; presence?: FreshPresence }
  /** Le opzioni della presenza fresca: una cerimonia senza PRF; `no_passkeys` se la persona non ne ha. */
  | { t: "presenceOptions" }
  /**
   * I-2: la riconferma della pagina a sé della cassaforte (attivare, il
   * recupero), senza il dialogo dell'app: la presenza fresca, verificata qui.
   */
  | { t: "reauth"; presence: FreshPresence }
  | { t: "recoveryForget" }
  /**
   * Fase 2, l'associazione del Mac (`/vault-pair`, solo nella build web): il
   * worker legge l'associazione per `state` e ne calcola l'impronta, che alla
   * pagina NON va (M3: si legge sul Mac e si scrive). `pairSeal` vuole gli
   * ultimi 4 caratteri scritti, una passkey che apre la chiave (il tocco, con
   * la PRF nello `stash`) e sigilla la privata per il Mac, con la prova.
   */
  | { t: "pairLookup"; state: string }
  | { t: "pairSeal"; state: string; typed: string; assertion: unknown; credentialId: string; personId: string }
  | { t: "reveal"; id: string; action: "show" | "copy"; personId: string; sessionTag: string }
  /**
   * Una credenziale nuova: non vuole la cassaforte aperta (si cifra con le
   * PUBBLICHE dei destinatari). L'id lo genera il worker; i campi in chiaro
   * non possono sovrascrivere id e cifrato.
   */
  | { t: "create"; projectId: string; fields: Record<string, unknown>; password: string }
  /** La password nuova: con la cassaforte aperta e la sessione dell'apertura. */
  | { t: "setPassword"; id: string; password: string; personId: string; sessionTag: string }
  /** A una persona o a un ruolo: la chiave della voce ricifrata per chi entra, con la prova. */
  | { t: "share"; id: string; target: { userId: string } | { roleId: string }; personId: string; sessionTag: string }
  | { t: "removeReader"; id: string; readerId: string; personId: string; sessionTag: string; presence?: Presence }
  /** Chi aspetta che io confermi: una lettura, senza la chiave; alla pagina senza le copie. */
  | { t: "pending" }
  /** Conferma una chiave di persona: le proprie copie ricifrate per lei, con la prova. */
  | { t: "confirm"; keyId: string; personId: string; sessionTag: string; presence?: Presence }
  | { t: "reject"; keyId: string; personId: string; sessionTag: string; presence?: Presence }
  /** La PRF ricevuta non serve più (M-3, sessione cambiata): si azzera. */
  | { t: "discard" }
  | { t: "touch" }
  | { t: "lock"; reason: LockReason }
  | { t: "status" }
  | { t: "serverStatus" };

/**
 * Una presenza fresca (revisione finale, punto 3, come M5 del desktop):
 * conferma, rifiuto e rimozione di un lettore vogliono una NUOVA asserzione
 * della passkey, non solo la cassaforte aperta. La pagina rifà la cerimonia
 * (la PRF nello `stash`), e qui la si verifica col server, si apre un sigillo
 * della propria chiave con quella PRF e la si azzera: vale per
 * quell'operazione sola.
 */
export type Presence = { assertion: unknown; credentialId: string };

/** I 401 delle rotte del secondo fattore che dicono «riprova», non «sessione finita». */
const SECOND_FACTOR_REJECTIONS: ReadonlySet<string> = new Set(["invalid_second_factor", "invalid_passkey"]);

/** Lo scopo di una cerimonia, come `prepare` l'ha preparata (m-3). */
type PreparePurpose = "open" | "create" | "seal" | "activate";

/**
 * m-2: l'asserzione è davvero della passkey dichiarata (id e rawId), prima
 * di ogni verifica: il sigillo, la chiave e la PRF scelti dal `credentialId`
 * non possono essere di un'altra passkey da quella che ha firmato.
 */
function sameCredential(assertion: unknown, credentialId: string): boolean {
  const a = assertion as { id?: unknown; rawId?: unknown } | null;
  return typeof a === "object" && a !== null && a.id === credentialId && a.rawId === credentialId;
}

/** Una presenza fresca per il recupero (I-1): un'asserzione di passkey, o il codice dell'app. */
export type FreshPresence = { kind: "passkey"; assertion: unknown } | { kind: "code"; code: string };

export type CoreEvent =
  | { t: "state"; state: "open"; closesAt: number }
  | { t: "state"; state: "locked"; reason: LockReason; code?: string };

export interface CoreDeps {
  fetch: (path: string, init: RequestInit) => Promise<Response>;
  now: () => number;
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (timer: unknown) => void;
  emit: (event: CoreEvent) => void;
  /** Browser e sistema, per `device` della chiave nuova (lo vede chi la conferma). */
  device?: () => string;
}

/** Browser e sistema dal `navigator` del worker, in breve. */
function deviceOf(): string {
  const ua = typeof navigator === "undefined" ? "" : navigator.userAgent;
  const browser = /Edg\//.test(ua) ? "Edge" : /Firefox\//.test(ua) ? "Firefox" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : "Browser";
  const os = /Mac OS X/.test(ua) ? "macOS" : /Windows/.test(ua) ? "Windows" : /Android/.test(ua) ? "Android" : /iPhone|iPad/.test(ua) ? "iOS" : /Linux/.test(ua) ? "Linux" : "";
  return os ? `${browser} on ${os}` : browser;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly retryAfterSeconds?: number,
    /** Il corpo dell'errore (il 409 `recipients_changed` porta l'insieme attuale). */
    readonly body?: unknown,
  ) {
    super(code);
  }
}

const hasLiveKey = (s: VaultStatusResponse) =>
  s.myKey !== null && (s.myKey.status === "pending" || s.myKey.status === "confirmed");

const wipe = (buffer: ArrayBuffer) => new Uint8Array(buffer).fill(0);

const seg = (id: string) => encodeURIComponent(id);

/** Il corpo di un 409 `recipients_changed`, se c'è, letto con lo schema (`key` = dove sta). */
function changed<T>(error: unknown, key: string, schema: { safeParse: (v: unknown) => { success: boolean; data?: T } }): T | null {
  if (!(error instanceof HttpError) || error.status !== 409 || error.code !== "recipients_changed") return null;
  const out = schema.safeParse((error.body as Record<string, unknown> | null)?.[key]);
  return out.success ? (out.data as T) : null;
}

/** Chi aspetta, per la pagina: senza le copie, con l'impronta calcolata qui. */
function summarize(people: VaultPendingPerson[]) {
  return Promise.all(
    people.map(async (p) => ({
      userId: p.user.id,
      email: p.user.email,
      personKeyId: p.personKey.id,
      status: p.personKey.status,
      createdAt: p.personKey.createdAt,
      device: p.personKey.device,
      fingerprint: await keyFingerprint(p.personKey.fingerprintSource),
      credentials: p.credentials.map((c) => ({ id: c.id, projectId: c.projectId, service: c.service, label: c.label })),
    })),
  );
}

/** L'esito di una conferma in conteggi. */
function counts(response: unknown) {
  const result = vaultConfirmResponseSchema.safeParse(response);
  if (!result.success) throw new HttpError(0, "invalid_response");
  return {
    ok: true as const,
    saved: result.data.saved.length,
    keyChanged: result.data.skipped.filter((s) => s.reason === "key_changed").length,
    notAllowed: result.data.skipped.filter((s) => s.reason === "not_allowed").length,
  };
}

export class VaultCore {
  private key: {
    privateKey: CryptoKey;
    /** L'id della propria chiave di persona (le copie e le prove sono legate a lui). */
    personKeyId: string;
    personId: string;
    sessionTag: string;
    /** Il `sessionTag` del SERVER all'apertura (I-3); `null` da un server di prima. */
    serverTag: string | null;
    lastUseAt: number;
    /** Lo sblocco: la durata assoluta parte da qui (m-1). */
    openedAt: number;
    /** I reveal chiesti da questo sblocco (m-1). */
    reveals: number;
    /** Condivisioni e cambi password chiesti da questo sblocco (m-B3). */
    shares: number;
    passwordChanges: number;
  } | null = null;
  private timer: unknown = null;
  private stashed: { prf: ArrayBuffer; at: number; purpose: PreparePurpose } | null = null;
  /** m-3: lo scopo dell'ultimo `prepare` riuscito; la PRF che arriva dopo lo porta con sé. */
  private prepared: PreparePurpose = "open";
  /** Il kit generato qui: solo la pubblica (il testo è andato alla pagina). */
  private kit: { publicKey: string; purpose: "activate" | "rotate" } | null = null;
  /** Il kit del recupero, letto: la privata, chi aspetta (con le copie), e una prova non ancora consumata. */
  private recovery: {
    key: CryptoKey;
    people: VaultPendingPerson[];
    proof: { challengeId: string; proof: string } | null;
    /** I-1: chi l'ha caricato, in quale sessione (della pagina e del server), e quando. */
    personId: string;
    sessionTag: string;
    serverTag: string | null;
    loadedAt: number;
  } | null = null;
  /** L'associazione letta: la pubblica del Mac e gli ultimi 4 della sua impronta, mai alla pagina. */
  private pairing: { state: string; deviceId: string; devicePublicKey: string; last4: string } | null = null;
  /** La prima metà di `sealBegin`: la PRF che apre la chiave, e per quale passkey nuova. */
  private sealing: {
    prf: ArrayBuffer;
    sealed: string;
    publicKey: string;
    personKeyId: string;
    passkeyId: string;
    credentialId: string;
    at: number;
  } | null = null;

  constructor(private readonly deps: CoreDeps) {}

  private async http<T>(method: "GET" | "POST" | "PUT" | "DELETE", path: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await this.deps.fetch(path, {
        method,
        credentials: "same-origin",
        headers: body === undefined ? {} : { "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch {
      throw new HttpError(0, "network");
    }
    if (!res.ok) {
      const data = (await res.json().catch(() => null)) as { code?: unknown } | null;
      const code = typeof data?.code === "string" ? data.code : `http_${res.status}`;
      const retry = Number(res.headers.get("retry-after"));
      // I-2: la sessione è finita; M-5: la finestra del server è più stretta della nostra.
      // m-1 (seconda revisione della fase 2): un 401 del SECONDO FATTORE (un
      // codice o una passkey sbagliati) non è la fine della sessione, e non chiude.
      if (res.status === 401 && !SECOND_FACTOR_REJECTIONS.has(code)) this.lock("session");
      // `vault_unlock_required` (54, 18d8097cb): una rotta `reauth: "vault"` vuole uno sblocco recente.
      else if (code === "reauth_required" || code === "vault_unlock_required") this.lock("reauth", code);
      throw new HttpError(res.status, code, Number.isFinite(retry) && retry > 0 ? retry : undefined, data);
    }
    return res.status === 204 ? (null as T) : ((await res.json()) as T);
  }

  private closesAt(): number {
    return Math.min(this.key!.lastUseAt + IDLE_MS, this.key!.openedAt + MAX_OPEN_MS);
  }

  private arm(): void {
    if (this.timer !== null) this.deps.clearTimer(this.timer);
    this.timer = null;
    if (!this.key) return;
    this.timer = this.deps.setTimer(() => this.expireIfDue(), Math.max(0, this.closesAt() - this.deps.now()) + 1);
  }

  private expireIfDue(): boolean {
    if (this.key && this.deps.now() - this.key.openedAt > MAX_OPEN_MS) {
      this.lock("expired");
      return true;
    }
    if (this.key && this.deps.now() - this.key.lastUseAt > IDLE_MS) {
      this.lock("idle");
      return true;
    }
    if (this.key) this.arm();
    return false;
  }

  /** Azzera la PRF ricevuta, se c'è. */
  private dropStash(): void {
    if (this.stashed) wipe(this.stashed.prf);
    this.stashed = null;
  }

  private dropSealing(): void {
    if (this.sealing) wipe(this.sealing.prf);
    this.sealing = null;
  }

  /** Fase 2, prima cerimonia: verifica, e la PRF che apre la chiave resta per la seconda. */
  private async sealBegin(req: Extract<CoreRequest, { t: "sealBegin" }>, prf: ArrayBuffer) {
    if (!sameCredential(req.assertion, req.credentialId)) return { ok: false as const, code: "credential_mismatch" };
    const status = await this.http<VaultStatusResponse>("GET", "/api/vault/status");
    if (!hasLiveKey(status)) return { ok: false as const, code: "no_key" };
    const target = (status.passkeys ?? []).find((p) => p.passkeyId === req.passkeyId);
    if (!target) return { ok: false as const, code: "passkey_unknown" };
    if (status.seals.some((p) => p.passkeyId === req.passkeyId)) return { ok: false as const, code: "already_sealed" };
    await this.http("POST", "/api/me/security/reauth/passkey/verify", { response: req.assertion });
    const server = await this.whoOnServer();
    if (server.userId !== req.personId) return { ok: false as const, code: "session" };
    const mine = await this.http<VaultMyKeyResponse>("GET", "/api/vault/keys/mine");
    const seal = mine.seals.find((x) => x.credentialIdB64url === req.credentialId);
    if (!seal) return { ok: false as const, code: "no_seal" };
    try {
      await openPrivateKey(prf, seal.sealedPrivateKey, mine.publicKey);
    } catch {
      return { ok: false as const, code: "open_failed" };
    }
    // Una copia: la PRF ricevuta la azzera il chiamante.
    this.sealing = {
      prf: prf.slice(0),
      sealed: seal.sealedPrivateKey,
      publicKey: mine.publicKey,
      personKeyId: mine.id,
      passkeyId: target.passkeyId,
      credentialId: target.credentialIdB64url,
      at: this.deps.now(),
    };
    return { ok: true as const };
  }

  /** Fase 2, seconda cerimonia: la passkey nuova firma, e il sigillo nuovo va al server. */
  private async sealFinish(req: Extract<CoreRequest, { t: "sealFinish" }>, prfNew: ArrayBuffer) {
    const s = this.sealing;
    this.sealing = null;
    if (!s) return { ok: false as const, code: "no_seal_pending" };
    try {
      if (this.deps.now() - s.at > STASH_MS) return { ok: false as const, code: "no_seal_pending" };
      if (req.credentialId !== s.credentialId) return { ok: false as const, code: "passkey_unknown" };
      if (!sameCredential(req.assertion, s.credentialId)) return { ok: false as const, code: "credential_mismatch" };
      await this.http("POST", "/api/me/security/reauth/passkey/verify", { response: req.assertion });
      let sealedPrivateKey: string;
      try {
        sealedPrivateKey = await resealPrivateKey(s.prf, s.sealed, prfNew, s.publicKey);
      } catch {
        return { ok: false as const, code: "open_failed" };
      }
      await this.http("POST", `/api/vault/keys/${seg(s.personKeyId)}/seals`, { passkeyId: s.passkeyId, sealedPrivateKey });
      return { ok: true as const };
    } finally {
      wipe(s.prf);
    }
  }

  /** La PRF ricevuta, consumata; `null` se manca, è scaduta o è di un'altra cerimonia (m-3; e si azzera). */
  private takeStash(...purposes: PreparePurpose[]): ArrayBuffer | null {
    const s = this.stashed;
    this.stashed = null;
    if (!s) return null;
    if (this.deps.now() - s.at > STASH_MS || !purposes.includes(s.purpose)) {
      wipe(s.prf);
      return null;
    }
    return s.prf;
  }

  lock(reason: LockReason, code?: string): void {
    this.dropStash();
    this.dropSealing();
    // I-1: il kit del recupero lo butta OGNI chiusura, per qualunque motivo.
    this.recovery = null;
    // m-1: la fine della sessione butta anche un kit generato e un'associazione letta.
    if (reason === "session" || reason === "logout" || reason === "remote" || reason === "pagehide") {
      this.kit = null;
      this.pairing = null;
    }
    const was = this.key;
    this.key = null;
    if (this.timer !== null) this.deps.clearTimer(this.timer);
    this.timer = null;
    if (was) this.deps.emit({ t: "state", state: "locked", reason, ...(code ? { code } : {}) });
    // m-3: anche il server azzera lo sblocco di questa sessione, best-effort
    // (col `fetch` nudo: un errore qui non richiude né rilancia). Non quando
    // il cookie non è più quello dell'apertura (`session`), quando ha chiuso
    // un'altra scheda (`remote`: lo ha già fatto lei, o c'è un login nuovo)
    // o all'uscita (`logout`: la sessione sparisce comunque).
    if (was && reason !== "session" && reason !== "remote" && reason !== "logout") {
      void this.deps
        .fetch("/api/vault/lock", {
          method: "POST",
          credentials: "same-origin",
          headers: { "content-type": "application/json" },
          body: "{}",
        })
        .catch(() => undefined);
    }
  }

  /** La cassaforte aperta con questa chiave (sblocco o chiave appena creata). */
  private open(privateKey: CryptoKey, personKeyId: string, personId: string, sessionTag: string, serverTag: string | null): void {
    this.key = {
      privateKey,
      personKeyId,
      personId,
      sessionTag,
      serverTag,
      lastUseAt: this.deps.now(),
      openedAt: this.deps.now(),
      reveals: 0,
      shares: 0,
      passwordChanges: 0,
    };
    this.arm();
    this.deps.emit({ t: "state", state: "open", closesAt: this.closesAt() });
  }

  /**
   * Fase 2: crea la propria chiave. La pkcs8 in chiaro non esce da qui e si
   * azzera appena sigillata; resta la `CryptoKey` non estraibile.
   */
  private async createKey(req: Extract<CoreRequest, { t: "createKey" }>, prf: ArrayBuffer) {
    if (!sameCredential(req.assertion, req.credentialId)) return { ok: false as const, code: "credential_mismatch" };
    const status = await this.http<VaultStatusResponse>("GET", "/api/vault/status");
    if (!status.activated) return { ok: false as const, code: "inactive" };
    // m-4: una chiave viva si ricrea SOLO se nessuna passkey la apre più.
    if (hasLiveKey(status) && (!req.recreate || status.seals.length > 0)) return { ok: false as const, code: "has_key" };
    const passkey = (status.passkeys ?? []).find((p) => p.credentialIdB64url === req.credentialId);
    if (!passkey) return { ok: false as const, code: "passkey_unknown" };
    await this.http("POST", "/api/me/security/reauth/passkey/verify", { response: req.assertion });
    const server = await this.whoOnServer();
    if (server.userId !== req.personId) return { ok: false as const, code: "session" };
    const pair = await generatePersonKeyPair();
    let sealedPrivateKey: string;
    try {
      sealedPrivateKey = await sealPrivateKey(prf, pair.privateKeyPkcs8, pair.publicKey);
    } finally {
      pair.privateKeyPkcs8.fill(0);
    }
    const created = await this.http<VaultCreateKeyResponse>("POST", "/api/vault/keys", {
      publicKey: pair.publicKey,
      seals: [{ passkeyId: passkey.passkeyId, sealedPrivateKey }],
      device: (this.deps.device ?? deviceOf)().slice(0, 200),
    });
    this.open(pair.privateKey, created.id, req.personId, req.sessionTag, server.serverTag);
    return { ok: true as const, status: created.status };
  }

  /** La chiave per un uso, o `null` (e chiusa) se scaduta o di un'altra persona o sessione. */
  private use(personId: string, sessionTag: string): CryptoKey | null {
    if (!this.key) return null;
    if (this.key.personId !== personId || this.key.sessionTag !== sessionTag) {
      this.lock("session");
      return null;
    }
    if (this.expireIfDue()) return null;
    this.key.lastUseAt = this.deps.now();
    this.arm();
    return this.key.privateKey;
  }

  /**
   * I-3: chi guarda e la sessione del cookie, letti dal worker col SUO
   * fetch (la pagina non li può falsare). `serverTag` è `null` da un server
   * di prima del `sessionTag`.
   */
  private async whoOnServer(): Promise<{ userId: string; serverTag: string | null }> {
    const me = await this.http<{ user: { id: string }; sessionTag?: string | null }>("GET", "/api/auth/me");
    return { userId: me.user.id, serverTag: typeof me.sessionTag === "string" ? me.sessionTag : null };
  }

  /**
   * La chiave per un'azione, con la sessione del cookie ancora quella
   * dell'apertura (I-3: un logout e un login in un'altra scheda la
   * cambiano); altrimenti chiude e `null`.
   */
  private async live(personId: string, sessionTag: string): Promise<{ privateKey: CryptoKey; personKeyId: string } | null> {
    if (!this.use(personId, sessionTag)) return null;
    const server = await this.whoOnServer();
    if (!this.key) return null;
    if (server.userId !== this.key.personId || server.serverTag !== this.key.serverTag) {
      this.lock("session");
      return null;
    }
    return { privateKey: this.key.privateKey, personKeyId: this.key.personKeyId };
  }

  /**
   * Cifra e scrive (crea o cambia), come il main del desktop: per
   * ESATTAMENTE i destinatari dati, le persone e il recupero. Se nel
   * frattempo l'insieme è cambiato, il server risponde 409
   * `recipients_changed` coi destinatari ATTUALI: si ricifra e si riprova
   * UNA volta (`resaved`).
   */
  private async writeEncrypted(input: {
    credentialId: string;
    password: string;
    recipientsPath: string;
    write: (enc: { passwordCiphertext: string; copies: { recipientId: string; wrappedKey: string }[]; recoveryPublicKey: string }) => Promise<unknown>;
  }): Promise<{ resaved: boolean }> {
    const encrypt = async (r: CredentialRecipients) => {
      const { passwordCiphertext, copies } = await encryptForInsert({
        credentialId: input.credentialId,
        password: input.password,
        recipients: [
          ...r.people.map((p) => ({ recipientId: p.personKeyId, publicKey: p.publicKey })),
          { recipientId: "recovery", publicKey: r.recoveryPublicKey },
        ],
      });
      return { passwordCiphertext, copies, recoveryPublicKey: r.recoveryPublicKey };
    };
    const first = credentialRecipientsSchema.safeParse(await this.http("GET", input.recipientsPath));
    if (!first.success) throw new HttpError(0, "invalid_response");
    try {
      await input.write(await encrypt(first.data));
      return { resaved: false };
    } catch (error) {
      const current = changed<CredentialRecipients>(error, "recipients", credentialRecipientsSchema);
      if (!current) throw error;
      await input.write(await encrypt(current));
      return { resaved: true };
    }
  }

  /**
   * m-B3: una scrittura col budget dello sblocco. Oltre il tetto chiude
   * (`write_limit`) e la scrittura non parte: serve di nuovo la passkey.
   */
  private spend(kind: "shares" | "passwordChanges", cap: number): boolean {
    if (!this.key) return false;
    if (this.key[kind] >= cap) {
      this.lock("write_limit");
      return false;
    }
    this.key[kind] += 1;
    return true;
  }

  /** La presenza fresca: `null` se regge, altrimenti l'esito da restituire. La PRF si consuma sempre. */
  private async present(presence: Presence): Promise<{ ok: false; code: string } | null> {
    const prf = this.takeStash("open");
    if (!prf) return { ok: false, code: "no_prf" };
    try {
      if (!sameCredential(presence.assertion, presence.credentialId)) return { ok: false, code: "credential_mismatch" };
      await this.http("POST", "/api/me/security/reauth/passkey/verify", { response: presence.assertion });
      const mine = await this.http<VaultMyKeyResponse>("GET", "/api/vault/keys/mine");
      if (!this.key || mine.id !== this.key.personKeyId) return { ok: false, code: "stale_key" };
      const seal = mine.seals.find((s) => s.credentialIdB64url === presence.credentialId);
      if (!seal) return { ok: false, code: "no_seal" };
      try {
        await openPrivateKey(prf, seal.sealedPrivateKey, mine.publicKey);
      } catch {
        return { ok: false, code: "open_failed" };
      }
      return null;
    } finally {
      wipe(prf);
    }
  }

  /** La prova della propria chiave: una per azione (il server la consuma). */
  private async prove(privateKey: CryptoKey, personKeyId: string): Promise<VaultActorProof> {
    const challenge = vaultActorChallengeResponseSchema.safeParse(await this.http("POST", "/api/vault/actor-challenge", {}));
    if (!challenge.success) throw new HttpError(0, "invalid_response");
    if (challenge.data.personKeyId !== personKeyId) throw new HttpError(0, "stale_key");
    return {
      challengeId: challenge.data.challengeId,
      proof: await openActorChallenge(challenge.data.wrapped, privateKey, challenge.data.challengeId, personKeyId),
    };
  }

  /**
   * Condivide come il main del desktop: dall'anteprima, la propria copia
   * della chiave della voce si ricifra per ogni persona che entra; con una
   * prova nuova a ogni tentativo. Persone o password cambiate nel frattempo
   * (409 `recipients_changed`): si rifà sull'anteprima attuale, UNA volta.
   */
  private async share(
    id: string,
    target: { userId: string } | { roleId: string },
    k: { privateKey: CryptoKey; personKeyId: string },
  ): Promise<{ ok: true; waiting: string[] }> {
    // Il bersaglio esce solo come uno dei due campi: niente altro dalla pagina.
    const who: { userId: string } | { roleId: string } =
      "userId" in target ? { userId: String(target.userId) } : { roleId: String(target.roleId) };
    const query = "userId" in who ? `userId=${seg(who.userId)}` : `roleId=${seg(who.roleId)}`;
    const attempt = async (preview: CredentialSharePreview) => {
      const itemKey = await unwrapItemKey(preview.wrappedKey, k.privateKey, id, k.personKeyId);
      const copies = await Promise.all(
        preview.people.map(async (p) => ({
          recipientId: p.personKeyId,
          wrappedKey: await wrapItemKey(itemKey, p.publicKey, id, p.personKeyId),
        })),
      );
      await this.http("POST", `/api/credentials/${seg(id)}/readers`, {
        ...who,
        copies,
        keyVersion: preview.keyVersion,
        actorProof: await this.prove(k.privateKey, k.personKeyId),
      });
      return { ok: true as const, waiting: preview.waiting.map((w) => w.email) };
    };
    const first = credentialSharePreviewSchema.safeParse(
      await this.http("GET", `/api/credentials/${seg(id)}/readers/preview?${query}`),
    );
    if (!first.success) throw new HttpError(0, "invalid_response");
    try {
      return await attempt(first.data);
    } catch (error) {
      const current = changed<CredentialSharePreview>(error, "preview", credentialSharePreviewSchema);
      if (!current) throw error;
      return attempt(current);
    }
  }

  /** Fase 2: la propria chiave sigillata per il Mac dell'associazione letta. */
  private async pairSeal(req: Extract<CoreRequest, { t: "pairSeal" }>, prf: ArrayBuffer) {
    if (!sameCredential(req.assertion, req.credentialId)) return { ok: false as const, code: "credential_mismatch" };
    const p = this.pairing;
    if (!p || p.state !== req.state) return { ok: false as const, code: "no_pairing" };
    if (String(req.typed).replace(/\s/g, "").toLowerCase() !== p.last4) return { ok: false as const, code: "fingerprint_mismatch" };
    await this.http("POST", "/api/me/security/reauth/passkey/verify", { response: req.assertion });
    const server = await this.whoOnServer();
    if (server.userId !== req.personId) return { ok: false as const, code: "session" };
    const mine = await this.http<VaultMyKeyResponse>("GET", "/api/vault/keys/mine");
    const seal = mine.seals.find((x) => x.credentialIdB64url === req.credentialId);
    if (!seal) return { ok: false as const, code: "no_seal" };
    let privateKey: CryptoKey;
    let deviceSeal: string;
    try {
      privateKey = await openPrivateKey(prf, seal.sealedPrivateKey, mine.publicKey);
      deviceSeal = await sealForDevice({
        prfOutput: prf,
        sealed: seal.sealedPrivateKey,
        personPublicKey: mine.publicKey,
        personKeyId: mine.id,
        devicePublicKey: p.devicePublicKey,
        deviceId: p.deviceId,
      });
    } catch {
      return { ok: false as const, code: "open_failed" };
    }
    await this.http("POST", "/api/vault/device-seals", {
      pairingState: p.state,
      deviceId: p.deviceId,
      seal: deviceSeal,
      actorProof: await this.prove(privateKey, mine.id),
    });
    this.pairing = null;
    return { ok: true as const };
  }

  /** L'anteprima della rotazione, letta con lo schema. */
  private async rotationPreview(): Promise<VaultRecoveryKeyPreview> {
    const out = vaultRecoveryKeyPreviewSchema.safeParse(await this.http("GET", "/api/vault/recovery-key/preview"));
    if (!out.success) throw new HttpError(0, "invalid_response");
    return out.data;
  }

  /**
   * Ricifra per la pubblica nuova ogni chiave d'oggetto, dall'anteprima
   * FRESCA; una credenziale nata o tolta nel frattempo (409
   * `recipients_changed`) rilegge e riprova UNA volta.
   */
  private async rotate(publicKey: string, k: { privateKey: CryptoKey; personKeyId: string }) {
    const attempt = async () => {
      const preview = await this.rotationPreview();
      if (preview.missing.length > 0) return { ok: false as const, code: "missing", missing: preview.missing };
      if (preview.personKeyId !== k.personKeyId) return { ok: false as const, code: "stale_key" };
      const copies: { credentialId: string; wrappedKey: string }[] = [];
      for (const c of preview.credentials) {
        let itemKey: CryptoKey;
        try {
          itemKey = await unwrapItemKey(c.wrappedKey, k.privateKey, c.id, k.personKeyId);
        } catch {
          return { ok: false as const, code: "open_failed" };
        }
        copies.push({ credentialId: c.id, wrappedKey: await wrapItemKey(itemKey, publicKey, c.id, "recovery") });
      }
      await this.http("POST", "/api/vault/recovery-key", {
        recoveryPublicKey: publicKey,
        copies,
        actorProof: await this.prove(k.privateKey, k.personKeyId),
      });
      return { ok: true as const };
    };
    try {
      return await attempt();
    } catch (error) {
      if (!(error instanceof HttpError && error.status === 409 && error.code === "recipients_changed")) throw error;
      return attempt();
    }
  }

  /** La lista fresca di chi aspetta, letta con lo schema. */
  private async pendingPeople(): Promise<VaultPendingPerson[]> {
    const out = vaultPendingResponseSchema.safeParse(await this.http("GET", "/api/vault/pending"));
    if (!out.success) throw new HttpError(0, "invalid_response");
    return out.data.items;
  }

  /**
   * Conferma come il main del desktop: dalla lista FRESCA apre ogni propria
   * copia e la ricifra per la chiave della persona; una che non si apre si
   * salta (resta per un altro lettore). L'esito in conteggi.
   */
  private async confirm(keyId: string, k: { privateKey: CryptoKey; personKeyId: string }) {
    const person = (await this.pendingPeople()).find((p) => p.personKey.id === keyId);
    // Un codice locale, non un 404 del server: non spegne niente, e nessuna prova.
    if (!person) return { ok: false as const, code: "not_pending" };
    const { copies, unopenable } = await this.rewrap(person, k.privateKey, k.personKeyId);
    // Copie da aprire c'erano, e nessuna si è aperta: niente da salvare, e
    // niente prova bruciata. (Una persona senza credenziali in attesa si
    // conferma comunque: la sua chiave passa a «confermata».)
    if (person.credentials.length > 0 && copies.length === 0) return { ok: false as const, code: "nothing_opened" };
    const result = await this.http("POST", `/api/vault/pending/${seg(keyId)}/confirm`, {
      copies,
      actorProof: await this.prove(k.privateKey, k.personKeyId),
    });
    return { ...counts(result), unopenable };
  }

  /**
   * Le copie per una persona: ogni copia di chi conferma (`recipientId`: la
   * propria chiave, o `recovery` col kit) si apre e si ricifra per la sua
   * chiave; una che non si apre si salta.
   */
  private async rewrap(person: VaultPendingPerson, privateKey: CryptoKey, recipientId: string) {
    const copies: { credentialId: string; wrappedKey: string; keyVersion: string }[] = [];
    let unopenable = 0;
    for (const c of person.credentials) {
      try {
        const itemKey = await unwrapItemKey(c.wrappedKey, privateKey, c.id, recipientId);
        copies.push({
          credentialId: c.id,
          wrappedKey: await wrapItemKey(itemKey, person.personKey.fingerprintSource, c.id, person.personKey.id),
          keyVersion: c.keyVersion,
        });
      } catch {
        unopenable += 1;
      }
    }
    return { copies, unopenable };
  }

  /** Una sfida del recupero aperta col kit: la prova. `wrong_kit` se il kit non è questo. */
  private async recoveryProof(key: CryptoKey): Promise<{ challengeId: string; proof: string }> {
    const challenge = vaultRecoveryChallengeResponseSchema.safeParse(await this.http("POST", "/api/vault/recovery/challenge", {}));
    if (!challenge.success) throw new HttpError(0, "invalid_response");
    try {
      return {
        challengeId: challenge.data.challengeId,
        proof: await openRecoveryChallenge(challenge.data.wrapped, key, challenge.data.challengeId),
      };
    } catch {
      throw new HttpError(0, "wrong_kit");
    }
  }

  /** Chi aspetta, visto col kit: con una prova nuova, che resta buona per la prossima conferma. */
  private async recoveryReload(
    key: CryptoKey,
    who: { personId: string; sessionTag: string; serverTag: string | null; loadedAt: number },
  ): Promise<VaultPendingPerson[]> {
    const proof = await this.recoveryProof(key);
    const out = vaultPendingResponseSchema.safeParse(await this.http("POST", "/api/vault/recovery/pending", proof));
    if (!out.success) throw new HttpError(0, "invalid_response");
    this.recovery = { key, people: out.data.items, proof, ...who };
    return out.data.items;
  }

  /**
   * I-1: il kit caricato, se vale ancora per QUESTA persona e sessione (anche
   * sul server) e da meno di {@link RECOVERY_MS}; altrimenti si butta.
   */
  private async liveRecovery(personId: string, sessionTag: string) {
    const r = this.recovery;
    if (!r) return null;
    const stale = r.personId !== personId || r.sessionTag !== sessionTag || this.deps.now() - r.loadedAt > RECOVERY_MS;
    if (!stale) {
      const server = await this.whoOnServer();
      if (server.userId === r.personId && server.serverTag === r.serverTag && this.recovery === r) return r;
    }
    if (this.recovery === r) this.recovery = null;
    return null;
  }

  /** I-1: la presenza fresca, verificata col server; lancia (col codice del server) se non regge. */
  private async verifyPresence(presence: FreshPresence): Promise<void> {
    if (presence.kind === "code") {
      // Il codice si inoltra e basta: non si logga, non si tiene.
      await this.http("POST", "/api/me/security/reauth", { code: String(presence.code) });
      return;
    }
    await this.http("POST", "/api/me/security/reauth/passkey/verify", { response: presence.assertion });
  }

  /**
   * Conferma col kit: una sfida per conferma (quella dell'elenco, se non è
   * ancora consumata; scaduta, se ne chiede una nuova una volta). Poi
   * l'elenco si rilegge: se non riesce, l'esito resta.
   */
  private async recoveryConfirm(req: Extract<CoreRequest, { t: "recoveryConfirm" }>) {
    const personKeyId = req.personKeyId;
    const r = await this.liveRecovery(req.personId, req.sessionTag);
    if (!r) return { ok: false as const, code: "no_kit" };
    const person = r.people.find((p) => p.personKey.id === personKeyId);
    if (!person) return { ok: false as const, code: "not_pending" };
    if (!req.presence || (req.presence.kind !== "passkey" && req.presence.kind !== "code"))
      return { ok: false as const, code: "presence_required" };
    await this.verifyPresence(req.presence);
    // Una chiusura arrivata durante la verifica ha buttato il kit.
    if (this.recovery !== r) return { ok: false as const, code: "no_kit" };
    const { copies, unopenable } = await this.rewrap(person, r.key, "recovery");
    if (person.credentials.length > 0 && copies.length === 0) return { ok: false as const, code: "nothing_opened" };
    const send = (proof: { challengeId: string; proof: string }) =>
      this.http("POST", `/api/vault/recovery/confirm/${seg(personKeyId)}`, { ...proof, copies });
    const first = r.proof ?? (await this.recoveryProof(r.key));
    r.proof = null;
    let result: unknown;
    try {
      result = await send(first);
    } catch (error) {
      if (!(error instanceof HttpError && error.code === "recovery_proof_invalid")) throw error;
      result = await send(await this.recoveryProof(r.key));
    }
    const outcome = { ...counts(result), unopenable };
    let items: VaultPendingPerson[] | null = null;
    try {
      if (this.recovery === r) items = await this.recoveryReload(r.key, r);
    } catch {
      items = null;
    }
    return { ...outcome, items: items === null ? null : await summarize(items) };
  }

  async handle(req: CoreRequest): Promise<unknown> {
    try {
      return await this.dispatch(req);
    } catch (error) {
      if (
        req.t === "unlock" ||
        req.t === "createKey" ||
        req.t === "sealBegin" ||
        req.t === "sealFinish" ||
        req.t === "pairSeal" ||
        req.t === "stash"
      )
        this.dropStash();
      if (req.t === "sealBegin" || req.t === "sealFinish") this.dropSealing();
      if (error instanceof HttpError) {
        return error.code === "vault_reveal_rate_limited" && error.retryAfterSeconds !== undefined
          ? { ok: false, code: error.code, retryAfterSeconds: error.retryAfterSeconds }
          : { ok: false, code: error.code };
      }
      return { ok: false, code: "failed" };
    }
  }

  private async dispatch(req: CoreRequest): Promise<unknown> {
    switch (req.t) {
      case "serverStatus":
        return { ok: true, status: await this.http<VaultStatusResponse>("GET", "/api/vault/status") };
      case "prepare": {
        const status = await this.http<VaultStatusResponse>("GET", "/api/vault/status");
        if (req.purpose === "activate" && status.activated) return { ok: false, code: "vault_already_active" };
        if (req.purpose !== "activate" && !status.activated) return { ok: false, code: "inactive" };
        const creating = req.purpose === "create" || req.purpose === "activate";
        if (creating && hasLiveKey(status) && (!req.recreate || status.seals.length > 0)) return { ok: false, code: "has_key" };
        if (!creating && !hasLiveKey(status)) return { ok: false, code: "no_key" };
        let offered = creating ? (status.passkeys ?? []) : status.seals;
        if (req.purpose === "seal") {
          const target = (status.passkeys ?? []).find((p) => p.passkeyId === req.passkeyId);
          if (!target) return { ok: false, code: "passkey_unknown" };
          if (status.seals.some((p) => p.passkeyId === target.passkeyId)) return { ok: false, code: "already_sealed" };
          offered = [target];
        }
        // Da aprire, le passkey col sigillo; da creare, tutte; da sigillare, la nuova.
        const sealed = offered.map((s) => s.credentialIdB64url);
        const options = await this.http<PasskeyAuthenticationOptions>(
          "POST",
          "/api/me/security/reauth/passkey/options",
          { purpose: "vault" },
        );
        // M-1: il salt PRF è quello locale; uno diverso dal server si rifiuta.
        if (options.extensions?.prf?.eval?.first !== toBase64Url(PRF_INPUT)) return { ok: false, code: "prf_mismatch" };
        const allow = (options.allowCredentials ?? []).filter((c) => sealed.includes(c.id));
        if (allow.length === 0) return { ok: false, code: "no_seal" };
        this.prepared = req.purpose ?? "open";
        return { ok: true, options: { ...options, allowCredentials: allow }, onlyCredentialIds: allow.map((c) => c.id) };
      }
      case "stash":
        this.dropStash();
        this.stashed = { prf: req.prf, at: this.deps.now(), purpose: this.prepared };
        this.prepared = "open";
        return { ok: true };
      case "unlock": {
        const prf = this.takeStash("open");
        if (!prf) return { ok: false, code: "no_prf" };
        if (!sameCredential(req.assertion, req.credentialId)) {
          wipe(prf);
          return { ok: false, code: "credential_mismatch" };
        }
        try {
          await this.http("POST", "/api/me/security/reauth/passkey/verify", { response: req.assertion });
          const server = await this.whoOnServer();
          if (server.userId !== req.personId) return { ok: false, code: "session" };
          const mine = await this.http<VaultMyKeyResponse>("GET", "/api/vault/keys/mine");
          const seal = mine.seals.find((s) => s.credentialIdB64url === req.credentialId);
          if (!seal) return { ok: false, code: "no_seal" };
          let privateKey: CryptoKey;
          try {
            privateKey = await openPrivateKey(prf, seal.sealedPrivateKey, mine.publicKey);
          } catch {
            return { ok: false, code: "open_failed" };
          }
          this.open(privateKey, mine.id, req.personId, req.sessionTag, server.serverTag);
          return { ok: true };
        } finally {
          wipe(prf);
        }
      }
      case "sealBegin":
      case "sealFinish": {
        const prf = req.t === "sealBegin" ? this.takeStash("open") : this.takeStash("seal");
        if (!prf) {
          if (req.t === "sealFinish") this.dropSealing();
          return { ok: false, code: "no_prf" };
        }
        try {
          if (req.t === "sealBegin") {
            this.dropSealing();
            return await this.sealBegin(req, prf);
          }
          return await this.sealFinish(req, prf);
        } finally {
          wipe(prf);
        }
      }
      case "createKey": {
        const prf = this.takeStash("create", "activate");
        if (!prf) return { ok: false, code: "no_prf" };
        try {
          return await this.createKey(req, prf);
        } finally {
          wipe(prf);
        }
      }
      case "reveal": {
        const k = await this.live(req.personId, req.sessionTag);
        if (!k || !this.key) return { ok: false, code: "vault_locked" };
        if (this.key.reveals >= REVEALS_PER_UNLOCK) {
          this.lock("reveal_limit");
          return { ok: false, code: "vault_locked" };
        }
        this.key.reveals += 1;
        const privateKey = k.privateKey;
        const r = await this.http<CredentialRevealResponse>(
          "POST",
          `/api/credentials/${seg(req.id)}/reveal`,
          { action: req.action },
        );
        const itemKey = await unwrapItemKey(r.wrappedKey, privateKey, req.id, r.personKeyId, { extractable: false });
        const password = await decryptPassword(req.id, r.passwordCiphertext, itemKey);
        // Chiusa mentre la risposta arrivava: la password non esce.
        if (!this.key) return { ok: false, code: "vault_locked" };
        return { ok: true, password };
      }
      case "create": {
        const id = crypto.randomUUID();
        const { resaved } = await this.writeEncrypted({
          credentialId: id,
          password: req.password,
          recipientsPath: `/api/projects/${seg(req.projectId)}/credentials/recipients`,
          write: (enc) => this.http("POST", `/api/projects/${seg(req.projectId)}/credentials`, { ...req.fields, id, ...enc }),
        });
        return { ok: true, id, resaved };
      }
      case "setPassword": {
        if (!(await this.live(req.personId, req.sessionTag))) return { ok: false, code: "vault_locked" };
        if (!this.spend("passwordChanges", PASSWORD_CHANGES_PER_UNLOCK)) return { ok: false, code: "vault_locked" };
        const { resaved } = await this.writeEncrypted({
          credentialId: req.id,
          password: req.password,
          recipientsPath: `/api/credentials/${seg(req.id)}/recipients`,
          write: (enc) => this.http("PUT", `/api/credentials/${seg(req.id)}/password`, enc),
        });
        return { ok: true, resaved };
      }
      case "share": {
        const k = await this.live(req.personId, req.sessionTag);
        if (!k) return { ok: false, code: "vault_locked" };
        if (!this.spend("shares", SHARES_PER_UNLOCK)) return { ok: false, code: "vault_locked" };
        return this.share(req.id, req.target, k);
      }
      case "removeReader": {
        if (!req.presence) return { ok: false, code: "presence_required" };
        const k = await this.live(req.personId, req.sessionTag);
        if (!k) return { ok: false, code: "vault_locked" };
        const absent = await this.present(req.presence);
        if (absent) return absent;
        await this.http("DELETE", `/api/credentials/${seg(req.id)}/readers/${seg(req.readerId)}`, {
          actorProof: await this.prove(k.privateKey, k.personKeyId),
        });
        return { ok: true };
      }
      case "pending":
        return { ok: true, items: await summarize(await this.pendingPeople()) };
      case "recoveryLoad": {
        this.recovery = null;
        let key: CryptoKey;
        try {
          key = await parseRecoveryKit(String(req.kitText));
        } catch {
          return { ok: false, code: "invalid_kit" };
        }
        const server = await this.whoOnServer();
        if (server.userId !== req.personId) return { ok: false, code: "session" };
        const who = { personId: req.personId, sessionTag: req.sessionTag, serverTag: server.serverTag, loadedAt: this.deps.now() };
        return { ok: true, items: await summarize(await this.recoveryReload(key, who)) };
      }
      case "recoveryConfirm":
        return this.recoveryConfirm(req);
      case "reauth":
        if (!req.presence || (req.presence.kind !== "passkey" && req.presence.kind !== "code"))
          return { ok: false, code: "presence_required" };
        await this.verifyPresence(req.presence);
        return { ok: true };
      case "presenceOptions": {
        // Senza `purpose`: la riconferma normale, nessuna estensione PRF.
        const options = await this.http<PasskeyAuthenticationOptions>("POST", "/api/me/security/reauth/passkey/options", {});
        return { ok: true, options };
      }
      case "recoveryForget":
        this.recovery = null;
        return { ok: true };
      case "pairLookup": {
        this.pairing = null;
        const state = String(req.state);
        const out = vaultDevicePairingLookupResponseSchema.safeParse(
          await this.http("POST", "/api/vault/device-pairings/lookup", { state }),
        );
        if (!out.success) return { ok: false, code: "invalid_response" };
        const fingerprint = await keyFingerprint(out.data.devicePublicKey);
        this.pairing = {
          state,
          deviceId: out.data.deviceId,
          devicePublicKey: out.data.devicePublicKey,
          last4: fingerprint.replace(/\s/g, "").slice(-4).toLowerCase(),
        };
        return {
          ok: true,
          deviceName: out.data.deviceName,
          patCreatedAt: out.data.patCreatedAt,
          patLastUsedAt: out.data.patLastUsedAt,
          expiresAt: out.data.expiresAt,
        };
      }
      case "pairSeal": {
        const prf = this.takeStash("open");
        if (!prf) return { ok: false, code: "no_prf" };
        try {
          return await this.pairSeal(req, prf);
        } finally {
          wipe(prf);
        }
      }
      case "confirm": {
        if (!req.presence) return { ok: false, code: "presence_required" };
        const k = await this.live(req.personId, req.sessionTag);
        if (!k) return { ok: false, code: "vault_locked" };
        const absent = await this.present(req.presence);
        if (absent) return absent;
        return this.confirm(req.keyId, k);
      }
      case "reject": {
        if (!req.presence) return { ok: false, code: "presence_required" };
        const k = await this.live(req.personId, req.sessionTag);
        if (!k) return { ok: false, code: "vault_locked" };
        const absent = await this.present(req.presence);
        if (absent) return absent;
        await this.http("POST", `/api/vault/pending/${seg(req.keyId)}/reject`, {
          actorProof: await this.prove(k.privateKey, k.personKeyId),
        });
        return { ok: true };
      }
      case "kit": {
        const status = await this.http<VaultStatusResponse>("GET", "/api/vault/status");
        if (req.purpose === "activate" && status.activated) return { ok: false, code: "vault_already_active" };
        if (req.purpose === "rotate" && !status.activated) return { ok: false, code: "inactive" };
        if (req.purpose === "rotate") {
          // Le vuole TUTTE: con una credenziale senza la propria copia, niente kit (la pagina dice quali).
          const preview = await this.rotationPreview();
          if (preview.missing.length > 0) return { ok: false, code: "missing", missing: preview.missing };
        }
        const { publicKey, kitText } = await generateRecoveryKit();
        this.kit = { publicKey, purpose: req.purpose };
        return { ok: true, kitText };
      }
      case "forgetKit":
        this.kit = null;
        return { ok: true };
      case "activate": {
        const kit = this.kit;
        if (!kit || kit.purpose !== "activate") return { ok: false, code: "no_kit" };
        try {
          await this.http("POST", "/api/vault/activate", { recoveryPublicKey: kit.publicKey });
        } catch (error) {
          // Attivata da altri nel frattempo: questo kit non vale niente.
          if (error instanceof HttpError && error.code === "vault_already_active") this.kit = null;
          // Una riconferma chiesta lo lascia: dopo, si riprova con la stessa pubblica.
          throw error;
        }
        this.kit = null;
        return { ok: true };
      }
      case "rotateKit": {
        const kit = this.kit;
        if (!kit || kit.purpose !== "rotate") return { ok: false, code: "no_kit" };
        const k = await this.live(req.personId, req.sessionTag);
        if (!k) return { ok: false, code: "vault_locked" };
        const out = await this.rotate(kit.publicKey, k);
        if (out.ok) this.kit = null;
        return out;
      }
      case "discard":
        this.dropStash();
        this.dropSealing();
        return { ok: true };
      case "touch":
        if (this.key && !this.expireIfDue()) {
          this.key.lastUseAt = this.deps.now();
          this.arm();
        }
        return { ok: true };
      case "lock":
        this.lock(req.reason);
        return { ok: true };
      case "status":
        this.expireIfDue();
        return this.key ? { state: "open", closesAt: this.closesAt() } : { state: "locked" };
    }
  }
}
