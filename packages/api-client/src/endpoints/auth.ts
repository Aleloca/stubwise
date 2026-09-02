import {
  authUserResponseSchema,
  languageResponseSchema,
  sessionResponseSchema,
  setupStatusSchema,
} from "@stubwise/shared";
import type {
  AuthUserResponse,
  Language,
  LanguageResponse,
  SessionResponse,
  SetupStatus,
} from "@stubwise/shared";
import type { ApiRequest } from "../client.js";

export interface Credentials {
  email: string;
  password: string;
}

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
    setupStatus(): Promise<SetupStatus> {
      return request("GET", "/api/auth/setup", undefined, setupStatusSchema);
    },

    login(credentials: Credentials): Promise<AuthUserResponse> {
      return request("POST", "/api/auth/login", credentials, authUserResponseSchema);
    },

    logout(): Promise<void> {
      return request("POST", "/api/auth/logout");
    },

    me(): Promise<SessionResponse> {
      return request("GET", "/api/auth/me", undefined, sessionResponseSchema);
    },

    /** L'id lo ricava il server dalla sessione: si manda solo la lingua. */
    setLanguage(language: Language): Promise<LanguageResponse> {
      return request("PATCH", "/api/auth/me", { language }, languageResponseSchema);
    },
  };
}
