import type {
  CredentialRevealResponse,
  PasskeyAuthenticationOptions,
  VaultMyKeyResponse,
  VaultStatusResponse,
} from "@stubwise/shared";
import { PRF_INPUT, decryptPassword, openPrivateKey, unwrapItemKey } from "@stubwise/vault-crypto";
import { toBase64Url } from "./bytes";

// Il cuore della cassaforte nel browser (revisione di sicurezza I-1): gira
// in un Dedicated Worker (`worker.ts`), un reame che gli script della pagina
// non raggiungono. Qui, e solo qui:
// - la rete della cassaforte (`fetch` del worker, stessa origine e cookie):
//   il JSON delle risposte non si manomette dalla pagina;
// - la verifica della passkey, l'apertura del sigillo con la PRF (che arriva
//   per transfer e si azzera subito), la `CryptoKey` di persona;
// - la scadenza a ora di parete, col `Date` e il timer del worker;
// - la decifratura per Show (e, coi pezzi dopo, la cifratura per crea e
//   condividi).
// La pagina riceve solo esiti e, per Show e Copy, la sola password.
// `VaultCore` è puro (rete, orologio e timer iniettati): si prova senza un
// worker vero.

/** 15 minuti senza uso (design §7). */
export const IDLE_MS = 15 * 60_000;

export type LockReason = "user" | "idle" | "logout" | "pagehide" | "session" | "remote" | "reauth";

export type CoreRequest =
  | { t: "prepare" }
  | {
      t: "unlock";
      /** L'uscita PRF, trasferita (la pagina non la tiene). Si azzera qui. */
      prf: ArrayBuffer;
      /** La risposta della passkey SENZA i risultati PRF. */
      assertion: unknown;
      credentialId: string;
      personId: string;
      sessionTag: string;
    }
  | { t: "reveal"; id: string; action: "show" | "copy"; personId: string; sessionTag: string }
  /** Una PRF che la pagina non usa più (M-3): arriva per transfer e si azzera. */
  | { t: "discard"; prf: ArrayBuffer }
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
  ) {
    super(code);
  }
}

const hasLiveKey = (s: VaultStatusResponse) =>
  s.myKey !== null && (s.myKey.status === "pending" || s.myKey.status === "confirmed");

const wipe = (buffer: ArrayBuffer) => new Uint8Array(buffer).fill(0);

export class VaultCore {
  private key: { privateKey: CryptoKey; personId: string; sessionTag: string; lastUseAt: number } | null = null;
  private timer: unknown = null;

  constructor(private readonly deps: CoreDeps) {}

  private async http<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
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
      throw new HttpError(res.status, code, Number.isFinite(retry) && retry > 0 ? retry : undefined);
    }
    return res.status === 204 ? (null as T) : ((await res.json()) as T);
  }

  private closesAt(): number {
    return this.key!.lastUseAt + IDLE_MS;
  }

  private arm(): void {
    if (this.timer !== null) this.deps.clearTimer(this.timer);
    this.timer = null;
    if (!this.key) return;
    this.timer = this.deps.setTimer(() => this.expireIfDue(), Math.max(0, this.closesAt() - this.deps.now()) + 1);
  }

  private expireIfDue(): boolean {
    if (this.key && this.deps.now() - this.key.lastUseAt > IDLE_MS) {
      this.lock("idle");
      return true;
    }
    if (this.key) this.arm();
    return false;
  }

  lock(reason: LockReason, code?: string): void {
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

  async handle(req: CoreRequest): Promise<unknown> {
    try {
      return await this.dispatch(req);
    } catch (error) {
      if (req.t === "unlock") wipe(req.prf);
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
      case "unlock": {
        try {
          await this.http("POST", "/api/me/security/reauth/passkey/verify", { response: req.assertion });
          const mine = await this.http<VaultMyKeyResponse>("GET", "/api/vault/keys/mine");
          const seal = mine.seals.find((s) => s.credentialIdB64url === req.credentialId);
          if (!seal) return { ok: false, code: "no_seal" };
          let privateKey: CryptoKey;
          try {
            privateKey = await openPrivateKey(req.prf, seal.sealedPrivateKey, mine.publicKey);
          } catch {
            return { ok: false, code: "open_failed" };
          }
          this.key = { privateKey, personId: req.personId, sessionTag: req.sessionTag, lastUseAt: this.deps.now() };
          this.arm();
          this.deps.emit({ t: "state", state: "open", closesAt: this.closesAt() });
          return { ok: true };
        } finally {
          wipe(req.prf);
        }
      }
      case "reveal": {
        const privateKey = this.use(req.personId, req.sessionTag);
        if (!privateKey) return { ok: false, code: "vault_locked" };
        const r = await this.http<CredentialRevealResponse>(
          "POST",
          `/api/credentials/${encodeURIComponent(req.id)}/reveal`,
          { action: req.action },
        );
        const itemKey = await unwrapItemKey(r.wrappedKey, privateKey, req.id, r.personKeyId, { extractable: false });
        const password = await decryptPassword(req.id, r.passwordCiphertext, itemKey);
        // Chiusa mentre la risposta arrivava: la password non esce.
        if (!this.key) return { ok: false, code: "vault_locked" };
        return { ok: true, password };
      }
      case "discard":
        wipe(req.prf);
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
