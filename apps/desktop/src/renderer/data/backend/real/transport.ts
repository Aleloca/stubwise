import { createStubwiseClient, type StubwiseClient } from "@stubwise/api-client";
import { endsSession } from "@stubwise/shared";

// Il trasporto della build app (integrazione area 2, fetta 1). Nel browser
// (`/app` dietro caddy) è `fetch` sulla stessa origine con il cookie di
// sessione del web; sul desktop la rete la fa il processo main, che aggiunge
// il token: qui `ipcFetch` passa da `window.stubwise.api.request` e
// ricostruisce una `Response`. Nessun token passa mai dal renderer.

type Method = StubwiseApiRequest["method"];
const METHODS: ReadonlySet<string> = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);
/** Gli stati HTTP che per specifica non hanno corpo (`new Response` li rifiuta con un corpo). */
const NULL_BODY = new Set([101, 204, 205, 304]);

/** Il corpo di una richiesta in una forma che l'IPC sa clonare, col content-type che ne deriva. */
async function serializeBody(
  body: BodyInit | null | undefined,
): Promise<{ body?: string | ArrayBuffer; contentType?: string }> {
  if (body === undefined || body === null) return {};
  if (typeof body === "string") return { body };
  // FormData, Blob, URLSearchParams, buffer: `Response` li serializza come
  // farebbe `fetch`, boundary del multipart compreso.
  const wrapped = new Response(body);
  const contentType = wrapped.headers.get("content-type") ?? undefined;
  return { body: await wrapped.arrayBuffer(), ...(contentType ? { contentType } : {}) };
}

function pathOf(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return `${input.pathname}${input.search}`;
  const url = new URL(input.url);
  return `${url.pathname}${url.search}`;
}

/** Un `fetch` che passa dal processo main del desktop (`api:request`). */
export async function ipcFetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  const bridge = window.stubwise?.api;
  if (!bridge) throw new TypeError("desktop bridge unavailable");
  const method = (init.method ?? "GET").toUpperCase();
  if (!METHODS.has(method)) throw new TypeError(`unsupported method ${method}`);
  const headers: Record<string, string> = {};
  new Headers(init.headers).forEach((value, key) => {
    headers[key] = value;
  });
  const { body, contentType } = await serializeBody(init.body);
  if (contentType && !headers["content-type"]) headers["content-type"] = contentType;
  const res = await bridge.request({
    method: method as Method,
    path: pathOf(input),
    headers,
    ...(body !== undefined ? { body } : {}),
  });
  return new Response(NULL_BODY.has(res.status) ? null : res.body, {
    status: res.status,
    headers: res.headers,
  });
}

/**
 * Il client dell'API della build app: sul desktop (c'è il ponte del preload)
 * via `ipcFetch`, nel browser via `fetch` col cookie. In entrambi i casi la
 * radice è la stessa origine (`""`) e nessuna intestazione d'autenticazione
 * parte dal renderer. `onUnauthorized` scatta quando una risposta dice che
 * la sessione è finita (`endsSession` di `@stubwise/shared`).
 */
export function createAppClient(options: { onUnauthorized?: () => void } = {}): StubwiseClient {
  const base: typeof fetch = window.stubwise?.api
    ? ipcFetch
    : (input, init) => globalThis.fetch(input, init);
  const watched: typeof fetch = async (input, init) => {
    const res = await base(input, init);
    if (res.status === 401) {
      // Solo un 401 di SESSIONE la chiude: un codice di riconferma sbagliato
      // (`invalid_second_factor`) è un 401 con la sessione viva.
      const code = await res
        .clone()
        .json()
        .then((b: { code?: unknown }) => (typeof b?.code === "string" ? b.code : undefined))
        .catch(() => undefined);
      if (endsSession(pathOf(input), res.status, code)) options.onUnauthorized?.();
    }
    return res;
  };
  if (window.stubwise?.api) {
    return createStubwiseClient({ baseUrl: "", fetch: watched, getAuthHeader: () => null });
  }
  return createStubwiseClient({
    baseUrl: "",
    fetch: watched,
    credentials: "include",
    getAuthHeader: () => null,
  });
}
