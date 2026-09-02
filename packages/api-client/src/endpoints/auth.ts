import { languageSchema } from "@stubwise/shared";
import type { Language } from "@stubwise/shared";
import { z } from "zod";
import type { ApiRequest } from "../client.js";

/**
 * MIRROR di `publicUserSchema` (`apps/server/src/routes/auth.ts`).
 *
 * Non è in `@stubwise/shared` perché nasce dalle rotte di autenticazione, che
 * non hanno un dominio condiviso; ma la rotta la dichiara come schema di
 * risposta, quindi qui è ricopiata e — se un giorno divergesse — un `parse`
 * fallito lo direbbe ad alta voce invece di lasciare un tipo che mente.
 */
export const publicUserSchema = z.object({
  id: z.uuid(),
  email: z.email(),
  role: z.enum(["admin", "member"]),
});
export type PublicUser = z.infer<typeof publicUserSchema>;

/**
 * MIRROR di `sessionUserSchema` (stesso file lato server): l'utente di sessione
 * esposto da `/me`. Porta la lingua e l'identità Slack, che le rotte di
 * setup/login/registrazione NON restituiscono.
 */
export const sessionUserSchema = publicUserSchema.extend({
  language: languageSchema,
  avatarUrl: z.string().nullable(),
  slackUserId: z.string().nullable(),
});
export type SessionUser = z.infer<typeof sessionUserSchema>;

export interface Credentials {
  email: string;
  password: string;
}

const userEnvelopeSchema = z.object({ user: publicUserSchema });
const sessionEnvelopeSchema = z.object({ user: sessionUserSchema });
const setupStatusSchema = z.object({ needed: z.boolean() });
const languageEnvelopeSchema = z.object({ language: languageSchema });

/**
 * Autenticazione.
 *
 * ATTENZIONE alla differenza fra `login` e `me`: il login torna l'utente
 * PUBBLICO (id, email, ruolo) e nient'altro — non l'avatar né la lingua, che
 * arrivano solo da `/me`. Un client che volesse mostrare l'avatar subito dopo
 * il login deve fare la seconda chiamata, non sperare nel corpo della prima.
 *
 * Il login qui apre una SESSIONE a cookie: va bene alla SPA, non all'app
 * mobile, che userà `POST /api/auth/mobile-login` (rotta della fase B) per
 * ricevere un token da mettere nell'header.
 */
export function createAuthEndpoints(request: ApiRequest) {
  return {
    /** L'istanza non ha ancora un utente: la schermata di setup iniziale. */
    setupStatus(): Promise<{ needed: boolean }> {
      return request("GET", "/api/auth/setup", undefined, setupStatusSchema);
    },

    login(credentials: Credentials): Promise<{ user: PublicUser }> {
      return request("POST", "/api/auth/login", credentials, userEnvelopeSchema);
    },

    logout(): Promise<void> {
      return request("POST", "/api/auth/logout");
    },

    me(): Promise<{ user: SessionUser }> {
      return request("GET", "/api/auth/me", undefined, sessionEnvelopeSchema);
    },

    /** L'id lo ricava il server dalla sessione: si manda solo la lingua. */
    setLanguage(language: Language): Promise<{ language: Language }> {
      return request("PATCH", "/api/auth/me", { language }, languageEnvelopeSchema);
    },
  };
}
