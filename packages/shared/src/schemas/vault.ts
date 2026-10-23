import { z } from "zod";

/**
 * Cassaforte delle credenziali (design
 * `docs/plans/2026-10-23-cassaforte-credenziali-design.md`): attivazione,
 * chiavi delle persone e kit di recupero. Il server riceve SOLO materiale
 * pubblico (chiavi pubbliche JWK) o cifrato (buste JSON `v: 1` di
 * `@stubwise/vault-crypto`): nessuna chiave privata né password in chiaro.
 */

/** Tetto di una busta cifrata (chiave privata sigillata, copia della chiave). */
const ENVELOPE_MAX = 8192;

/** Una busta cifrata di `@stubwise/vault-crypto`, opaca per il server. */
const envelopeSchema = z.string().min(1).max(ENVELOPE_MAX);

/**
 * Chiave PUBBLICA ECDH P-256 come JWK serializzato (`exportPublicKey` di
 * `@stubwise/vault-crypto`). Il server non la usa per cifrare, ma rifiuta
 * ciò che non lo è — e in particolare un JWK con `d`, cioè una chiave
 * PRIVATA mandata per errore: non deve mai arrivare qui, tanto meno restarci.
 */
export const vaultPublicKeySchema = z
  .string()
  .min(1)
  .max(1024)
  .refine((value) => {
    try {
      const jwk = JSON.parse(value) as Record<string, unknown> | null;
      return (
        typeof jwk === "object" &&
        jwk !== null &&
        jwk.kty === "EC" &&
        jwk.crv === "P-256" &&
        typeof jwk.x === "string" &&
        typeof jwk.y === "string" &&
        !("d" in jwk)
      );
    } catch {
      return false;
    }
  }, "Not a P-256 public JWK");

export const vaultPersonKeyStatusSchema = z.enum(["pending", "confirmed", "rejected", "superseded"]);
export type VaultPersonKeyStatusView = z.infer<typeof vaultPersonKeyStatusSchema>;

/**
 * Un sigillo della propria chiave privata, come lo vede il browser per
 * scegliere quello della passkey appena usata: `credentialIdB64url` è l'id
 * WebAuthn della passkey (base64url, quello che `navigator.credentials.get()`
 * restituisce come `id`).
 */
export const vaultSealRefSchema = z.object({
  passkeyId: z.uuid(),
  credentialIdB64url: z.string(),
});
export type VaultSealRef = z.infer<typeof vaultSealRefSchema>;

/** Risposta di `GET /api/vault/status`. `myKey`: l'ultima chiave della persona. */
export const vaultStatusResponseSchema = z.object({
  activated: z.boolean(),
  myKey: z
    .object({
      id: z.uuid(),
      status: vaultPersonKeyStatusSchema,
      createdAt: z.iso.datetime(),
    })
    .nullable(),
  seals: z.array(vaultSealRefSchema),
});
export type VaultStatusResponse = z.infer<typeof vaultStatusResponseSchema>;

/** Corpo di `POST /api/vault/activate`: la sola chiave PUBBLICA di recupero. */
export const vaultActivateBodySchema = z.object({
  recoveryPublicKey: vaultPublicKeySchema,
});
export type VaultActivateBody = z.infer<typeof vaultActivateBodySchema>;

/** Un sigillo nuovo: la chiave privata cifrata con il segreto PRF di una passkey. */
export const vaultSealInputSchema = z.object({
  passkeyId: z.uuid(),
  sealedPrivateKey: envelopeSchema,
});
export type VaultSealInput = z.infer<typeof vaultSealInputSchema>;

/**
 * Corpo di `POST /api/vault/keys`. `device`: browser e sistema dichiarati
 * dal client, mostrati a chi conferma la chiave (testo libero, corto).
 */
export const vaultCreateKeyBodySchema = z.object({
  publicKey: vaultPublicKeySchema,
  seals: z.array(vaultSealInputSchema).min(1).max(20),
  device: z.string().trim().max(200),
});
export type VaultCreateKeyBody = z.infer<typeof vaultCreateKeyBodySchema>;

/** Risposta di `POST /api/vault/keys`. */
export const vaultCreateKeyResponseSchema = z.object({
  id: z.uuid(),
  status: vaultPersonKeyStatusSchema,
  createdAt: z.iso.datetime(),
});
export type VaultCreateKeyResponse = z.infer<typeof vaultCreateKeyResponseSchema>;

/**
 * Risposta di `GET /api/vault/keys/mine`: la propria chiave viva con i
 * sigilli (la privata CIFRATA, una per passkey), per aprirla nel browser.
 */
export const vaultMyKeyResponseSchema = z.object({
  id: z.uuid(),
  publicKey: z.string(),
  status: vaultPersonKeyStatusSchema,
  seals: z.array(vaultSealRefSchema.extend({ sealedPrivateKey: z.string() })),
});
export type VaultMyKeyResponse = z.infer<typeof vaultMyKeyResponseSchema>;

/**
 * Corpo di `POST /api/vault/recovery-key`: la nuova chiave pubblica di
 * recupero e la copia della chiave di OGNI credenziale cifrata per lei.
 */
export const vaultRecoveryKeyBodySchema = z.object({
  recoveryPublicKey: vaultPublicKeySchema,
  copies: z.array(z.object({ credentialId: z.uuid(), wrappedKey: envelopeSchema })).max(100_000),
});
export type VaultRecoveryKeyBody = z.infer<typeof vaultRecoveryKeyBodySchema>;

/*
 * ── Credenziali (Task 6) ────────────────────────────────────────────────
 * Solo `passwordCiphertext` è cifrato; gli altri campi sono in chiaro per
 * scelta del maintainer. Le risposte degli ELENCHI non portano mai la
 * password cifrata né una copia della chiave: le dà solo `reveal`.
 */

/** Tetto della password cifrata (busta `v: 1` con IV e tag). */
const PASSWORD_CIPHERTEXT_MAX = 16384;

/** Un campo in chiaro facoltativo: stringa vuota o assente = nessun valore. */
const optionalText = (max: number) => z.string().trim().max(max).nullish();

/**
 * La copia della chiave di una credenziale per UN destinatario: `recipientId`
 * è l'id della chiave di persona (`personKeyId`) o `"recovery"`.
 */
export const credentialKeyCopyInputSchema = z.object({
  recipientId: z.string().min(1).max(64),
  wrappedKey: envelopeSchema,
});
export type CredentialKeyCopyInput = z.infer<typeof credentialKeyCopyInputSchema>;

/**
 * A chi va cifrata la chiave di una credenziale (`GET .../recipients`): i
 * lettori con chiave CONFERMATA e la chiave di recupero. Le copie inviate
 * devono coprire ESATTAMENTE `people[].personKeyId` più `"recovery"`, e il
 * corpo ripete `recoveryPublicKey` (quella per cui è cifrata la copia).
 */
export const credentialRecipientsSchema = z.object({
  people: z.array(
    z.object({
      userId: z.uuid(),
      email: z.string(),
      personKeyId: z.uuid(),
      publicKey: z.string(),
    }),
  ),
  recoveryPublicKey: z.string(),
});
export type CredentialRecipients = z.infer<typeof credentialRecipientsSchema>;

/**
 * Corpo del 409 `recipients_changed`: l'insieme dei destinatari è cambiato
 * fra la lettura e la scrittura (un admin aggiunto, una chiave confermata).
 * Porta i destinatari ATTUALI, così il client ricifra e riprova senza
 * un'altra lettura. Nulla è stato scritto.
 */
export const credentialRecipientsChangedSchema = z.object({
  code: z.literal("recipients_changed"),
  message: z.string(),
  recipients: credentialRecipientsSchema,
});
export type CredentialRecipientsChanged = z.infer<typeof credentialRecipientsChangedSchema>;

/**
 * Corpo di `POST /api/projects/:projectId/credentials`. `id` lo genera il
 * client: è l'AAD della password cifrata e delle copie. `recoveryPublicKey`
 * è la chiave di recupero per cui è cifrata la copia `"recovery"`: il server
 * non può riconoscerla dalla busta, e una copia per la chiave di recupero
 * VECCHIA (kit rigenerato nel frattempo) dà 409 `recipients_changed` come un
 * destinatario mancante.
 */
export const credentialCreateBodySchema = z.object({
  id: z.uuid(),
  service: z.string().trim().min(1).max(200),
  label: optionalText(200),
  url: optionalText(2000),
  username: optionalText(500),
  notes: optionalText(10_000),
  passwordCiphertext: z.string().min(1).max(PASSWORD_CIPHERTEXT_MAX),
  copies: z.array(credentialKeyCopyInputSchema).max(1000),
  recoveryPublicKey: z.string().min(1).max(1024),
});
export type CredentialCreateBody = z.infer<typeof credentialCreateBodySchema>;

/** Corpo di `PATCH /api/credentials/:id`: solo i campi in chiaro, gli assenti restano. */
export const credentialUpdateBodySchema = z.object({
  service: z.string().trim().min(1).max(200).optional(),
  label: optionalText(200),
  url: optionalText(2000),
  username: optionalText(500),
  notes: optionalText(10_000),
});
export type CredentialUpdateBody = z.infer<typeof credentialUpdateBodySchema>;

/**
 * Corpo di `PUT /api/credentials/:id/password`: password nuova e TUTTE le
 * copie, con la chiave di recupero usata (vedi {@link credentialCreateBodySchema}).
 */
export const credentialPasswordBodySchema = z.object({
  passwordCiphertext: z.string().min(1).max(PASSWORD_CIPHERTEXT_MAX),
  copies: z.array(credentialKeyCopyInputSchema).max(1000),
  recoveryPublicKey: z.string().min(1).max(1024),
});
export type CredentialPasswordBody = z.infer<typeof credentialPasswordBodySchema>;

/**
 * Cosa può fare chi guarda con una credenziale dell'elenco: `read` la apre
 * adesso; `pending` è lettore ma aspetta la chiave (sua da confermare, o la
 * copia da ricevere); `manage` non la legge ma la gestisce
 * (`credentials.edit` o `credentials.share` nel progetto).
 */
export const credentialAccessSchema = z.enum(["read", "pending", "manage"]);
export type CredentialAccess = z.infer<typeof credentialAccessSchema>;

/** Una credenziale come la vedono gli elenchi: niente password né copie. */
export const credentialItemSchema = z.object({
  id: z.uuid(),
  projectId: z.uuid(),
  service: z.string(),
  label: z.string().nullable(),
  url: z.string().nullable(),
  username: z.string().nullable(),
  notes: z.string().nullable(),
  createdByUserId: z.uuid().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  updatedByUserId: z.uuid().nullable(),
  access: credentialAccessSchema,
  /** Calcolati dal server: `credentials.edit` o creatore; `credentials.share` e la legge adesso. */
  canEdit: z.boolean().default(false),
  canShare: z.boolean().default(false),
});
export type CredentialItem = z.infer<typeof credentialItemSchema>;

export const credentialListResponseSchema = z.object({ items: z.array(credentialItemSchema) });
export type CredentialListResponse = z.infer<typeof credentialListResponseSchema>;

/** Corpo di `POST /api/credentials/:id/reveal`. */
export const credentialRevealBodySchema = z.object({ action: z.enum(["show", "copy"]) });
export type CredentialRevealBody = z.infer<typeof credentialRevealBodySchema>;

/**
 * Risposta di `reveal`: la password cifrata e la copia della chiave per la
 * chiave di persona CONFERMATA di chi chiede. L'unica che li porta.
 */
export const credentialRevealResponseSchema = z.object({
  passwordCiphertext: z.string(),
  wrappedKey: z.string(),
  personKeyId: z.uuid(),
});
export type CredentialRevealResponse = z.infer<typeof credentialRevealResponseSchema>;

/** Una riga del registro delle letture (fotografia in testo, resta se la credenziale sparisce). */
export const credentialAccessLogEntrySchema = z.object({
  id: z.uuid(),
  credentialId: z.uuid().nullable(),
  credentialSnapshot: z.string(),
  userId: z.uuid().nullable(),
  userEmail: z.string(),
  action: z.enum(["show", "copy"]),
  createdAt: z.iso.datetime(),
});
export type CredentialAccessLogEntry = z.infer<typeof credentialAccessLogEntrySchema>;

export const credentialAccessLogResponseSchema = z.object({
  items: z.array(credentialAccessLogEntrySchema),
});
export type CredentialAccessLogResponse = z.infer<typeof credentialAccessLogResponseSchema>;
