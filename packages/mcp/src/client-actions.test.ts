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
    expect(init.headers).toEqual({ authorization: "Bearer stw_pat_secret", "content-type": "application/json" });
    expect(init.body).toBe(JSON.stringify({ title: "Nuovo" }));
  });

  it("un parametro del percorso mancante: errore prima di chiamare il server", async () => {
    const fetchMock = vi.fn();
    const err = await makeClient(fetchMock).callAction(ENTRY, {}).catch((e: unknown) => e);
    expect((err as StubwiseApiError).code).toBe("missing_params");
    expect((err as StubwiseApiError).message).toContain("ticketId");
    expect(fetchMock).not.toHaveBeenCalled();
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
