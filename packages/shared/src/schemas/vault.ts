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

/**
 * Risposta di `GET /api/vault/status`. `myKey`: l'ultima chiave della persona.
 * `seals`: le passkey che aprono quella chiave. `passkeys`: TUTTE le passkey
 * della persona (stessa forma), con o senza sigillo — la web ci ritrova la
 * passkey appena usata quando sigilla una chiave NUOVA (prima apertura o
 * chiave da ricreare), perché la risposta di WebAuthn porta solo l'id
 * WebAuthn, non quello della riga. Aggiunto dopo: opzionale per un server
 * più vecchio.
 */
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
  passkeys: z.array(vaultSealRefSchema).default([]),
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
 * Risposta di `POST /api/vault/actor-challenge`: un segreto casuale cifrato
 * per la chiave CONFERMATA di chi chiede (`wrapActorChallenge` di
 * `@stubwise/vault-crypto`, AAD `actor-challenge:<id>:<personKeyId>`). Il
 * browser con la cassaforte aperta lo apre (`openActorChallenge`) e lo
 * rimanda come `actorProof`: è la prova che chi agisce ha davvero la sua
 * chiave. Vale 5 minuti, una volta, per chi l'ha chiesta, nella sua sessione
 * e per QUELLA chiave (`personKeyId`: il browser verifica che sia la sua).
 */
export const vaultActorChallengeResponseSchema = z.object({
  challengeId: z.uuid(),
  personKeyId: z.uuid(),
  wrapped: z.string(),
  expiresAt: z.iso.datetime(),
});
export type VaultActorChallengeResponse = z.infer<typeof vaultActorChallengeResponseSchema>;

/**
 * La prova di possesso della propria chiave: la sfida e il suo segreto in
 * base64url. La vogliono conferma, rifiuto, condivisione, revoca di un
 * lettore e rotazione del kit (403 `vault_proof_invalid` se manca o non vale).
 */
export const vaultActorProofSchema = z.object({
  challengeId: z.uuid(),
  proof: z.string().min(1).max(128),
});
export type VaultActorProof = z.infer<typeof vaultActorProofSchema>;

/**
 * Corpo di `POST /api/vault/recovery-key`: la nuova chiave pubblica di
 * recupero, la copia della chiave di OGNI credenziale cifrata per lei, e la
 * prova che chi ruota ha aperto la sua chiave (le copie le ha ricifrate da lì).
 */
export const vaultRecoveryKeyBodySchema = z.object({
  recoveryPublicKey: vaultPublicKeySchema,
  copies: z.array(z.object({ credentialId: z.uuid(), wrappedKey: envelopeSchema })).max(100_000),
  actorProof: vaultActorProofSchema,
});
export type VaultRecoveryKeyBody = z.infer<typeof vaultRecoveryKeyBodySchema>;

/** Una credenziale nell'anteprima della rotazione del kit (nessuna password cifrata). */
const recoveryKeyPreviewCredentialSchema = z.object({
  id: z.uuid(),
  projectId: z.uuid(),
  service: z.string(),
  label: z.string().nullable(),
});

/**
 * Risposta di `GET /api/vault/recovery-key/preview` (full admin, solo da
 * sessione): per OGNI credenziale dell'istanza, la copia della chiave per la
 * chiave confermata di chi guarda (`personKeyId`), da aprire e ricifrare per
 * la nuova pubblica di recupero. `missing`: le credenziali di cui non ha una
 * copia — la rotazione le vuole TUTTE, quindi con `missing` non vuoto non si
 * può ruotare da questo browser.
 */
export const vaultRecoveryKeyPreviewSchema = z.object({
  personKeyId: z.uuid(),
  credentials: z.array(recoveryKeyPreviewCredentialSchema.extend({ wrappedKey: z.string() })),
  missing: z.array(recoveryKeyPreviewCredentialSchema),
});
export type VaultRecoveryKeyPreview = z.infer<typeof vaultRecoveryKeyPreviewSchema>;

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

/*
 * ── Lettori, conferme e recupero (Task 7) ───────────────────────────────
 * Condividere e confermare vogliono che il browser RICIFRI la chiave di una
 * credenziale per una persona: per questo le risposte qui sotto portano la
 * copia della chiave di chi guarda (o quella di recupero), mai la password
 * cifrata — riaprire la password resta `reveal`, che la registra.
 *
 * `keyVersion` identifica la chiave della credenziale ADESSO (cambia a ogni
 * cambio di password): il client la ripete con le copie, e il server rifiuta
 * una copia cifrata per una chiave che nel frattempo è stata sostituita.
 */

/** Un lettore DIRETTO di una credenziale: una persona o un ruolo di progetto (uno dei due). */
export const credentialReaderSchema = z.object({
  id: z.uuid(),
  userId: z.uuid().nullable(),
  email: z.string().nullable(),
  roleId: z.uuid().nullable(),
  roleName: z.string().nullable(),
  createdAt: z.iso.datetime(),
});
export type CredentialReader = z.infer<typeof credentialReaderSchema>;

/**
 * Un lettore EFFETTIVO (diretto, via ruolo o full admin) e il suo stato:
 * `can_read` = la apre adesso; `pending` = aspetta (`keyStatus` dice perché:
 * nessuna chiave, chiave da confermare, o chiave confermata senza copia).
 */
export const credentialReaderPersonSchema = z.object({
  userId: z.uuid(),
  email: z.string(),
  fullAdmin: z.boolean(),
  status: z.enum(["can_read", "pending"]),
  keyStatus: z.enum(["none", "pending", "confirmed"]),
});
export type CredentialReaderPerson = z.infer<typeof credentialReaderPersonSchema>;

/** Risposta di `GET /api/credentials/:id/readers` (e delle scritture sui lettori). */
export const credentialReadersResponseSchema = z.object({
  readers: z.array(credentialReaderSchema),
  people: z.array(credentialReaderPersonSchema),
});
export type CredentialReadersResponse = z.infer<typeof credentialReadersResponseSchema>;

/** Il lettore da aggiungere: una persona membro del progetto O un ruolo di progetto. */
const readerTargetShape = { userId: z.uuid().optional(), roleId: z.uuid().optional() };
const exactlyOneTarget = (t: { userId?: string; roleId?: string }) =>
  (t.userId === undefined) !== (t.roleId === undefined);

/** Query di `GET /api/credentials/:id/readers/preview`. */
export const credentialSharePreviewQuerySchema = z
  .object(readerTargetShape)
  .refine(exactlyOneTarget, "Exactly one of userId and roleId");
export type CredentialSharePreviewQuery = z.infer<typeof credentialSharePreviewQuerySchema>;

/**
 * Cosa serve per condividere con un lettore nuovo: le persone con chiave
 * CONFERMATA che riceveranno subito la chiave (le copie devono coprirle
 * ESATTAMENTE), quelle che resteranno in attesa, e la copia della chiave di
 * chi condivide (da aprire per ricifrarla) con la sua `keyVersion`.
 */
export const credentialSharePreviewSchema = z.object({
  people: z.array(
    z.object({ userId: z.uuid(), email: z.string(), personKeyId: z.uuid(), publicKey: z.string() }),
  ),
  waiting: z.array(z.object({ userId: z.uuid(), email: z.string() })),
  wrappedKey: z.string(),
  keyVersion: z.string(),
});
export type CredentialSharePreview = z.infer<typeof credentialSharePreviewSchema>;

/** Corpo di `POST /api/credentials/:id/readers`. */
export const credentialShareBodySchema = z
  .object({
    ...readerTargetShape,
    copies: z.array(credentialKeyCopyInputSchema).max(1000),
    keyVersion: z.string().min(1).max(128),
    actorProof: vaultActorProofSchema,
  })
  .refine(exactlyOneTarget, "Exactly one of userId and roleId");
export type CredentialShareBody = z.infer<typeof credentialShareBodySchema>;

/** Corpo di `DELETE /api/credentials/:id/readers/:readerId`: la prova di chi toglie. */
export const credentialRemoveReaderBodySchema = z.object({ actorProof: vaultActorProofSchema });
export type CredentialRemoveReaderBody = z.infer<typeof credentialRemoveReaderBodySchema>;

/**
 * 409 `recipients_changed` di una condivisione: le copie non coprono più
 * esattamente le persone da servire, o la chiave è cambiata. Porta l'anteprima
 * ATTUALE, per riprovare senza un'altra lettura. Nulla è stato scritto.
 */
export const credentialShareChangedSchema = z.object({
  code: z.literal("recipients_changed"),
  message: z.string(),
  preview: credentialSharePreviewSchema,
});
export type CredentialShareChanged = z.infer<typeof credentialShareChangedSchema>;

/**
 * Una credenziale che chi guarda può passare alla persona in attesa:
 * `wrappedKey` è la copia di chi guarda (o, nel recupero, quella di
 * recupero), da aprire e ricifrare per la chiave della persona.
 */
export const vaultPendingCredentialSchema = z.object({
  id: z.uuid(),
  projectId: z.uuid(),
  service: z.string(),
  label: z.string().nullable(),
  wrappedKey: z.string(),
  keyVersion: z.string(),
});
export type VaultPendingCredential = z.infer<typeof vaultPendingCredentialSchema>;

/**
 * Una persona con accessi da confermare: la sua chiave (da verificare con lei
 * prima di confermare: data, dispositivo, impronta della chiave pubblica) e le
 * credenziali che chi guarda può passarle.
 */
export const vaultPendingPersonSchema = z.object({
  user: z.object({ id: z.uuid(), email: z.string() }),
  personKey: z.object({
    id: z.uuid(),
    status: z.enum(["pending", "confirmed"]),
    createdAt: z.iso.datetime(),
    device: z.string().nullable(),
    /** La chiave pubblica: il client ne ricava l'impronta (`keyFingerprint`). */
    fingerprintSource: z.string(),
  }),
  credentials: z.array(vaultPendingCredentialSchema),
});
export type VaultPendingPerson = z.infer<typeof vaultPendingPersonSchema>;

/** Risposta di `GET /api/vault/pending` e `POST /api/vault/recovery/pending`. */
export const vaultPendingResponseSchema = z.object({ items: z.array(vaultPendingPersonSchema) });
export type VaultPendingResponse = z.infer<typeof vaultPendingResponseSchema>;

/** Una copia della chiave di una credenziale per la chiave della persona confermata. */
export const vaultConfirmCopySchema = z.object({
  credentialId: z.uuid(),
  wrappedKey: envelopeSchema,
  keyVersion: z.string().min(1).max(128),
});
export type VaultConfirmCopy = z.infer<typeof vaultConfirmCopySchema>;

/**
 * Corpo di `POST /api/vault/pending/:personKeyId/confirm`: le copie e la
 * prova che chi conferma ha aperto la SUA chiave (`actorProof`). Il recupero ha la
 * sua rotta (`POST /api/vault/recovery/confirm/:personKeyId`, con
 * riconferma e prova di possesso del kit): `viaRecovery: true` qui è rifiutato, così un client che
 * sbaglia rotta non conferma per la via normale credendo di usare il kit.
 */
export const vaultConfirmBodySchema = z.object({
  copies: z.array(vaultConfirmCopySchema).max(10_000),
  viaRecovery: z.literal(false).optional(),
  actorProof: vaultActorProofSchema,
});
export type VaultConfirmBody = z.infer<typeof vaultConfirmBodySchema>;

/** Corpo di `POST /api/vault/pending/:personKeyId/reject`: la prova di chi rifiuta. */
export const vaultRejectBodySchema = z.object({ actorProof: vaultActorProofSchema });
export type VaultRejectBody = z.infer<typeof vaultRejectBodySchema>;

/**
 * Risposta di `POST /api/vault/recovery/challenge`: un segreto casuale cifrato
 * per la chiave pubblica di recupero (`wrapRecoveryChallenge` di
 * `@stubwise/vault-crypto`). Il browser col kit lo apre
 * (`openRecoveryChallenge`) e lo rimanda come `proof`: è la prova che il kit
 * c'è. Vale 5 minuti, per chi l'ha chiesta e nella sua sessione.
 */
export const vaultRecoveryChallengeResponseSchema = z.object({
  challengeId: z.uuid(),
  wrapped: z.string(),
  expiresAt: z.iso.datetime(),
});
export type VaultRecoveryChallengeResponse = z.infer<typeof vaultRecoveryChallengeResponseSchema>;

/** La prova di possesso del kit: la sfida e il suo segreto in base64url. */
export const vaultRecoveryProofSchema = z.object({
  challengeId: z.uuid(),
  proof: z.string().min(1).max(128),
});
export type VaultRecoveryProof = z.infer<typeof vaultRecoveryProofSchema>;

/**
 * Corpo di `POST /api/vault/recovery/pending`: solo la prova. L'elenco la
 * verifica ma non la consuma (si può rileggere finché la sfida vale).
 */
export const vaultRecoveryPendingBodySchema = vaultRecoveryProofSchema;
export type VaultRecoveryPendingBody = z.infer<typeof vaultRecoveryPendingBodySchema>;

/**
 * Corpo di `POST /api/vault/recovery/confirm/:personKeyId`: la prova (che la
 * conferma CONSUMA: una sfida per conferma) e le copie.
 */
export const vaultRecoveryConfirmBodySchema = vaultRecoveryProofSchema.extend({
  copies: z.array(vaultConfirmCopySchema).max(10_000),
});
export type VaultRecoveryConfirmBody = z.infer<typeof vaultRecoveryConfirmBodySchema>;

/**
 * Risposta di una conferma: lo stato della chiave, le credenziali passate, e
 * quelle scartate col motivo (`not_allowed`: chi conferma non poteva darla;
 * `key_changed`: la password è cambiata nel frattempo, va ricifrata;
 * `duplicate`: ripetuta nel corpo).
 */
export const vaultConfirmResponseSchema = z.object({
  personKeyId: z.uuid(),
  status: z.enum(["pending", "confirmed"]),
  saved: z.array(z.uuid()),
  skipped: z.array(
    z.object({ credentialId: z.uuid(), reason: z.enum(["not_allowed", "key_changed", "duplicate"]) }),
  ),
});
export type VaultConfirmResponse = z.infer<typeof vaultConfirmResponseSchema>;
