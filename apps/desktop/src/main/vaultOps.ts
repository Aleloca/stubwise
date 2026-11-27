import {
  credentialListResponseSchema,
  credentialRecipientsSchema,
  credentialRevealResponseSchema,
  credentialSharePreviewSchema,
  vaultActorChallengeResponseSchema,
  vaultConfirmResponseSchema,
  vaultDeviceSealListSchema,
  vaultPendingResponseSchema,
  vaultStatusResponseSchema,
  type CredentialItem,
  type CredentialRecipients,
  type CredentialSharePreview,
  type VaultActorProof,
} from "@stubwise/shared";
import {
  decryptPassword,
  encryptForInsert,
  keyFingerprint,
  openActorChallenge,
  unwrapItemKey,
  wrapItemKey,
} from "@stubwise/vault-crypto";
import type { VaultClipboard } from "./vaultClipboard";
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
    /** C'è il dispositivo associato su questo Mac (le chiavi locali). */
    hasDevice: () => boolean;
  };
  /** `vaultRemote.request`: il PAT desktop, `VaultHttpError` sugli errori. */
  request: (method: string, path: string, body?: unknown) => Promise<unknown>;
  /** Gli appunti (M4: coi tipi Concealed/Transient dall'helper, `vaultClipboard.ts`). */
  clipboard: VaultClipboard;
}

/** `retryAfterSeconds`: solo col tetto delle letture (C2, 429 `vault_reveal_rate_limited`). */
export type OpFailure = { ok: false; code: string; retryAfterSeconds?: number };
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
  /** `projectId` per il punto «ti aspetta» della colonna del progetto. */
  credentials: { id: string; projectId: string; service: string; label: string | null }[];
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

/** Un proprio Mac nell'elenco di Preferenze → Security (come `MacView` del renderer). */
export interface MacEntry {
  id: string;
  name: string;
  pairedAt: string;
  lastUsedAt: string | null;
  current: boolean;
  fingerprint: string;
}

/** I campi in chiaro di una credenziale nuova (come `CredentialInput` del renderer, senza password). */
export interface CredentialFields {
  service: string;
  label: string | null;
  url: string | null;
  username: string | null;
  notes: string | null;
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
        // C2: il tetto delle letture è temporaneo, e il renderer dice quando si libera.
        if (error.code === "vault_reveal_rate_limited" && error.retryAfterSeconds !== undefined)
          return { ok: false, code: error.code, retryAfterSeconds: error.retryAfterSeconds };
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
          "not_pending",
          "touch_id_unavailable",
          "revoked",
          "disabled",
          "unavailable",
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
  /** Il segnale dell'ultima copia, finché gli appunti non si svuotano (M4: per `before-quit`). */
  let copied: { token: unknown } | null = null;

  /** Svuota gli appunti se nessuno li ha cambiati dopo quella copia. */
  async function clearIfStill(written: { token: unknown }): Promise<void> {
    if (copied === written) copied = null;
    await deps.clipboard.clearIf(written.token);
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

  /**
   * Cifra e scrive (creazione o password nuova), come il web
   * (`apps/web/src/lib/vault/credentials.ts`): la password per ESATTAMENTE
   * i destinatari dati, le persone e il recupero. Se nel frattempo
   * l'insieme è cambiato, il server risponde 409 `recipients_changed` coi
   * destinatari ATTUALI: si ricifra per quelli e si riprova UNA volta.
   */
  async function writeEncrypted(input: {
    credentialId: string;
    password: string;
    recipientsPath: string;
    write: (body: {
      passwordCiphertext: string;
      copies: { recipientId: string; wrappedKey: string }[];
      recoveryPublicKey: string;
    }) => Promise<unknown>;
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
    const first = parse(
      credentialRecipientsSchema,
      await deps.request("GET", input.recipientsPath),
    );
    try {
      await input.write(await encrypt(first));
      return { resaved: false };
    } catch (error) {
      const current =
        error instanceof VaultHttpError &&
        error.status === 409 &&
        error.code === "recipients_changed"
          ? credentialRecipientsSchema.safeParse(
              (error.details as { recipients?: unknown } | undefined)?.recipients,
            )
          : null;
      if (!current?.success) throw error;
      await input.write(await encrypt(current.data));
      // [VA 6]: risalvata per i lettori di adesso; il renderer lo dice.
      return { resaved: true };
    }
  }

  /** Una lettura senza chiave: gli stessi esiti delle altre (`disabled`, il codice del server). */
  async function plainRead<T extends object>(
    run: () => Promise<T>,
  ): Promise<({ ok: true } & T) | OpFailure> {
    try {
      return { ok: true, ...(await run()) };
    } catch (error) {
      if (isDisabled(error)) {
        deps.lock.markDisabled();
        return { ok: false, code: "disabled" };
      }
      noteSealRequired(error);
      if (error instanceof VaultHttpError) return { ok: false, code: error.code };
      return { ok: false, code: "invalid_response" };
    }
  }

  /**
   * Quarta revisione, punto 5: `device_seal_required` con il dispositivo
   * locale presente vuol dire che il Mac è stato tolto (D-5): si segna
   * revocato, così barra e Security dicono la stessa cosa. Senza
   * dispositivo è solo «da associare» (M8).
   */
  function noteSealRequired(error: unknown): boolean {
    const required =
      error instanceof VaultHttpError &&
      error.status === 403 &&
      error.code === "device_seal_required";
    if (required && deps.lock.hasDevice()) deps.lock.markRevoked();
    return required;
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
        const written = { token: await deps.clipboard.copy(password) };
        copied = written;
        clearTimeout(clearTimer);
        clearTimer = setTimeout(() => void clearIfStill(written), CLIPBOARD_CLEAR_MS);
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
    // Review I1: non passa da `lock.use` (riarmerebbe i 15 minuti a ogni
    // lettura del binario, di ⌘K, della pagina): basta la lista con le
    // pubbliche, niente chiave.
    pending: () =>
      plainRead(async () => ({
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
                projectId: c.projectId,
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
        // Un codice locale, non un 404 del server (M2): non spegne niente.
        if (!person) throw new Error("not_pending");
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

    /**
     * Lo stato della propria chiave (`GET /api/vault/status`, `desktopRead`):
     * nell'app ogni `/api/vault*` passa dal main (review C1), e il renderer
     * riceve solo ciò che serve alla barra — niente `seals` né `passkeys`.
     */
    serverStatus: async (): Promise<
      | {
          ok: true;
          activated: boolean;
          myKey: { id: string; status: string; createdAt: string; publicKey: string | null } | null;
        }
      | OpFailure
    > =>
      plainRead(async () => {
        const s = parse(vaultStatusResponseSchema, await deps.request("GET", "/api/vault/status"));
        return {
          activated: s.activated,
          myKey: s.myKey
            ? {
                id: s.myKey.id,
                status: s.myKey.status,
                createdAt: s.myKey.createdAt,
                publicKey: s.myKey.publicKey ?? null,
              }
            : null,
        };
      }),

    /** «Le mie» credenziali (`GET /api/vault/credentials`): lette o in attesa; niente cifrati. */
    mine: async (): Promise<{ ok: true; items: CredentialItem[] } | OpFailure> =>
      plainRead(async () => ({
        items: parse(
          credentialListResponseSchema,
          await deps.request("GET", "/api/vault/credentials"),
        ).items,
      })),

    /**
     * I propri Mac (Preferenze → Security): l'elenco, con `current` sul
     * sigillo di questo Mac e l'impronta INTERA dalla pubblica (M7). Non
     * vuole la cassaforte aperta: è un elenco, nessuna chiave.
     */
    macs: async (): Promise<{ ok: true; items: MacEntry[] } | OpFailure> => {
      try {
        const list = parse(
          vaultDeviceSealListSchema,
          await deps.request("GET", "/api/vault/device-seals"),
        );
        return {
          ok: true,
          items: await Promise.all(
            list.items.map(async (m) => ({
              id: m.id,
              name: m.deviceName,
              pairedAt: m.createdAt,
              lastUsedAt: m.lastUsedAt,
              current: m.current,
              fingerprint: await keyFingerprint(m.devicePublicKey),
            })),
          ),
        };
      } catch (error) {
        if (isDisabled(error)) {
          deps.lock.markDisabled();
          return { ok: false, code: "disabled" };
        }
        // Review M8: senza sigillo (Mac non associato) nessun Mac apre la
        // cassaforte da qui: elenco vuoto, così Security propone «Pair this Mac».
        if (noteSealRequired(error)) return { ok: true, items: [] };
        if (error instanceof VaultHttpError) return { ok: false, code: error.code };
        return { ok: false, code: "open_failed" };
      }
    },

    /**
     * Togliere un ALTRO proprio Mac (VA-Q4): con la cassaforte aperta (la
     * prova della propria chiave) e la riconferma del desktop, che il server
     * chiede con `reauth_required` (il renderer apre «Confirm it's you» e
     * riprova). Il proprio Mac si toglie con «Forget this Mac».
     */
    removeMac: (macId: string) =>
      guarded(async (key, personKeyId) => {
        await deps.request("DELETE", `/api/vault/device-seals/${seg(macId)}`, {
          actorProof: await prove(key, personKeyId),
        });
        return {};
      }),

    /**
     * Una credenziale nuova (fetta 4): non vuole la cassaforte aperta (si
     * cifra con le PUBBLICHE dei destinatari, come fa il PAT da sempre). L'id
     * lo genera il client: la cifratura è legata alla credenziale.
     */
    create: async (
      projectId: string,
      fields: CredentialFields,
      password: string,
    ): Promise<{ ok: true; id: string; resaved: boolean } | OpFailure> => {
      const id = crypto.randomUUID();
      try {
        const { resaved } = await writeEncrypted({
          credentialId: id,
          password,
          recipientsPath: `/api/projects/${seg(projectId)}/credentials/recipients`,
          write: (enc) =>
            deps.request("POST", `/api/projects/${seg(projectId)}/credentials`, {
              id,
              ...fields,
              ...enc,
            }),
        });
        return { ok: true, id, resaved };
      } catch (error) {
        if (isDisabled(error)) {
          deps.lock.markDisabled();
          return { ok: false, code: "disabled" };
        }
        if (error instanceof VaultHttpError) return { ok: false, code: error.code };
        return { ok: false, code: "failed" };
      }
    },

    /** La password nuova (fetta 4): con la cassaforte aperta, come vuole la shape. */
    setPassword: (credentialId: string, password: string) =>
      guarded(async () =>
        writeEncrypted({
          credentialId,
          password,
          recipientsPath: `/api/credentials/${seg(credentialId)}/recipients`,
          write: (enc) =>
            deps.request("PUT", `/api/credentials/${seg(credentialId)}/password`, enc),
        }),
      ),

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
