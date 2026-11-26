import { describe, expect, it, vi } from "vitest";

import { StubwiseApiError, StubwiseClient } from "./client.js";
import type { StubwiseConfig } from "./config.js";

/**
 * Il catalogo delle azioni e la chiamata generica (lotto 0 della parità con
 * l'app, design `docs/plans/2026-11-26-mcp-parita-design.md` § 1–2).
 */
const CONFIG: StubwiseConfig = { baseUrl: "https://stubwise.example.com", token: "stw_pat_secret", projectSlug: null };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function makeClient(fetchMock: ReturnType<typeof vi.fn>) {
  return new StubwiseClient(CONFIG, { fetch: fetchMock as unknown as typeof fetch });
}

const ENTRY = {
  action: "tasks.update",
  method: "PATCH",
  path: "/api/tasks/:ticketId",
  area: "tasks",
  summary: "Modifica una task.",
  effect: "write",
  access: "project:tickets.edit",
};

describe("x-stubwise-client", () => {
  it("anche le chiamate dei tool curati dicono che arrivano da Claude Code (D4: «via Claude Code»)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ user: { id: "u1", email: "a@b.c", role: "member" } }));
    await makeClient(fetchMock).getMe();
    expect(fetchMock.mock.calls[0]![1].headers["x-stubwise-client"]).toBe("claude-code");
  });
});

describe("getCatalog", () => {
  it("legge il catalogo UNA volta per processo", async () => {
    const fetchMock = vi.fn().mockImplementation(async () => jsonResponse({ actions: [ENTRY] }));
    const client = makeClient(fetchMock);
    expect(await client.getCatalog()).toEqual([ENTRY]);
    expect(await client.getCatalog()).toEqual([ENTRY]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]![0]).toBe("https://stubwise.example.com/api/mcp/catalog");
  });

  it("un server senza catalogo (404) diventa `catalog_unavailable`, con un messaggio che dice di aggiornare", async () => {
    const client = makeClient(vi.fn().mockResolvedValue(jsonResponse({ code: "not_found", message: "Route GET:/api/mcp/catalog not found" }, 404)));
    const err = await client.getCatalog().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StubwiseApiError);
    expect((err as StubwiseApiError).code).toBe("catalog_unavailable");
    expect((err as StubwiseApiError).message).toContain("va aggiornata");
  });
});

describe("describeAction", () => {
  it.each([".", "..", "%2e%2e"])("un'azione «%s» è rifiutata senza chiamare il server (revisione D4, M5)", async (bad) => {
    const fetchMock = vi.fn();
    const err = (await makeClient(fetchMock).describeAction(bad).catch((e: unknown) => e)) as StubwiseApiError;
    expect(err.code).toBe("invalid_params");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("callAction", () => {
  it("riempie i parametri del percorso (codificati), la query con gli array ripetuti e il corpo JSON", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ ok: true }));
    const client = makeClient(fetchMock);
    const res = await client.callAction(ENTRY, {
      params: { ticketId: "a/b" },
      query: { tag: ["x", "y"], dry: true, skip: undefined },
      body: { title: "Nuovo" },
    });
    expect(res).toEqual({ status: 200, data: { ok: true } });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://stubwise.example.com/api/tasks/a%2Fb?tag=x&tag=y&dry=true");
    expect(init.method).toBe("PATCH");
    // D4 della parità MCP: ogni richiesta dice che arriva da Claude Code.
    expect(init.headers).toEqual({ authorization: "Bearer stw_pat_secret", "x-stubwise-client": "claude-code", "content-type": "application/json" });
    expect(init.body).toBe(JSON.stringify({ title: "Nuovo" }));
  });

  it("un parametro del percorso mancante: errore prima di chiamare il server", async () => {
    const fetchMock = vi.fn();
    const err = await makeClient(fetchMock).callAction(ENTRY, {}).catch((e: unknown) => e);
    expect((err as StubwiseApiError).code).toBe("missing_params");
    expect((err as StubwiseApiError).message).toContain("ticketId");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([".", "..", " .. ", "%2e%2e", "%2E", ".%2e"])("un parametro «%s» (un segmento che sale o resta) è rifiutato, senza chiamare il server", async (bad) => {
    const fetchMock = vi.fn();
    const err = (await makeClient(fetchMock)
      .callAction({ method: "GET", path: "/api/tickets/:id/comments" }, { params: { id: bad } })
      .catch((e: unknown) => e)) as StubwiseApiError;
    expect(err).toBeInstanceOf(StubwiseApiError);
    expect(err.code).toBe("invalid_params");
    // Il primo controllo, sul parametro: la difesa sull'URL ha un altro messaggio.
    expect(err.message).toContain("«.» o «..»");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("difesa: l'URL normalizzato deve restare sotto il prefisso della voce e avere i suoi segmenti", async () => {
    // Un fetch che passa da `new URL()`, come quello di Node: normalizza `..`.
    const seen: string[] = [];
    const fetchMock = vi.fn(async (url: string) => {
      seen.push(new URL(url).pathname);
      return jsonResponse({ ok: true });
    });
    const client = new StubwiseClient({ ...CONFIG, baseUrl: "https://stubwise.example.com/sw" }, { fetch: fetchMock as unknown as typeof fetch });
    // Un valore normale passa, anche con un baseUrl che ha un percorso.
    await client.callAction({ method: "GET", path: "/api/tickets/:id/comments" }, { params: { id: "t-1" } });
    expect(seen).toEqual(["/sw/api/tickets/t-1/comments"]);
    // Un percorso del catalogo che già sale (una voce sbagliata) non parte.
    const err = (await client.callAction({ method: "GET", path: "/api/tickets/../vault/status" }).catch((e: unknown) => e)) as StubwiseApiError;
    expect(err.code).toBe("invalid_params");
    expect(err.message).toContain("esce dalla voce");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("un 204 non ha corpo", async () => {
    const client = makeClient(vi.fn().mockResolvedValue(new Response(null, { status: 204 })));
    expect(await client.callAction({ method: "DELETE", path: "/api/x" })).toEqual({ status: 204, data: undefined });
  });

  it("un errore del server porta il suo code, il suo messaggio e gli altri campi (chi ha già deciso)", async () => {
    const client = makeClient(
      vi.fn().mockResolvedValue(jsonResponse({ code: "already_handled", message: "Someone already decided this proposal", decidedBy: { name: "Ada" } }, 409)),
    );
    const err = (await client.callAction({ method: "POST", path: "/api/x" }).catch((e: unknown) => e)) as StubwiseApiError;
    expect(err.status).toBe(409);
    expect(err.code).toBe("already_handled");
    expect(err.message).toBe('HTTP 409 already_handled: Someone already decided this proposal {"decidedBy":{"name":"Ada"}}');
  });

  it("i campi in più di un errore hanno un tetto", async () => {
    const client = makeClient(vi.fn().mockResolvedValue(jsonResponse({ code: "conflict", message: "no", detail: "x".repeat(10_000) }, 409)));
    const err = (await client.callAction({ method: "POST", path: "/api/x" }).catch((e: unknown) => e)) as StubwiseApiError;
    expect(err.message.length).toBeLessThan(2_200);
    expect(err.message).toContain("[…]");
  });

  it("un 403 dice il code del server, non solo «permessi insufficienti»", async () => {
    const client = makeClient(vi.fn().mockResolvedValue(jsonResponse({ code: "session_required", message: "This action requires a browser session" }, 403)));
    const err = (await client.callAction({ method: "POST", path: "/api/x" }).catch((e: unknown) => e)) as StubwiseApiError;
    expect(err.code).toBe("session_required");
    expect(err.message).toContain("browser session");
  });

  it("un 401 resta il messaggio del token", async () => {
    const client = makeClient(vi.fn().mockResolvedValue(jsonResponse({ code: "unauthorized", message: "no" }, 401)));
    const err = (await client.callAction({ method: "GET", path: "/api/x" }).catch((e: unknown) => e)) as StubwiseApiError;
    expect(err.status).toBe(401);
    expect(err.message).toContain("STUBWISE_TOKEN");
  });
});
