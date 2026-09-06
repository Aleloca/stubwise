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
 * Caratteri vietati nel nome del device. Il nome arriva da una rotta NON
 * autenticata e finisce in `Mobile · <deviceName>`, la stringa su cui un
 * umano decide QUALE device revocare: si difende quella decisione, e solo
 * quella. Due attacchi la ingannano davvero:
 *
 * - **riordino bidirezionale** — marchi (U+200E/200F/061C), embedding e
 *   override (U+202A–202E) e isolate (U+2066–2069) fanno rendere il nome al
 *   contrario, così `Mobile · <RLO>enohPi` si legge come un altro device.
 * - **interruzione di riga** — spezza il nome su due righe nella lista, dove
 *   la seconda metà può fingersi una voce a sé. Servono sia i controlli
 *   `\p{Cc}` (LF, CR, TAB) sia U+2028/U+2029, che sono `Zl`/`Zp` e NON
 *   stanno in `Cc`.
 *
 * NON si vieta `\p{Cf}` in blocco, che è la scorciatoia sbagliata: quella
 * categoria contiene lo ZWJ (U+200D), il collante di ogni emoji composta
 * (famiglie, bandiere, mestieri: "iPhone di <emoji programmatore>" è un nome
 * normalissimo), e lo ZWNJ (U+200C), obbligatorio in persiano, urdu e hindi.
 * Vietarla rifiuterebbe nomi legittimi con un 400 incomprensibile — e in
 * cambio non coprirebbe U+2028, che è proprio un'interruzione di riga.
 *
 * Scritta con gli escape e non coi caratteri veri di proposito: sono
 * invisibili in un editor, e U+2028 è esso stesso un terminatore di riga nel
 * sorgente JS — messo letterale, spezzerebbe il literal.
 */
const DEVICE_NAME_FORBIDDEN =
  /[\p{Cc}\u2028\u2029\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/u;

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
      message: "deviceName must not contain line breaks or bidirectional formatting characters",
    }),
});
export type MobileLoginInput = z.infer<typeof mobileLoginBodySchema>;

/**
 * Risposta di `mobile-login`: il PAT in chiaro (unica volta in cui è visibile,
 * l'app lo mette nel Keychain) e l'utente della SESSIONE — non la proiezione
 * pubblica del login web. L'app mobile non ha un cookie da spendere subito
 * dopo su `/me`: lingua e avatar le servono al primo render, quindi arrivano
 * qui insieme al token.
 *
 * `patId` (Task 13, app mobile — GAP verificato e chiuso qui): l'id della
 * riga PAT appena creata, NON il token stesso. Serve al Task 20 (logout
 * dell'app), che deve revocare QUESTO PAT (`DELETE /api/pats/:id`) senza
 * dover prima elencare i token dell'utente per indovinare quale sia "Mobile
 * · <deviceName>". Aggiunta ADDITIVA (campo nuovo, nessuno rimosso o
 * rinominato): rispetta l'invariante "solo cambi additivi" verso l'app
 * mobile documentata su `ApiRequest` in `@stubwise/api-client`.
 */
export const mobileLoginResponseSchema = z.object({
  token: z.string(),
  patId: z.uuid(),
  user: sessionUserSchema,
});
export type MobileLoginResponse = z.infer<typeof mobileLoginResponseSchema>;
