import {
  authUserResponseSchema,
  languageResponseSchema,
  mobileLoginResponseSchema,
  sessionResponseSchema,
  setupStatusSchema,
} from "@stubwise/shared";
import type {
  Reader,
  AuthUserResponse,
  Language,
  LanguageResponse,
  MobileLoginInput,
  MobileLoginResponse,
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
 * mobile, che usa {@link createAuthEndpoints.mobileLogin} per ricevere un
 * token da mettere nell'header.
 */
export function createAuthEndpoints(request: ApiRequest) {
  return {
    /** L'istanza non ha ancora un utente: la schermata di setup iniziale. */
    setupStatus(): Promise<Reader<SetupStatus>> {
      return request("GET", "/api/auth/setup", undefined, setupStatusSchema);
    },

    login(credentials: Credentials): Promise<Reader<AuthUserResponse>> {
      return request("POST", "/api/auth/login", credentials, authUserResponseSchema);
    },

    /**
     * Login dell'app mobile: nessun cookie, un PAT chiamato `Mobile ·
     * <deviceName>` da conservare nel Keychain e restituire poi da
     * `getAuthHeader`. A differenza di `login`, la risposta porta già l'utente
     * della sessione (lingua e avatar compresi): il primo render dell'app non
     * deve aspettare `me`.
     *
     * Il logout dell'app NON è `logout` qui sotto (che chiude un cookie che
     * non esiste): è la revoca di quel PAT.
     */
    mobileLogin(credentials: MobileLoginInput): Promise<Reader<MobileLoginResponse>> {
      return request("POST", "/api/auth/mobile-login", credentials, mobileLoginResponseSchema);
    },

    logout(): Promise<void> {
      return request("POST", "/api/auth/logout");
    },

    me(): Promise<Reader<SessionResponse>> {
      return request("GET", "/api/auth/me", undefined, sessionResponseSchema);
    },

    /** L'id lo ricava il server dalla sessione: si manda solo la lingua. */
    setLanguage(language: Language): Promise<Reader<LanguageResponse>> {
      return request("PATCH", "/api/auth/me", { language }, languageResponseSchema);
    },
  };
}
