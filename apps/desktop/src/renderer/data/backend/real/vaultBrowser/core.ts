import {
  credentialRecipientsSchema,
  credentialSharePreviewSchema,
  vaultActorChallengeResponseSchema,
  type CredentialRecipients,
  type CredentialSharePreview,
  type CredentialRevealResponse,
  type PasskeyAuthenticationOptions,
  type VaultMyKeyResponse,
  type VaultActorProof,
  type VaultStatusResponse,
} from "@stubwise/shared";
import {
  PRF_INPUT,
  decryptPassword,
  encryptForInsert,
  openActorChallenge,
  openPrivateKey,
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

/** Quanto resta valida una PRF ricevuta senza lo sblocco che la consuma. */
export const STASH_MS = 2 * 60_000;

export type LockReason =
  | "user"
  | "idle"
  | "expired"
  | "reveal_limit"
  | "logout"
  | "pagehide"
  | "session"
  | "remote"
  | "reauth";

export type CoreRequest =
  | { t: "prepare" }
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
  | { t: "removeReader"; id: string; readerId: string; personId: string; sessionTag: string }
  /** La PRF ricevuta non serve più (M-3, sessione cambiata): si azzera. */
  | { t: "discard" }
  | { t: "touch" }
  | { t: "lock"; reason: LockReason }
  | { t: "status" }
  | { t: "serverStatus" };

export type CoreEvent =
  | { t: "state"; state: "open"; closesAt: number }
  | { t: "state"; state: "locked"; reason: LockReason; code?: string };

export interface CoreDeps {
  fetch: (path: string, init: RequestInit) => Promise<Response>;
  now: () => number;
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (timer: unknown) => void;
  emit: (event: CoreEvent) => void;
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
  } | null = null;
  private timer: unknown = null;
  private stashed: { prf: ArrayBuffer; at: number } | null = null;

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
      if (res.status === 401) this.lock("session");
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

  /** La PRF ricevuta, consumata; `null` se manca o è scaduta (e si azzera). */
  private takeStash(): ArrayBuffer | null {
    const s = this.stashed;
    this.stashed = null;
    if (!s) return null;
    if (this.deps.now() - s.at > STASH_MS) {
      wipe(s.prf);
      return null;
    }
    return s.prf;
  }

  lock(reason: LockReason, code?: string): void {
    this.dropStash();
    const was = this.key;
    this.key = null;
    if (this.timer !== null) this.deps.clearTimer(this.timer);
    this.timer = null;
    if (was) this.deps.emit({ t: "state", state: "locked", reason, ...(code ? { code } : {}) });
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

  async handle(req: CoreRequest): Promise<unknown> {
    try {
      return await this.dispatch(req);
    } catch (error) {
      if (req.t === "unlock" || req.t === "stash") this.dropStash();
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
        if (!status.activated) return { ok: false, code: "inactive" };
        if (!hasLiveKey(status)) return { ok: false, code: "no_key" };
        const sealed = status.seals.map((s) => s.credentialIdB64url);
        const options = await this.http<PasskeyAuthenticationOptions>(
          "POST",
          "/api/me/security/reauth/passkey/options",
          { purpose: "vault" },
        );
        // M-1: il salt PRF è quello locale; uno diverso dal server si rifiuta.
        if (options.extensions?.prf?.eval?.first !== toBase64Url(PRF_INPUT)) return { ok: false, code: "prf_mismatch" };
        const allow = (options.allowCredentials ?? []).filter((c) => sealed.includes(c.id));
        if (allow.length === 0) return { ok: false, code: "no_seal" };
        return { ok: true, options: { ...options, allowCredentials: allow }, onlyCredentialIds: allow.map((c) => c.id) };
      }
      case "stash":
        this.dropStash();
        this.stashed = { prf: req.prf, at: this.deps.now() };
        return { ok: true };
      case "unlock": {
        const prf = this.takeStash();
        if (!prf) return { ok: false, code: "no_prf" };
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
          this.key = {
            privateKey,
            personKeyId: mine.id,
            personId: req.personId,
            sessionTag: req.sessionTag,
            serverTag: server.serverTag,
            lastUseAt: this.deps.now(),
            openedAt: this.deps.now(),
            reveals: 0,
          };
          this.arm();
          this.deps.emit({ t: "state", state: "open", closesAt: this.closesAt() });
          return { ok: true };
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
        return this.share(req.id, req.target, k);
      }
      case "removeReader": {
        const k = await this.live(req.personId, req.sessionTag);
        if (!k) return { ok: false, code: "vault_locked" };
        await this.http("DELETE", `/api/credentials/${seg(req.id)}/readers/${seg(req.readerId)}`, {
          actorProof: await this.prove(k.privateKey, k.personKeyId),
        });
        return { ok: true };
      }
      case "discard":
        this.dropStash();
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
