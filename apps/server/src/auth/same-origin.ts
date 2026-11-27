/**
 * M5 (indurimento): una SCRITTURA autenticata col cookie di sessione deve
 * venire dalla stessa origine. Il cookie è `SameSite=Lax`, che ferma un POST
 * da un altro SITO ma non da un altro sottodominio dello STESSO sito
 * (`same-site`): un'altra app sotto lo stesso dominio, o una sua pagina
 * compromessa, potrebbe scrivere a nome di chi ha la sessione aperta.
 *
 * La regola, nell'ordine:
 * - le letture (GET, HEAD, OPTIONS) non si guardano;
 * - `Sec-Fetch-Site` (ogni browser attuale lo manda, e una pagina non lo può
 *   falsificare): passa solo `same-origin` o `none` (una navigazione
 *   dell'utente); `same-site` e `cross-site` no;
 * - senza `Sec-Fetch-Site`, decide `Origin`: deve avere lo stesso host della
 *   richiesta (`X-Forwarded-Host` dietro caddy, poi `Host`); `null` no;
 * - senza nessuno dei due è un client che non è un browser: passa.
 *
 * Il PAT (app mobile, desktop, MCP) non passa di qui: non porta un cookie, e
 * chi lo usa non è un browser che un'altra pagina può ingannare.
 */
export interface OriginRequest {
  method: string;
  headers: Record<string, string | string[] | undefined>;
}

const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

function header(request: OriginRequest, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

export function isCrossOriginWrite(request: OriginRequest): boolean {
  if (READ_METHODS.has(request.method.toUpperCase())) return false;
  const site = header(request, "sec-fetch-site")?.toLowerCase();
  if (site !== undefined) return site !== "same-origin" && site !== "none";
  const origin = header(request, "origin");
  if (origin === undefined) return false;
  const host = (header(request, "x-forwarded-host") ?? header(request, "host"))?.split(",")[0]?.trim().toLowerCase();
  try {
    return origin === "null" || !host || new URL(origin).host.toLowerCase() !== host;
  } catch {
    return true;
  }
}
