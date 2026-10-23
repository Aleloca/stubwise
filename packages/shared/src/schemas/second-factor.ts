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
 * browser). Solo i campi che il server imposta: niente estensioni né hint.
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
