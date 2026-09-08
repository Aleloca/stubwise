/**
 * Flusso OAuth 2.0 di Google: autorizzazione, scambio del code, refresh,
 * revoca, `userinfo`.
 *
 * Il package NON persiste nulla e non conosce il DB: chi chiama passa client id
 * e secret già decifrati e decide cosa salvare. In particolare NESSUN access
 * token viene tenuto qui — il worker lo riottiene dal refresh token a ogni
 * ciclo e lo tiene in memoria (design §3), quindi queste funzioni restituiscono
 * i token e basta.
 */
import { z } from "zod";
import {
  buildUrl,
  parseGoogleJson,
  requestGoogle,
  type GoogleClientOptions,
} from "./fetch.js";

/** Endpoint di consenso (schermata di Google). */
export const GOOGLE_AUTHORIZE_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
/** Endpoint di scambio e refresh dei token. */
export const GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
/** Endpoint di revoca di un token (refresh o access). */
export const GOOGLE_REVOKE_ENDPOINT = "https://oauth2.googleapis.com/revoke";
/** Endpoint OpenID Connect con l'identità del titolare della casella. */
export const GOOGLE_USERINFO_ENDPOINT = "https://openidconnect.googleapis.com/v1/userinfo";

/**
 * Scope richiesti: identità + Gmail e Calendar in SOLA LETTURA. La fase 6 non
 * manda email e non scrive eventi (design §2, "Fuori (v1)"): chiedere di più
 * costerebbe una schermata di consenso più spaventosa per un potere che il
 * codice non esercita.
 */
export const GOOGLE_SCOPES = [
  "openid",
  "email",
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/calendar.readonly",
] as const;

/** Token restituiti da Google, normalizzati. */
export interface GoogleTokens {
  accessToken: string;
  expiresInSeconds: number;
  /** Presente solo nello scambio del code con `access_type=offline` + `prompt=consent`. */
  refreshToken: string | null;
  /** Scope effettivamente concessi (possono essere meno di quelli chiesti). */
  scopes: string[];
  tokenType: string;
  idToken: string | null;
}

/** Identità del titolare della casella (OpenID Connect). */
export interface GoogleUserinfo {
  sub: string;
  email: string;
  emailVerified: boolean;
  /** Dominio Workspace, quando Google lo dichiara. */
  hd: string | null;
  name: string | null;
}

const tokenResponseSchema = z.object({
  access_token: z.string(),
  expires_in: z.number().optional(),
  refresh_token: z.string().optional(),
  scope: z.string().optional(),
  token_type: z.string().optional(),
  id_token: z.string().optional(),
});

const userinfoSchema = z.object({
  sub: z.string(),
  email: z.string(),
  email_verified: z.boolean().optional(),
  hd: z.string().optional(),
  name: z.string().optional(),
});

/** Argomenti della URL di consenso. */
export interface AuthorizeUrlInput {
  clientId: string;
  /** Deve combaciare ESATTAMENTE con quello registrato in Google Cloud Console. */
  redirectUri: string;
  /** `state` firmato dal server (HMAC + nonce monouso): Google lo rimanda invariato. */
  state: string;
  scopes?: readonly string[];
  /** Dominio Workspace suggerito: precompila il selettore d'account. */
  hd?: string | null;
}

/**
 * URL della schermata di consenso.
 *
 * `access_type=offline` + `prompt=consent` sono la coppia che garantisce un
 * REFRESH TOKEN: senza `prompt=consent` Google lo manda solo la prima volta che
 * quell'utente autorizza quell'app, e un ricollegamento tornerebbe senza — che
 * è esattamente l'errore `no_refresh_token` del callback (design §3).
 */
export function buildAuthorizeUrl(input: AuthorizeUrlInput): string {
  return buildUrl(GOOGLE_AUTHORIZE_ENDPOINT, {
    client_id: input.clientId,
    redirect_uri: input.redirectUri,
    response_type: "code",
    scope: (input.scopes ?? GOOGLE_SCOPES).join(" "),
    state: input.state,
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
    hd: input.hd ?? undefined,
  });
}

/** Normalizza la risposta del token endpoint. */
function toTokens(api: string, payload: unknown): GoogleTokens {
  const raw = parseGoogleJson(api, tokenResponseSchema, payload);
  return {
    accessToken: raw.access_token,
    expiresInSeconds: raw.expires_in ?? 0,
    refreshToken: raw.refresh_token ?? null,
    scopes: raw.scope ? raw.scope.split(/\s+/).filter(Boolean) : [],
    tokenType: raw.token_type ?? "Bearer",
    idToken: raw.id_token ?? null,
  };
}

/** Argomenti dello scambio del `code` del callback. */
export interface ExchangeCodeInput {
  clientId: string;
  clientSecret: string;
  code: string;
  redirectUri: string;
}

/** Scambia il `code` del callback con access token e refresh token. */
export async function exchangeCode(input: ExchangeCodeInput, options: GoogleClientOptions = {}): Promise<GoogleTokens> {
  const api = "oauth.token.authorization_code";
  const payload = await requestGoogle(
    {
      api,
      url: GOOGLE_TOKEN_ENDPOINT,
      method: "POST",
      form: {
        grant_type: "authorization_code",
        code: input.code,
        client_id: input.clientId,
        client_secret: input.clientSecret,
        redirect_uri: input.redirectUri,
      },
    },
    options,
  );
  return toTokens(api, payload);
}

/** Argomenti del refresh. */
export interface RefreshTokenInput {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}

/**
 * Ottiene un access token nuovo dal refresh token. È la prima cosa che il
 * poller fa per ogni casella a ogni ciclo: un `invalid_grant` qui è FATALE
 * (consenso revocato o password cambiata) e disabilita la casella.
 */
export async function refreshAccessToken(
  input: RefreshTokenInput,
  options: GoogleClientOptions = {},
): Promise<GoogleTokens> {
  const api = "oauth.token.refresh_token";
  const payload = await requestGoogle(
    {
      api,
      url: GOOGLE_TOKEN_ENDPOINT,
      method: "POST",
      form: {
        grant_type: "refresh_token",
        refresh_token: input.refreshToken,
        client_id: input.clientId,
        client_secret: input.clientSecret,
      },
    },
    options,
  );
  return toTokens(api, payload);
}

/**
 * Revoca un token su Google. Il chiamante (lo scollegamento di una casella) la
 * usa best-effort: se Google risponde male la riga va cancellata lo stesso, e
 * l'errore lo decide chi chiama, non questa funzione.
 */
export async function revokeToken(input: { token: string }, options: GoogleClientOptions = {}): Promise<void> {
  await requestGoogle(
    {
      api: "oauth.revoke",
      url: GOOGLE_REVOKE_ENDPOINT,
      method: "POST",
      form: { token: input.token },
      expectEmpty: true,
    },
    options,
  );
}

/**
 * Identità del titolare del token. Serve al callback per due decisioni: quale
 * email stiamo collegando, e se il suo dominio è fra quelli del Workspace
 * (`domain_mismatch`).
 */
export async function fetchUserinfo(
  input: { accessToken: string },
  options: GoogleClientOptions = {},
): Promise<GoogleUserinfo> {
  const api = "oauth.userinfo";
  const payload = await requestGoogle(
    { api, url: GOOGLE_USERINFO_ENDPOINT, accessToken: input.accessToken },
    options,
  );
  const raw = parseGoogleJson(api, userinfoSchema, payload);
  return {
    sub: raw.sub,
    // Lowercase qui e non a valle: l'email è la chiave unique di
    // `google_accounts` e il match dei domini, e due grafie della stessa
    // casella sarebbero due righe.
    email: raw.email.toLowerCase(),
    emailVerified: raw.email_verified ?? false,
    hd: raw.hd ? raw.hd.toLowerCase() : null,
    name: raw.name ?? null,
  };
}
