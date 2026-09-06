import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { ApiError, createStubwiseClient } from "./index.js";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * `vi.fn` col tipo di `fetch`: senza il parametro esplicito l'implementazione a
 * zero argomenti farebbe inferire `[]` per `mock.calls`, e le asserzioni su url
 * e init non compilerebbero.
 */
function mockFetch(impl: () => Promise<Response>) {
  return vi.fn<typeof globalThis.fetch>(impl);
}

function clientWith(fetchImpl: typeof globalThis.fetch, token: string | null = null) {
  return createStubwiseClient({
    baseUrl: "https://stubwise.example",
    getAuthHeader: () => token,
    fetch: fetchImpl,
  });
}

describe("createStubwiseClient", () => {
  it("prefigge baseUrl, manda l'header di auth e valida la risposta", async () => {
    // NOTA: la forma è `{ count }`, non `{ unread }` — è `unreadCountSchema` di
    // `@stubwise/shared`, lo stesso schema che il server dichiara come risposta
    // 200 della rotta (quindi la forma sul filo non può divergere).
    const fetchImpl = mockFetch(async () => jsonResponse(200, { count: 3 }));
    const client = clientWith(fetchImpl, "Bearer stw_pat_x");

    await expect(client.inbox.unreadCount()).resolves.toEqual({ count: 3 });

    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("https://stubwise.example/api/inbox/unread-count");
    expect((init!.headers as Record<string, string>).authorization).toBe("Bearer stw_pat_x");
  });

  it("accetta un getAuthHeader asincrono e omette l'header quando è null", async () => {
    const fetchImpl = mockFetch(async () => jsonResponse(200, { count: 0 }));
    const client = createStubwiseClient({
      baseUrl: "https://stubwise.example",
      getAuthHeader: async () => null,
      fetch: fetchImpl,
    });

    await client.inbox.unreadCount();

    const [, init] = fetchImpl.mock.calls[0]!;
    expect((init!.headers as Record<string, string>).authorization).toBeUndefined();
  });

  it("normalizza baseUrl con lo slash finale senza raddoppiarlo nel path", async () => {
    const fetchImpl = mockFetch(async () => jsonResponse(200, { count: 0 }));
    const client = createStubwiseClient({
      baseUrl: "https://stubwise.example/",
      getAuthHeader: () => null,
      fetch: fetchImpl,
    });

    await client.inbox.unreadCount();

    expect(fetchImpl.mock.calls[0]![0]).toBe("https://stubwise.example/api/inbox/unread-count");
  });

  it("con baseUrl vuota (SPA same-origin) usa il path così com'è", async () => {
    const fetchImpl = mockFetch(async () => jsonResponse(200, { count: 0 }));
    const client = createStubwiseClient({
      baseUrl: "",
      credentials: "include",
      getAuthHeader: () => null,
      fetch: fetchImpl,
    });

    await client.inbox.unreadCount();

    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("/api/inbox/unread-count");
    expect(init!.credentials).toBe("include");
  });

  it("non manda `credentials` se l'opzione è assente (React Native non la usa)", async () => {
    const fetchImpl = mockFetch(async () => jsonResponse(200, { count: 0 }));
    await clientWith(fetchImpl).inbox.unreadCount();

    expect(fetchImpl.mock.calls[0]![1]!.credentials).toBeUndefined();
  });

  it("serializza il body e imposta il content-type solo quando c'è un corpo", async () => {
    const fetchImpl = mockFetch(async () => new Response(null, { status: 204 }));
    const client = clientWith(fetchImpl);

    await client.request("POST", "/api/things", { name: "x" });
    const [, withBody] = fetchImpl.mock.calls[0]!;
    expect(withBody!.body).toBe(JSON.stringify({ name: "x" }));
    expect(new Headers(withBody!.headers).get("content-type")).toBe("application/json");

    await client.request("POST", "/api/things");
    const [, withoutBody] = fetchImpl.mock.calls[1]!;
    expect(withoutBody!.body).toBeUndefined();
    expect(new Headers(withoutBody!.headers).get("content-type")).toBeNull();
  });

  it("204 risolve undefined senza leggere il corpo", async () => {
    const fetchImpl = mockFetch(async () => new Response(null, { status: 204 }));
    await expect(clientWith(fetchImpl).request("POST", "/api/x")).resolves.toBeUndefined();
  });

  it("trasforma un errore JSON in ApiError con status/code/details", async () => {
    // Il server risponde `{ code, message }` (più i dati del caso): la chiave è
    // `code`, non `error`. `details` conserva il body INTERO, che è l'unico modo
    // per far arrivare `handledBy` a `handledByFromError`.
    const body = {
      code: "already_handled",
      message: "Already handled",
      handledBy: { id: "11111111-1111-4111-8111-111111111111", email: "ada@example.com" },
    };
    const client = clientWith(async () => jsonResponse(409, body));

    await expect(
      client.inbox.act("11111111-1111-4111-8111-111111111111", "approve_plan"),
    ).rejects.toMatchObject({ status: 409, code: "already_handled", details: body });
  });

  it("su un errore non-JSON usa il messaggio di fallback e lascia code/details vuoti", async () => {
    const client = clientWith(async () => new Response("<html>502</html>", { status: 502 }));

    const error = await client.request("GET", "/api/x").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 502, message: "Error 502" });
    expect((error as ApiError).code).toBeUndefined();
    expect((error as ApiError).details).toBeUndefined();
  });

  it("normalizza il TypeError di fetch in ApiError(0, network_error) e rilancia il resto", async () => {
    const cause = new TypeError("Failed to fetch");
    const networkError = await clientWith(async () => {
      throw cause;
    })
      .request("GET", "/api/x")
      .catch((e: unknown) => e);
    expect(networkError).toBeInstanceOf(ApiError);
    expect(networkError).toMatchObject({ status: 0, code: "network_error" });
    expect((networkError as ApiError).cause).toBe(cause);

    // Un AbortError NON è un errore di rete: deve riemergere identico, così chi
    // annulla una richiesta continua a riconoscerlo.
    const abort = new DOMException("aborted", "AbortError");
    const rethrown = await clientWith(async () => {
      throw abort;
    })
      .request("GET", "/api/x")
      .catch((e: unknown) => e);
    expect(rethrown).toBe(abort);
  });

  it("con uno schema una forma inattesa è un ApiError, non una ZodError nuda", async () => {
    // Resta un BUG e fallisce forte, ma esce dal SOLO tipo d'errore del
    // trasporto: un utente non deve mai leggere "Invalid input: expected
    // number, received string". Lo status è quello vero (il server HA
    // risposto), la ZodError resta in `cause` e il body in `details`.
    const body = { count: "tre" };
    const client = clientWith(async () => jsonResponse(200, body));

    const error = await client.inbox.unreadCount().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({
      status: 200,
      code: "invalid_response",
      message: "Unexpected response shape",
      details: body,
    });
    expect((error as ApiError).cause).toBeInstanceOf(z.ZodError);
  });

  it("un getAuthHeader che lancia diventa ApiError, non un errore grezzo", async () => {
    // Sul mobile il token viene dal keychain: se non è leggibile la richiesta
    // non parte, e il chiamante deve poterlo trattare come ogni altro errore.
    const cause = new Error("keychain locked");
    const fetchImpl = mockFetch(async () => jsonResponse(200, { count: 0 }));
    const client = createStubwiseClient({
      baseUrl: "",
      getAuthHeader: () => {
        throw cause;
      },
      fetch: fetchImpl,
    });

    const error = await client.inbox.unreadCount().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 0, code: "auth_unavailable" });
    expect((error as ApiError).cause).toBe(cause);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("risolve il fetch globale a ogni chiamata, non alla costruzione", async () => {
    // REGRESSIONE: catturando `globalThis.fetch` alla costruzione, un client
    // creato all'import del modulo resta legato al fetch di ALLORA — e i test
    // della SPA, che lo sostituiscono dopo con `vi.stubGlobal`, si ritrovano le
    // richieste che partono davvero verso la rete invece che sul mock.
    const client = createStubwiseClient({ baseUrl: "", getAuthHeader: () => null });
    const stub = mockFetch(async () => jsonResponse(200, { count: 7 }));
    vi.stubGlobal("fetch", stub);
    try {
      await expect(client.inbox.unreadCount()).resolves.toEqual({ count: 7 });
      expect(stub).toHaveBeenCalledOnce();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("senza schema restituisce il JSON grezzo (è la corsia che usa la SPA)", async () => {
    const client = clientWith(async () => jsonResponse(200, { qualsiasi: "cosa" }));
    await expect(client.request("GET", "/api/x")).resolves.toEqual({ qualsiasi: "cosa" });
  });
});
