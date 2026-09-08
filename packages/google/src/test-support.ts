/**
 * Fake `fetch` per i test del client Google: nessuna chiamata di rete, e ogni
 * richiesta viene REGISTRATA (url, metodo, header, body) perché è metà di ciò
 * che questi test verificano — che la URL e l'`Authorization` siano quelli
 * giusti conta quanto il parsing della risposta.
 *
 * Escluso dal build (`tsconfig.build.json`): non fa parte della superficie
 * pubblica del package.
 */
import type { FetchImpl } from "./fetch.js";

/** Una richiesta osservata dal fake, normalizzata per gli assert. */
export interface RecordedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | null;
  /** Query string già spacchettata: comoda per asserire un parametro alla volta. */
  params: URLSearchParams;
}

/** Risposta da restituire, o una funzione che la costruisce dalla richiesta. */
export type FakeResponder = Response | ((req: RecordedRequest) => Response);

/** Costruisce una `Response` JSON (200 di default). */
export function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json");
  return new Response(JSON.stringify(body), { ...init, headers });
}

/**
 * `fetch` finto che serve le risposte nell'ordine dato (l'ultima si ripete se
 * arrivano più chiamate del previsto) e tiene l'elenco delle richieste viste.
 */
export function fakeFetch(responders: FakeResponder[]): {
  impl: FetchImpl;
  calls: RecordedRequest[];
} {
  const calls: RecordedRequest[] = [];
  const impl: FetchImpl = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, key) => {
      headers[key.toLowerCase()] = value;
    });
    const rawBody = init?.body;
    const body = rawBody == null ? null : typeof rawBody === "string" ? rawBody : String(rawBody);
    const req: RecordedRequest = {
      url,
      method: (init?.method ?? "GET").toUpperCase(),
      headers,
      body,
      params: new URL(url).searchParams,
    };
    calls.push(req);
    const responder = responders[Math.min(calls.length - 1, responders.length - 1)];
    if (!responder) throw new Error("fakeFetch: nessuna risposta configurata");
    return typeof responder === "function" ? responder(req) : responder.clone();
  };
  return { impl, calls };
}

/** Codifica base64url, come fa Gmail per i body delle parti MIME. */
export function b64url(text: string): string {
  return Buffer.from(text, "utf8").toString("base64url");
}
