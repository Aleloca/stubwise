import {
  credentialRevealResponseSchema,
  credentialSharePreviewSchema,
  vaultActorChallengeResponseSchema,
  vaultConfirmResponseSchema,
  vaultPendingResponseSchema,
  type CredentialSharePreview,
  type VaultActorProof,
} from "@stubwise/shared";
import {
  decryptPassword,
  keyFingerprint,
  openActorChallenge,
  unwrapItemKey,
  wrapItemKey,
} from "@stubwise/vault-crypto";
import { isDisabled, VaultHttpError } from "./vaultRemote";

// Le operazioni con la chiave di persona, nel main (lotto 10; rotte del PAT
// desktop col sigillo, 72, a912fbcb8). La privata non esce da `vaultLock`
// (`use`), e al renderer escono SOLO: la password di «Show» (è ciò che la
// persona ha chiesto di vedere), esiti e conteggi. Mai una copia della
// chiave, mai la password di «Copy» (gli appunti li scrive il main), mai una
// sfida o una prova. Un 403 `device_seal_required` (Mac tolto, chiave di
// persona ricreata) porta la cassaforte in `revoked` (D-5: il login resta).

/** Dopo quanto la password copiata lascia gli appunti (come il web). */
export const CLIPBOARD_CLEAR_MS = 30_000;

export interface VaultOpsDeps {
  lock: {
    use: <T>(run: (key: CryptoKey, personKeyId: string) => Promise<T>) => Promise<T>;
    /** M5: un Touch ID vero per le azioni che passano l'accesso. */
    useWithTouch: <T>(run: (key: CryptoKey, personKeyId: string) => Promise<T>) => Promise<T>;
    markRevoked: () => void;
    markDisabled: () => void;
  };
  /** `vaultRemote.request`: il PAT desktop, `VaultHttpError` sugli errori. */
  request: (method: string, path: string, body?: unknown) => Promise<unknown>;
  clipboard: { write: (text: string) => void; read: () => string | Promise<string> };
}

export type OpFailure = { ok: false; code: string };
export type ReaderTarget = { userId: string } | { roleId: string };

/** Una persona da confermare come la vede il renderer: niente copie della chiave. */
export interface PendingPersonView {
  userId: string;
  email: string;
  personKeyId: string;
  status: "pending" | "confirmed";
  createdAt: string;
  device: string | null;
  fingerprint: string;
  credentials: { id: string; service: string; label: string | null }[];
}

const seg = encodeURIComponent;

function parse<T>(
  schema: { safeParse: (v: unknown) => { success: true; data: T } | { success: false } },
  value: unknown,
): T {
  const out = schema.safeParse(value);
  if (!out.success) throw new Error("invalid_response");
  return out.data;
}

export function createVaultOps(deps: VaultOpsDeps) {
  /** Ogni operazione: la cassaforte aperta, gli errori in un codice, la revoca. */
  async function guarded<T extends object>(
    run: (key: CryptoKey, personKeyId: string) => Promise<T>,
    options: { touch?: boolean } = {},
  ): Promise<({ ok: true } & T) | OpFailure> {
    try {
      // M5: le azioni che passano l'accesso chiedono un Touch ID vero a sé.
      const out = await (options.touch ? deps.lock.useWithTouch(run) : deps.lock.use(run));
      return { ok: true, ...out };
    } catch (error) {
      if (isDisabled(error)) {
        // `VAULT_DESKTOP` spento: si apre dal browser.
        deps.lock.markDisabled();
        return { ok: false, code: "disabled" };
      }
      if (error instanceof VaultHttpError) {
        if (error.status === 403 && error.code === "device_seal_required") deps.lock.markRevoked();
        return { ok: false, code: error.code };
      }
      const code = error instanceof Error ? error.message : "";
      return {
        ok: false,
        code: [
          "vault_locked",
          "invalid_response",
          "stale_key",
          "touch_id_cancelled",
          "touch_id_unavailable",
          "revoked",
          "disabled",
        ].includes(code)
          ? code
          : "open_failed",
      };
    }
  }

  /** La prova della propria chiave: una per azione (il server la consuma). */
  async function prove(key: CryptoKey, personKeyId: string): Promise<VaultActorProof> {
    const challenge = parse(
      vaultActorChallengeResponseSchema,
      await deps.request("POST", "/api/vault/actor-challenge", {}),
    );
    if (challenge.personKeyId !== personKeyId) throw new Error("stale_key");
    return {
      challengeId: challenge.challengeId,
      proof: await openActorChallenge(challenge.wrapped, key, challenge.challengeId, personKeyId),
    };
  }

  /** La password in chiaro, nel main: `reveal` (registrato) e la propria copia. */
  async function reveal(
    credentialId: string,
    action: "show" | "copy",
    key: CryptoKey,
  ): Promise<string> {
    const r = parse(
      credentialRevealResponseSchema,
      await deps.request("POST", `/api/credentials/${seg(credentialId)}/reveal`, { action }),
    );
    const itemKey = await unwrapItemKey(r.wrappedKey, key, credentialId, r.personKeyId);
    return decryptPassword(credentialId, r.passwordCiphertext, itemKey);
  }

  let clearTimer: ReturnType<typeof setTimeout> | undefined;
  /** L'ultima password copiata, finché gli appunti non si svuotano (M4: per `before-quit`). */
  let copied: string | null = null;

  /** Svuota gli appunti se contengono ancora la password copiata (non poter rileggere: si svuotano comunque). */
  async function clearIfStill(password: string): Promise<void> {
    let now: string | null = null;
    try {
      now = await deps.clipboard.read();
    } catch {
      now = null;
    }
    if (now === null || now === password) deps.clipboard.write("");
    if (copied === password) copied = null;
  }

  /** M5: condividere, togliere un lettore, confermare e rifiutare chiedono un Touch ID a sé. */
  const TOUCH = { touch: true } as const;

  async function share(credentialId: string, target: ReaderTarget) {
    return guarded(async (key, personKeyId) => {
      const query =
        "userId" in target ? `userId=${seg(target.userId)}` : `roleId=${seg(target.roleId)}`;
      const attempt = async (preview: CredentialSharePreview) => {
        const itemKey = await unwrapItemKey(preview.wrappedKey, key, credentialId, personKeyId);
        const copies = await Promise.all(
          preview.people.map(async (p) => ({
            recipientId: p.personKeyId,
            wrappedKey: await wrapItemKey(itemKey, p.publicKey, credentialId, p.personKeyId),
          })),
        );
        await deps.request("POST", `/api/credentials/${seg(credentialId)}/readers`, {
          ...target,
          copies,
          keyVersion: preview.keyVersion,
          actorProof: await prove(key, personKeyId),
        });
        return { waiting: preview.waiting.map((w) => w.email) };
      };
      const first = parse(
        credentialSharePreviewSchema,
        await deps.request("GET", `/api/credentials/${seg(credentialId)}/readers/preview?${query}`),
      );
      try {
        return await attempt(first);
      } catch (error) {
        // Persone o password cambiate nel frattempo: si rifà sull'anteprima attuale, UNA volta.
        const current =
          error instanceof VaultHttpError &&
          error.status === 409 &&
          error.code === "recipients_changed"
            ? credentialSharePreviewSchema.safeParse(
                (error.details as { preview?: unknown } | undefined)?.preview,
              )
            : null;
        if (!current?.success) throw error;
        return attempt(current.data);
      }
    }, TOUCH);
  }

  async function pendingPeople() {
    return parse(vaultPendingResponseSchema, await deps.request("GET", "/api/vault/pending")).items;
  }

  return {
    /** «Show»: la password a chi l'ha chiesta. */
    show: (credentialId: string) =>
      guarded(async (key) => ({ password: await reveal(credentialId, "show", key) })),

    /** «Copy»: negli appunti dal main; dopo 30 s si cancellano se contengono ancora lei. */
    copy: (credentialId: string) =>
      guarded(async (key) => {
        const password = await reveal(credentialId, "copy", key);
        deps.clipboard.write(password);
        copied = password;
        clearTimeout(clearTimer);
        clearTimer = setTimeout(() => void clearIfStill(password), CLIPBOARD_CLEAR_MS);
        return {};
      }),

    /** M4: all'uscita (`before-quit`) gli appunti si svuotano subito, se c'è ancora la password. */
    clearClipboard: async () => {
      clearTimeout(clearTimer);
      if (copied !== null) await clearIfStill(copied);
    },

    share,

    /** Toglie un lettore diretto, con la prova (le copie di chi esce le cancella il server). */
    removeReader: (credentialId: string, readerId: string) =>
      guarded(async (key, personKeyId) => {
        await deps.request(
          "DELETE",
          `/api/credentials/${seg(credentialId)}/readers/${seg(readerId)}`,
          {
            actorProof: await prove(key, personKeyId),
          },
        );
        return {};
      }, TOUCH),

    /** Chi aspetta che io confermi: persone, impronta e credenziali, senza le copie. */
    pending: () =>
      guarded(async () => ({
        items: await Promise.all(
          (await pendingPeople()).map(
            async (p): Promise<PendingPersonView> => ({
              userId: p.user.id,
              email: p.user.email,
              personKeyId: p.personKey.id,
              status: p.personKey.status,
              createdAt: p.personKey.createdAt,
              device: p.personKey.device,
              fingerprint: await keyFingerprint(p.personKey.fingerprintSource),
              credentials: p.credentials.map((c) => ({
                id: c.id,
                service: c.service,
                label: c.label,
              })),
            }),
          ),
        ),
      })),

    /**
     * Conferma: dalla lista FRESCA, apre ogni propria copia e la ricifra per la
     * chiave della persona; una che non si apre si salta (resta per un altro
     * lettore). L'esito in conteggi, come le frasi del web.
     */
    confirm: (targetKeyId: string) =>
      guarded(async (key, personKeyId) => {
        const person = (await pendingPeople()).find((p) => p.personKey.id === targetKeyId);
        if (!person) throw new VaultHttpError(404, "not_found");
        const copies: { credentialId: string; wrappedKey: string; keyVersion: string }[] = [];
        let unopenable = 0;
        for (const c of person.credentials) {
          try {
            const itemKey = await unwrapItemKey(c.wrappedKey, key, c.id, personKeyId);
            copies.push({
              credentialId: c.id,
              wrappedKey: await wrapItemKey(
                itemKey,
                person.personKey.fingerprintSource,
                c.id,
                targetKeyId,
              ),
              keyVersion: c.keyVersion,
            });
          } catch {
            unopenable += 1;
          }
        }
        const result = parse(
          vaultConfirmResponseSchema,
          await deps.request("POST", `/api/vault/pending/${seg(targetKeyId)}/confirm`, {
            copies,
            actorProof: await prove(key, personKeyId),
          }),
        );
        return {
          saved: result.saved.length,
          keyChanged: result.skipped.filter((s) => s.reason === "key_changed").length,
          notAllowed: result.skipped.filter((s) => s.reason === "not_allowed").length,
          unopenable,
        };
      }, TOUCH),

    reject: (targetKeyId: string) =>
      guarded(async (key, personKeyId) => {
        await deps.request("POST", `/api/vault/pending/${seg(targetKeyId)}/reject`, {
          actorProof: await prove(key, personKeyId),
        });
        return {};
      }, TOUCH),
  };
}

export type VaultOps = ReturnType<typeof createVaultOps>;
