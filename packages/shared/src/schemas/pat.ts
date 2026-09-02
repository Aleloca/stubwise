import { z } from "zod";
import { sessionUserSchema } from "./user.js";

/**
 * Corpo di creazione di un Personal Access Token: un nome leggibile (obbligatorio)
 * e una scadenza opzionale in ISO 8601. `expiresAt` null oppure omesso = token
 * senza scadenza (vive finché non viene revocato).
 */
export const createPatSchema = z
  .object({
    name: z.string().min(1).max(100),
    expiresAt: z.iso.datetime().nullable().optional(),
  })
  .refine((v) => v.expiresAt == null || new Date(v.expiresAt).getTime() > Date.now(), {
    message: "expiresAt must be in the future",
    path: ["expiresAt"],
  });
export type CreatePatInput = z.infer<typeof createPatSchema>;

/**
 * Proiezione pubblica di un PAT per la SPA: mai il token in chiaro né l'hash.
 * Le date sono ISO string; `lastUsedAt`/`expiresAt` sono nullable.
 */
export const patViewSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  lastUsedAt: z.iso.datetime().nullable(),
  expiresAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
});
export type PatView = z.infer<typeof patViewSchema>;

/**
 * Risposta della creazione: la vista pubblica più il token in chiaro
 * (`stw_pat_…`). È l'UNICO momento in cui il token è visibile: non viene mai
 * più restituito (in DB vive solo il suo sha256).
 */
export const patWithTokenSchema = patViewSchema.extend({ token: z.string() });
export type PatWithToken = z.infer<typeof patWithTokenSchema>;

/**
 * Caratteri vietati nel nome del device: controllo (`Cc`, dove finiscono
 * newline e tab) e formattazione (`Cf`, dove sta l'override bidirezionale
 * U+202E). Il nome arriva da una rotta NON autenticata e finisce dentro una
 * stringa che l'utente legge nella lista dei token, dove deve poter
 * riconoscere il device da revocare: una newline la spezzerebbe su due righe,
 * un override bidi la farebbe leggere al contrario. Nessuna delle due è un
 * nome di device legittimo.
 */
const DEVICE_NAME_FORBIDDEN = /[\p{Cc}\p{Cf}]/u;

/**
 * Corpo di `POST /api/auth/mobile-login`: le stesse credenziali del login web
 * più il nome del device, che diventa il nome del PAT emesso.
 *
 * `deviceName` è trimmato PRIMA dei vincoli (uno spazio non è un nome) e
 * limitato a 80 caratteri, così `Mobile · <deviceName>` resta leggibile e
 * lontano dai 100 caratteri che `createPatSchema` accetta per un nome scritto
 * a mano. Sulla password non c'è la policy di lunghezza: come al login, vale
 * alla creazione dell'account, non alla verifica.
 */
export const mobileLoginBodySchema = z.object({
  email: z.email(),
  password: z.string().min(1),
  deviceName: z
    .string()
    .trim()
    .min(1)
    .max(80)
    .refine((v) => !DEVICE_NAME_FORBIDDEN.test(v), {
      message: "deviceName must not contain control or formatting characters",
    }),
});
export type MobileLoginInput = z.infer<typeof mobileLoginBodySchema>;

/**
 * Risposta di `mobile-login`: il PAT in chiaro (unica volta in cui è visibile,
 * l'app lo mette nel Keychain) e l'utente della SESSIONE — non la proiezione
 * pubblica del login web. L'app mobile non ha un cookie da spendere subito
 * dopo su `/me`: lingua e avatar le servono al primo render, quindi arrivano
 * qui insieme al token.
 */
export const mobileLoginResponseSchema = z.object({
  token: z.string(),
  user: sessionUserSchema,
});
export type MobileLoginResponse = z.infer<typeof mobileLoginResponseSchema>;
