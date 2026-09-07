/**
 * Trasporto del client Google: `fetch` INIETTABILE, timeout, e la traduzione di
 * ogni esito storto in un {@link GoogleApiError}.
 *
 * `fetch` è un parametro (`options.fetchImpl`) e non l'import globale per la
 * stessa ragione di `@stubwise/notifications/slack-client`: i test devono poter
 * verificare URL, header e body senza toccare la rete, e un client che chiama
 * il `fetch` globale non è testabile senza monkey-patch globali.
 *
 * Questo modulo NON conosce Gmail né Calendar: sa solo fare una richiesta,
 * classificarne l'errore e restituire JSON grezzo. La forma delle risposte la
 * decidono `oauth.ts`, `gmail.ts` e `calendar.ts` con Zod.
 */
import type { ZodType } from "zod";
import { GoogleApiError } from "./errors.js";

/** Implementazione di fetch iniettabile (default: il fetch globale di Node 22). */
export type FetchImpl = typeof fetch;

/** Timeout di default di una chiamata a Google. */
export const DEFAULT_TIMEOUT_MS = 20_000;

/** Opzioni comuni a ogni funzione di rete del package. */
export interface GoogleClientOptions {
  /** `fetch` da usare: i test passano un fake, la produzione lascia il default. */
  fetchImpl?: FetchImpl;
  /** Timeout in ms della singola richiesta (default {@link DEFAULT_TIMEOUT_MS}). */
  timeoutMs?: number;
}

/**
 * Legge `Retry-After` nelle DUE forme ammesse dallo standard: secondi interi
 * (`7`) e data HTTP (`Wed, 21 Oct 2026 07:28:00 GMT`). Google manda l'una o
 * l'altra a seconda dell'endpoint, e leggerne una sola significa buttare via il
 * suggerimento nella metà dei casi.
 *
 * Non torna mai negativo: una data già passata vale "riprova subito".
 */
export function parseRetryAfterMs(header: string | null | undefined, nowMs: number = Date.now()): number | undefined {
  if (!header) return undefined;
  const raw = header.trim();
  if (!raw) return undefined;
  if (/^\d+$/.test(raw)) return Number(raw) * 1000;
  const at = Date.parse(raw);
  if (Number.isNaN(at)) return undefined;
  return Math.max(0, at - nowMs);
}

/**
 * `fetch` con timeout. Gli errori che non hanno mai visto una risposta HTTP —
 * rete giù, DNS, timeout — diventano {@link GoogleApiError} con `status: 0`, così
 * il chiamante ha UN solo tipo d'errore da classificare invece di due.
 */
export async function fetchWithTimeout(
  url: string,
  init: RequestInit = {},
  options: GoogleClientOptions = {},
): Promise<Response> {
  const impl = options.fetchImpl ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  try {
    return await impl(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    const name = error instanceof Error ? error.name : "";
    const timedOut = name === "TimeoutError" || name === "AbortError";
    throw new GoogleApiError({
      api: url,
      status: 0,
      code: timedOut ? "timeout" : "network_error",
      reason: error instanceof Error ? error.message : String(error),
    });
  }
}

/** Valori ammessi in una query string: gli `undefined`/`null` spariscono, gli array ripetono la chiave. */
export type QueryValue = string | number | boolean | string[] | undefined | null;

/** Compone una URL con la query, saltando i parametri assenti. */
export function buildUrl(base: string, params: Record<string, QueryValue> = {}): string {
  const url = new URL(base);
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      for (const item of value) url.searchParams.append(key, item);
    } else {
      url.searchParams.set(key, String(value));
    }
  }
  return url.toString();
}

/** Descrizione di una richiesta a Google, indipendente dall'endpoint. */
export interface GoogleRequestSpec {
  /** Endpoint logico, per messaggi e log: `oauth.token`, `gmail.history.list`, … */
  api: string;
  url: string;
  method?: "GET" | "POST";
  /** Bearer token da mettere in `Authorization`. */
  accessToken?: string;
  /** Corpo `application/x-www-form-urlencoded` (gli endpoint OAuth vogliono questo, non JSON). */
  form?: Record<string, string>;
  /**
   * Rimappa il `code` di certi status HTTP. È il modo in cui Gmail dichiara che
   * un 404 su `history.list` è `history_expired` e Calendar che un 410 su
   * `events.list` è `sync_token_expired`: la stessa risposta HTTP significa
   * cose diverse a seconda di dove arriva, e solo il chiamante lo sa.
   */
  statusCodes?: Record<number, string>;
  /** True se la risposta non ha corpo JSON (es. `revoke`). */
  expectEmpty?: boolean;
}

/** Esegue la richiesta e restituisce il JSON grezzo (o `null` se `expectEmpty`). */
export async function requestGoogle(spec: GoogleRequestSpec, options: GoogleClientOptions = {}): Promise<unknown> {
  const headers: Record<string, string> = { accept: "application/json" };
  if (spec.accessToken) headers.authorization = `Bearer ${spec.accessToken}`;
  const init: RequestInit = { method: spec.method ?? "GET", headers };
  if (spec.form) {
    headers["content-type"] = "application/x-www-form-urlencoded";
    init.body = new URLSearchParams(spec.form).toString();
  }

  let response: Response;
  try {
    response = await fetchWithTimeout(spec.url, init, options);
  } catch (error) {
    // `fetchWithTimeout` mette la URL come `api`: qui sappiamo il nome logico.
    if (error instanceof GoogleApiError && error.status === 0) {
      throw new GoogleApiError({ api: spec.api, status: 0, code: error.code, reason: error.reason });
    }
    throw error;
  }

  if (!response.ok) throw await errorFromResponse(response, spec);
  if (spec.expectEmpty) return null;

  const text = await response.text();
  if (!text.trim()) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new GoogleApiError({
      api: spec.api,
      status: response.status,
      code: "invalid_response",
      reason: "risposta non JSON",
    });
  }
}

/** Valida il JSON con lo schema del chiamante; una forma inattesa è un errore tipizzato, non un crash. */
export function parseGoogleJson<T>(api: string, schema: ZodType<T>, payload: unknown): T {
  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    throw new GoogleApiError({
      api,
      status: 200,
      code: "invalid_response",
      reason: parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; "),
    });
  }
  return parsed.data;
}

/**
 * Alias dal vocabolario di Google al nostro. A sinistra ciò che Google scrive
 * (`error` degli endpoint OAuth, `errors[].reason` delle API), a destra il
 * codice su cui `isFatalGoogleError` e il backoff decidono.
 */
const CODE_ALIASES: Record<string, string> = {
  // Scope: la stessa cosa detta in tre modi diversi a seconda dell'endpoint.
  insufficientPermissions: "insufficient_scope",
  insufficientScope: "insufficient_scope",
  ACCESS_TOKEN_SCOPE_INSUFFICIENT: "insufficient_scope",
  // ⚠️ `forbidden` nudo NON sta qui: un 403 generico di Gmail è spesso quota o
  // un divieto temporaneo, e mapparlo su `insufficient_scope` spegnerebbe la
  // casella per un errore transitorio. Resta `forbidden` → backoff.
  // Quote e rate limit.
  rateLimitExceeded: "rate_limited",
  userRateLimitExceeded: "rate_limited",
  RESOURCE_EXHAUSTED: "rate_limited",
  rate_limit_exceeded: "rate_limited",
  quotaExceeded: "rate_limited",
  // Credenziali.
  authError: "invalid_credentials",
  UNAUTHENTICATED: "invalid_credentials",
};

/** Codice di ripiego quando Google non dice nulla di più preciso dello status. */
function codeForStatus(status: number): string {
  if (status === 401) return "unauthorized";
  if (status === 403) return "forbidden";
  if (status === 404) return "not_found";
  if (status === 409) return "conflict";
  if (status === 410) return "gone";
  if (status === 429) return "rate_limited";
  if (status >= 500) return "server_error";
  return `http_${status}`;
}

/** Estrae il `reason` grezzo dalle due forme di errore che Google usa (OAuth e API). */
function reasonFromBody(body: unknown, status: number): string {
  if (typeof body === "object" && body !== null && "error" in body) {
    const error = (body as { error: unknown }).error;
    if (typeof error === "string") return error;
    if (typeof error === "object" && error !== null) {
      const details = error as { errors?: { reason?: unknown }[]; status?: unknown; message?: unknown };
      const first = details.errors?.[0]?.reason;
      if (typeof first === "string" && first) return first;
      if (typeof details.status === "string" && details.status) return details.status;
      if (typeof details.message === "string" && details.message) return details.message;
    }
  }
  return codeForStatus(status);
}

/** Costruisce l'errore da una risposta HTTP non ok, leggendo `Retry-After` se c'è. */
async function errorFromResponse(response: Response, spec: GoogleRequestSpec): Promise<GoogleApiError> {
  let body: unknown = null;
  try {
    const text = await response.text();
    body = text.trim() ? (JSON.parse(text) as unknown) : null;
  } catch {
    body = null;
  }
  const reason = reasonFromBody(body, response.status);
  const override = spec.statusCodes?.[response.status];
  const code = override ?? CODE_ALIASES[reason] ?? (FATAL_LITERALS.has(reason) ? reason : codeForStatus(response.status));
  const retryAfterMs = parseRetryAfterMs(response.headers.get("retry-after"));
  return new GoogleApiError({
    api: spec.api,
    status: response.status,
    code,
    reason,
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
  });
}

/**
 * Codici che Google manda già nella nostra forma (gli endpoint OAuth rispondono
 * `{"error":"invalid_grant"}`): passano dritti, senza alias.
 */
const FATAL_LITERALS = new Set(["invalid_grant", "unauthorized_client", "access_denied", "insufficient_scope"]);
