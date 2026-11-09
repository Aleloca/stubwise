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

describe("gruppi dell'integrazione area 2 (task, decisioni, reparti, persone, stati)", () => {
  const VIEW = {
    id: "0b1e6f3a-1111-4222-8333-444455556666",
    ticketId: "0b1e6f3a-1111-4222-8333-444455556666",
    number: 1,
    code: "AUD-1",
    projectId: "1c2d3e4f-1111-4222-8333-444455556666",
    title: "t",
    description: "",
    statusId: "2d3e4f5a-1111-4222-8333-444455556666",
    departmentId: "3e4f5a6b-1111-4222-8333-444455556666",
    assigneeId: null,
    createdById: null,
    size: null,
    milestoneId: null,
    type: "bug",
    priority: "medium",
    createdAt: "2026-11-01T00:00:00.000Z",
    closedAt: null,
    lastActivityAt: "2026-11-01T00:00:00.000Z",
  };

  it("tasks.list: path, query con gli array separati da virgola e il periodo appiattito", async () => {
    const fetchImpl = mockFetch(async () => jsonResponse(200, { items: [VIEW], truncated: false }));
    const client = clientWith(fetchImpl);
    const page = await client.tasks.list({
      families: ["todo"],
      sizes: ["XS", "none"],
      stalled: true,
      period: { field: "due", kind: "relative", preset: "thisWeek" },
    });
    expect(page.items[0]!.code).toBe("AUD-1");
    // I default dello schema condiviso girano: slipCount e plannedWeek arrivano anche se il server non li manda.
    expect(page.items[0]!.slipCount).toBe(0);
    const [url, init] = fetchImpl.mock.calls[0]!;
    const parsed = new URL(url as string);
    expect(parsed.pathname).toBe("/api/tasks");
    expect(Object.fromEntries(parsed.searchParams)).toEqual({
      families: "todo",
      sizes: "XS,none",
      stalled: "true",
      periodField: "due",
      periodPreset: "thisWeek",
    });
    expect(init!.method).toBe("GET");
  });

  it("tasks.bulkUpdate: PATCH /api/tasks/bulk con ids e patch nel corpo", async () => {
    const fetchImpl = mockFetch(async () => jsonResponse(200, [VIEW]));
    const client = clientWith(fetchImpl);
    await client.tasks.bulkUpdate(["a", "b"], { size: "S" });
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("https://stubwise.example/api/tasks/bulk");
    expect(init!.method).toBe("PATCH");
    expect(JSON.parse(init!.body as string)).toEqual({ ids: ["a", "b"], patch: { size: "S" } });
  });

  it("pianificazione: tasks.plan, tasks.setDay, me.dayArrangements e plannedWeek in bulk e nei filtri", async () => {
    const calls: [string, string, unknown][] = [];
    const fetchImpl = vi.fn<typeof globalThis.fetch>(async (url, init) => {
      calls.push([init!.method!, url as string, init!.body ? JSON.parse(init!.body as string) : undefined]);
      const path = new URL(url as string).pathname;
      if (path.endsWith("/plan")) return jsonResponse(200, { ...VIEW, plannedWeek: "2026-W47", canPlan: true });
      if (path.endsWith("/day")) return jsonResponse(200, { taskId: VIEW.id, week: "2026-W47", day: 2 });
      if (path === "/api/me/day-arrangements") return jsonResponse(200, [{ taskId: VIEW.id, week: "2026-W47", day: null }]);
      if (path === "/api/tasks") return jsonResponse(200, { items: [VIEW], truncated: false });
      return jsonResponse(200, [VIEW]);
    });
    const c = clientWith(fetchImpl);
    const base = "https://stubwise.example";
    const planned = await c.tasks.plan("t1", { assigneeId: "u1", week: "2026-W47" });
    expect(planned.plannedWeek).toBe("2026-W47");
    expect(planned.canPlan).toBe(true);
    expect(await c.tasks.setDay("t1", { week: "2026-W47", day: 2 })).toEqual({ taskId: VIEW.id, week: "2026-W47", day: 2 });
    expect(await c.me.dayArrangements("2026-W47")).toEqual([{ taskId: VIEW.id, week: "2026-W47", day: null }]);
    await c.tasks.bulkUpdate(["a"], { plannedWeek: "2026-W48" });
    await c.tasks.list({ period: { field: "plannedWeek", kind: "relative", preset: "nextWeek" } });
    expect(calls).toEqual([
      ["POST", `${base}/api/tasks/t1/plan`, { assigneeId: "u1", week: "2026-W47" }],
      ["PUT", `${base}/api/tasks/t1/day`, { week: "2026-W47", day: 2 }],
      ["GET", `${base}/api/me/day-arrangements?week=2026-W47`, undefined],
      ["PATCH", `${base}/api/tasks/bulk`, { ids: ["a"], patch: { plannedWeek: "2026-W48" } }],
      ["GET", `${base}/api/tasks?periodField=plannedWeek&periodPreset=nextWeek`, undefined],
    ]);
  });

  it("filtri salvati: filters.* e i fissati", async () => {
    const FILTER = {
      id: "00000000-0000-4000-8000-000000000001",
      name: "Open",
      ownerId: null,
      visibility: "public",
      criteria: { families: ["todo", "active"] },
      view: "list",
      groupBy: "status",
      createdAt: "2026-11-09T00:00:00.000Z",
      updatedAt: "2026-11-09T00:00:00.000Z",
    };
    const calls: [string, string, unknown][] = [];
    const fetchImpl = vi.fn<typeof globalThis.fetch>(async (url, init) => {
      calls.push([init!.method!, url as string, init!.body ? JSON.parse(init!.body as string) : undefined]);
      const path = new URL(url as string).pathname;
      if (init!.method === "DELETE" || init!.method === "PUT") return new Response(null, { status: 204 });
      if (path === "/api/me/pinned-filters") return jsonResponse(200, [FILTER.id]);
      if (path === "/api/filters" && init!.method === "GET") return jsonResponse(200, [FILTER]);
      return jsonResponse(init!.method === "POST" ? 201 : 200, FILTER);
    });
    const c = clientWith(fetchImpl);
    const base = "https://stubwise.example";
    const [listed] = await c.filters.list();
    // canEdit assente da un server più vecchio: false, non undefined.
    expect(listed!.canEdit).toBe(false);
    expect((await c.filters.get(FILTER.id)).name).toBe("Open");
    const body = { name: "Mie", visibility: "private" as const, criteria: { stalled: true }, view: "board" as const, groupBy: "none" as const };
    await c.filters.create(body);
    await c.filters.update(FILTER.id, { name: "Rinominato" });
    await c.filters.remove(FILTER.id);
    expect(await c.filters.pinned()).toEqual([FILTER.id]);
    await c.filters.pin(FILTER.id);
    await c.filters.unpin(FILTER.id);
    expect(calls).toEqual([
      ["GET", `${base}/api/filters`, undefined],
      ["GET", `${base}/api/filters/${FILTER.id}`, undefined],
      ["POST", `${base}/api/filters`, body],
      ["PATCH", `${base}/api/filters/${FILTER.id}`, { name: "Rinominato" }],
      ["DELETE", `${base}/api/filters/${FILTER.id}`, undefined],
      ["GET", `${base}/api/me/pinned-filters`, undefined],
      ["PUT", `${base}/api/me/pinned-filters/${FILTER.id}`, undefined],
      ["DELETE", `${base}/api/me/pinned-filters/${FILTER.id}`, undefined],
    ]);
  });

  it("departments.remove: DELETE con moveTasksTo in query", async () => {
    const fetchImpl = mockFetch(async () => new Response(null, { status: 204 }));
    const client = clientWith(fetchImpl);
    await client.departments.remove("d-1", "x");
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("https://stubwise.example/api/departments/d-1?moveTasksTo=x");
    expect(init!.method).toBe("DELETE");
  });

  it("i path degli altri gruppi", async () => {
    const calls: [string, string][] = [];
    const fetchImpl = vi.fn<typeof globalThis.fetch>(async (url, init) => {
      calls.push([init!.method!, url as string]);
      return new Response(null, { status: 204 });
    });
    const c = clientWith(fetchImpl);
    const base = "https://stubwise.example";
    // Le risposte 204 non hanno corpo: per questi bastano metodo e path.
    await c.tasks.follow("t1");
    await c.tasks.unfollow("t1");
    expect(calls).toEqual([
      ["PUT", `${base}/api/tasks/t1/follow`],
      ["DELETE", `${base}/api/tasks/t1/follow`],
    ]);
  });
});

describe("login del desktop dal browser", () => {
  it("desktopHandoff e desktopExchange: path, metodo e corpo", async () => {
    const calls: [string, string, unknown][] = [];
    const fetchImpl = vi.fn<typeof globalThis.fetch>(async (url, init) => {
      calls.push([init!.method!, url as string, JSON.parse(init!.body as string)]);
      return (url as string).endsWith("desktop-handoff")
        ? jsonResponse(200, { code: "c" })
        : jsonResponse(200, {
            token: "stw_pat_x",
            patId: "0b1e6f3a-1111-4222-8333-444455556666",
            user: { id: "0b1e6f3a-1111-4222-8333-444455556666", email: "a@b.it", role: "member", language: "it", avatarUrl: null, slackUserId: null },
          });
    });
    const c = clientWith(fetchImpl);
    expect(await c.auth.desktopHandoff({ codeChallenge: "x".repeat(43), deviceName: "Mac" })).toEqual({ code: "c" });
    const exchanged = await c.auth.desktopExchange({ code: "c", codeVerifier: "v".repeat(43), deviceName: "Mac" });
    expect(exchanged.token).toBe("stw_pat_x");
    expect(calls.map(([m, u]) => [m, u])).toEqual([
      ["POST", "https://stubwise.example/api/auth/desktop-handoff"],
      ["POST", "https://stubwise.example/api/auth/desktop-exchange"],
    ]);
    expect(calls[1]![2]).toEqual({ code: "c", codeVerifier: "v".repeat(43), deviceName: "Mac" });
  });
});
