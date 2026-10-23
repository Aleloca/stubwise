import { z } from "zod";
import { publicUserSchema } from "./user.js";

/**
 * Stadio di un login a metà (password giusta, secondo fattore da fare):
 *
 * - `second_factor`: l'utente ha un'app configurata, deve dare un codice;
 * - `enrollment`: non ha ancora un secondo fattore e deve configurarlo prima
 *   di entrare.
 */
export const partialLoginStageSchema = z.enum(["second_factor", "enrollment"]);
export type PartialLoginStage = z.infer<typeof partialLoginStageSchema>;

/**
 * Risposta di `POST /api/auth/login` dal login a due passi: la busta di
 * sempre (`{ user }`) più lo stadio in cui la password lascia la sessione.
 * Il login web non apre MAI una sessione completa da solo: `stage` dice quale
 * schermata mostrare dopo.
 */
export const loginResponseSchema = z.object({
  user: publicUserSchema,
  stage: partialLoginStageSchema,
});
export type LoginResponse = z.infer<typeof loginResponseSchema>;

/**
 * Risposta di `GET /api/auth/second-factor`: cosa può fare chi è a metà
 * login. `backupCodesRemaining` è un numero, mai i codici; `lockedUntil` è
 * non nullo finché il passo è bloccato per troppi codici sbagliati.
 */
export const secondFactorStatusSchema = z.object({
  stage: partialLoginStageSchema,
  passkeys: z.boolean(),
  backupCodesRemaining: z.number().int().nonnegative(),
  lockedUntil: z.iso.datetime().nullable(),
});
export type SecondFactorStatus = z.infer<typeof secondFactorStatusSchema>;

/**
 * Corpo di `/verify` e `/enroll/confirm`: un codice TOTP (6 cifre) o, solo su
 * `/verify`, un codice di riserva. Tetto di lunghezza largo ma finito: un
 * codice di riserva è di 11 caratteri, con spazi intorno qualcuno in più.
 */
export const secondFactorCodeBodySchema = z.object({
  code: z.string().trim().min(1).max(64),
});
export type SecondFactorCodeBody = z.infer<typeof secondFactorCodeBodySchema>;

/** Risposta di `POST /api/auth/second-factor/verify`: login completo. */
export const secondFactorVerifyResponseSchema = z.object({
  user: publicUserSchema,
  backupCodesRemaining: z.number().int().nonnegative(),
});
export type SecondFactorVerifyResponse = z.infer<typeof secondFactorVerifyResponseSchema>;

/**
 * Risposta di `POST /api/auth/second-factor/enroll`: il segreto in chiaro (per
 * l'inserimento a mano) e l'URL `otpauth://` da cui la web disegna il QR.
 * Esce una volta sola, a chi sta configurando: mai in log o elenchi.
 */
export const totpEnrollmentResponseSchema = z.object({
  secret: z.string(),
  otpauthUrl: z.string(),
});
export type TotpEnrollmentResponse = z.infer<typeof totpEnrollmentResponseSchema>;

/**
 * Risposta di `POST /api/auth/second-factor/enroll/confirm`: login completo e
 * i codici di riserva in chiaro, mostrati UNA volta (nel DB solo gli hash).
 */
export const enrollConfirmResponseSchema = z.object({
  user: publicUserSchema,
  backupCodes: z.array(z.string()),
});
export type EnrollConfirmResponse = z.infer<typeof enrollConfirmResponseSchema>;

/**
 * Risposta di `POST /api/auth/second-factor/passkey/options`: le opzioni per
 * `navigator.credentials.get()` (il JSON di WebAuthn che la web passa al
 * browser). Solo i campi che il server imposta. L'unica estensione è la PRF
 * della cassaforte (`purpose: "vault"`): `eval.first` in base64url, come nella
 * forma JSON di WebAuthn — il client la riconverte in byte prima di
 * `navigator.credentials.get()`.
 */
export const passkeyAuthenticationOptionsSchema = z.object({
  challenge: z.string(),
  timeout: z.number().optional(),
  rpId: z.string().optional(),
  allowCredentials: z
    .array(
      z.object({
        id: z.string(),
        type: z.string(),
        transports: z.array(z.string()).optional(),
      }),
    )
    .optional(),
  userVerification: z.enum(["required", "preferred", "discouraged"]).optional(),
  extensions: z
    .object({ prf: z.object({ eval: z.object({ first: z.string() }) }) })
    .optional(),
});
export type PasskeyAuthenticationOptions = z.infer<typeof passkeyAuthenticationOptionsSchema>;

/**
 * Corpo di `POST /api/auth/second-factor/passkey/verify`: la risposta del
 * browser a `navigator.credentials.get()` in JSON. La forma fine la verifica
 * il server con la firma; qui solo il minimo per riconoscerla.
 */
export const passkeyVerifyBodySchema = z.object({
  response: z.looseObject({
    id: z.string().min(1).max(1024),
    rawId: z.string().min(1).max(1024),
    type: z.literal("public-key"),
    response: z.looseObject({
      clientDataJSON: z.string().max(8192),
      authenticatorData: z.string().max(8192),
      signature: z.string().max(1024),
    }),
  }),
});
export type PasskeyVerifyBody = z.infer<typeof passkeyVerifyBodySchema>;

/**
 * Risposta di `POST /api/me/security/totp/setup/confirm`. `backupCodes`: i
 * dieci codici di riserva in chiaro, mostrati UNA volta, solo a chi
 * configurava la PRIMA app (sessione di prima del rilascio); `null` quando
 * era la «riconfigura app», che lascia i codici com'erano.
 */
export const totpSetupConfirmResponseSchema = z.object({
  backupCodes: z.array(z.string()).nullable(),
});
export type TotpSetupConfirmResponse = z.infer<typeof totpSetupConfirmResponseSchema>;

/**
 * Tipi di riga del registro di sicurezza (`security_events.kind`). La
 * colonna è testo: l'elenco chiuso vive qui, e il server scrive solo questi.
 */
export const securityEventKindSchema = z.enum([
  "login",
  "enrolled",
  "totp_reconfigured",
  "passkey_added",
  "passkey_removed",
  "backup_codes_regenerated",
  "backup_code_used",
  "locked",
  "second_factor_reset",
  "password_reset_link",
  "vault_key_created",
  "vault_recovery_used",
]);
export type SecurityEventKind = z.infer<typeof securityEventKindSchema>;

/**
 * Una riga del registro di sicurezza come la legge chi guarda: l'interessato
 * (Impostazioni → Sicurezza) o chi gestisce gli utenti (scheda dell'utente).
 * `actorEmail` è chi ha agito quando non è l'interessato stesso (un admin, o
 * «server script» per lo script di recupero); `null` altrimenti.
 */
export const securityEventViewSchema = z.object({
  id: z.uuid(),
  kind: securityEventKindSchema,
  actorEmail: z.string().nullable(),
  createdAt: z.iso.datetime(),
});
export type SecurityEventView = z.infer<typeof securityEventViewSchema>;

/** Una passkey registrata: solo i metadati, mai chiave o id della credenziale. */
export const passkeyViewSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  createdAt: z.iso.datetime(),
  lastUsedAt: z.iso.datetime().nullable(),
});
export type PasskeyView = z.infer<typeof passkeyViewSchema>;

/**
 * Risposta di `GET /api/me/security`: lo stato del proprio secondo fattore.
 * Dei codici di riserva solo quanti ne restano, mai i codici; del TOTP solo
 * se c'è e da quando, mai il segreto.
 */
export const accountSecurityResponseSchema = z.object({
  totp: z.object({
    configured: z.boolean(),
    confirmedAt: z.iso.datetime().nullable(),
  }),
  passkeys: z.array(passkeyViewSchema),
  backupCodesRemaining: z.number().int().nonnegative(),
  events: z.array(securityEventViewSchema),
});
export type AccountSecurityResponse = z.infer<typeof accountSecurityResponseSchema>;

/** Risposta di `GET /api/users/:id/security-events`. */
export const securityEventsResponseSchema = z.object({
  events: z.array(securityEventViewSchema),
});
export type SecurityEventsResponse = z.infer<typeof securityEventsResponseSchema>;

/**
 * Risposta di `POST /api/me/security/backup-codes`: i dieci codici nuovi in
 * chiaro, mostrati UNA volta (nel DB solo gli hash); i precedenti non valgono
 * più.
 */
export const backupCodesResponseSchema = z.object({
  codes: z.array(z.string()),
});
export type BackupCodesResponse = z.infer<typeof backupCodesResponseSchema>;

/**
 * Risposta di `POST /api/me/security/passkeys/options`: le opzioni per
 * `navigator.credentials.create()` (il JSON di WebAuthn che la web passa al
 * browser). Tutti i campi che il server può impostare: uno non elencato qui
 * sparirebbe dalla risposta.
 */
export const passkeyRegistrationOptionsSchema = z.object({
  challenge: z.string(),
  rp: z.object({ name: z.string(), id: z.string().optional() }),
  user: z.object({ id: z.string(), name: z.string(), displayName: z.string() }),
  pubKeyCredParams: z.array(z.object({ type: z.string(), alg: z.number() })),
  timeout: z.number().optional(),
  excludeCredentials: z
    .array(
      z.object({
        id: z.string(),
        type: z.string(),
        transports: z.array(z.string()).optional(),
      }),
    )
    .optional(),
  authenticatorSelection: z
    .object({
      authenticatorAttachment: z.string().optional(),
      requireResidentKey: z.boolean().optional(),
      residentKey: z.string().optional(),
      userVerification: z.string().optional(),
    })
    .optional(),
  hints: z.array(z.string()).optional(),
  attestation: z.string().optional(),
  attestationFormats: z.array(z.string()).optional(),
  // `prf: {}` la chiede il server (cassaforte: la passkey deve poter dare un
  // segreto PRF); `credProps` lo aggiunge la libreria.
  extensions: z
    .object({ credProps: z.boolean().optional(), prf: z.object({}).optional() })
    .optional(),
});
export type PasskeyRegistrationOptions = z.infer<typeof passkeyRegistrationOptionsSchema>;

/** Nome di una passkey, scelto da chi la registra («Portatile», «YubiKey»). */
const passkeyNameSchema = z.string().trim().min(1).max(100);

/**
 * Corpo di `POST /api/me/security/passkeys`: il nome e la risposta del
 * browser a `navigator.credentials.create()` in JSON. La forma fine la
 * verifica il server; qui solo il minimo per riconoscerla.
 */
export const passkeyRegisterBodySchema = z.object({
  name: passkeyNameSchema,
  response: z.looseObject({
    id: z.string().min(1).max(1024),
    rawId: z.string().min(1).max(1024),
    type: z.literal("public-key"),
    response: z.looseObject({
      clientDataJSON: z.string().max(8192),
      attestationObject: z.string().max(65536),
    }),
  }),
});
export type PasskeyRegisterBody = z.infer<typeof passkeyRegisterBodySchema>;

/** Corpo di `PATCH /api/me/security/passkeys/:id`. */
export const passkeyRenameBodySchema = z.object({ name: passkeyNameSchema });
export type PasskeyRenameBody = z.infer<typeof passkeyRenameBodySchema>;
