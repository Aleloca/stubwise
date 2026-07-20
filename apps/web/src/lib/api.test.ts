import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  acceptSuggested,
  api,
  ApiError,
  convertBacklogItem,
  createServer,
  createServerCheck,
  dismissSuggested,
  getBacklogItem,
  getMe,
  getServerMetrics,
  getSetupStatus,
  listBacklogItems,
  listServers,
  listTickets,
  mergeBacklogItem,
  patchBacklogItem,
  postBacklogItem,
  postLogin,
  postLogout,
  postSetup,
  refreshBacklogDocument,
  requestDeepDive,
} from "./api";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  fetchMock.mockReset();
});

describe("api", () => {
  it("get: restituisce il body JSON parsato", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { needed: true }));

    await expect(api.get("/api/auth/setup")).resolves.toEqual({ needed: true });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/auth/setup",
      expect.objectContaining({ method: "GET", credentials: "include" }),
    );
  });

  it("post: serializza il body e imposta il content-type", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { ok: true }));

    await api.post("/api/things", { name: "x" });

    const [, init] = fetchMock.mock.calls[0]!;
    expect(init?.method).toBe("POST");
    expect(init?.body).toBe(JSON.stringify({ name: "x" }));
    expect(new Headers(init?.headers).get("content-type")).toBe("application/json");
  });

  it("post senza body: non manda body né content-type", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));

    await api.post("/api/auth/logout");

    const [, init] = fetchMock.mock.calls[0]!;
    expect(init?.body).toBeUndefined();
    expect(new Headers(init?.headers).has("content-type")).toBe(false);
  });

  it("204: risolve senza tentare il parse del body", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));

    await expect(api.post("/api/auth/logout")).resolves.toBeUndefined();
  });

  it("errore con body JSON: lancia ApiError con status e message del server", async () => {
    fetchMock.mockResolvedValue(jsonResponse(401, { message: "Credenziali non valide" }));

    const error = await api.get("/api/auth/me").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(401);
    expect((error as ApiError).message).toBe("Credenziali non valide");
  });

  it("errore senza body JSON: lancia ApiError con messaggio di fallback", async () => {
    fetchMock.mockResolvedValue(new Response("boom", { status: 500 }));

    const error = await api.get("/api/auth/me").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(500);
    expect((error as ApiError).message).toBe("Error 500");
  });

  it("errore di rete (TypeError): lancia ApiError con status 0, code e messaggio dedicato", async () => {
    fetchMock.mockRejectedValue(new TypeError("fetch failed"));

    const error = await api.get("/api/auth/me").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(0);
    expect((error as ApiError).code).toBe("network_error");
    expect((error as ApiError).message).toBe("Unable to reach the server");
  });

  it("errore non di rete (es. abort): riemerge senza essere incapsulato", async () => {
    const abort = new DOMException("annullata", "AbortError");
    fetchMock.mockRejectedValue(abort);

    await expect(api.get("/api/auth/me")).rejects.toBe(abort);
  });

  it("patch: usa il metodo PATCH", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, {}));

    await api.patch("/api/tickets/1", { status: "done" });

    expect(fetchMock.mock.calls[0]![1]?.method).toBe("PATCH");
  });
});

describe("funzioni auth", () => {
  it("getMe: GET /api/auth/me", async () => {
    const user = { id: "u1", email: "a@b.it", role: "admin" };
    fetchMock.mockResolvedValue(jsonResponse(200, { user }));

    await expect(getMe()).resolves.toEqual({ user });
    expect(fetchMock.mock.calls[0]![0]).toBe("/api/auth/me");
  });

  it("getSetupStatus: GET /api/auth/setup", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { needed: false }));

    await expect(getSetupStatus()).resolves.toEqual({ needed: false });
    expect(fetchMock.mock.calls[0]![0]).toBe("/api/auth/setup");
  });

  it("postLogin: POST /api/auth/login con le credenziali", async () => {
    const user = { id: "u1", email: "a@b.it", role: "member" };
    fetchMock.mockResolvedValue(jsonResponse(200, { user }));

    await expect(postLogin({ email: "a@b.it", password: "pw" })).resolves.toEqual({ user });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/api/auth/login");
    expect(init?.body).toBe(JSON.stringify({ email: "a@b.it", password: "pw" }));
  });

  it("postSetup: POST /api/auth/setup con le credenziali", async () => {
    const user = { id: "u1", email: "a@b.it", role: "admin" };
    fetchMock.mockResolvedValue(jsonResponse(201, { user }));

    await expect(postSetup({ email: "a@b.it", password: "password1" })).resolves.toEqual({
      user,
    });
    expect(fetchMock.mock.calls[0]![0]).toBe("/api/auth/setup");
  });

  it("postLogout: POST /api/auth/logout, risolve su 204", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));

    await expect(postLogout()).resolves.toBeUndefined();
    expect(fetchMock.mock.calls[0]![0]).toBe("/api/auth/logout");
  });
});

describe("funzioni server monitoring", () => {
  it("listServers senza progetto: GET /api/servers senza query", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, []));

    await expect(listServers()).resolves.toEqual([]);
    expect(fetchMock.mock.calls[0]![0]).toBe("/api/servers");
  });

  it("listServers con progetto: GET /api/servers?projectId=…", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, []));

    await listServers("p1");
    expect(fetchMock.mock.calls[0]![0]).toBe("/api/servers?projectId=p1");
  });

  it("createServer: POST /api/servers col solo nome", async () => {
    fetchMock.mockResolvedValue(jsonResponse(201, { id: "s1", name: "web", key: "sk_x" }));

    await createServer("web");
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/api/servers");
    expect(init?.method).toBe("POST");
    expect(init?.body).toBe(JSON.stringify({ name: "web" }));
  });

  it("createServerCheck: POST /api/servers/:id/checks col body del check", async () => {
    fetchMock.mockResolvedValue(jsonResponse(201, { id: "c1" }));
    const body = {
      type: "http" as const,
      name: "api",
      target: "https://x.test",
      intervalSeconds: 60,
      enabled: true,
    };

    await createServerCheck("s1", body);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/api/servers/s1/checks");
    expect(init?.method).toBe("POST");
    expect(init?.body).toBe(JSON.stringify(body));
  });

  it("getServerMetrics: mette from/to (e checkId) nella query string", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { resolution: "raw", truncated: false, points: [] }));

    await getServerMetrics("s1", {
      from: "2026-07-01T00:00:00.000Z",
      to: "2026-07-02T00:00:00.000Z",
      checkId: "c1",
    });
    const url = fetchMock.mock.calls[0]![0] as string;
    expect(url.startsWith("/api/servers/s1/metrics?")).toBe(true);
    const params = new URLSearchParams(url.split("?")[1]);
    expect(params.get("from")).toBe("2026-07-01T00:00:00.000Z");
    expect(params.get("to")).toBe("2026-07-02T00:00:00.000Z");
    expect(params.get("checkId")).toBe("c1");
  });

  it("getServerMetrics senza checkId: nessun parametro checkId", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { resolution: "5m", truncated: false, points: [] }));

    await getServerMetrics("s1", { from: "2026-07-01T00:00:00.000Z", to: "2026-07-08T00:00:00.000Z" });
    const url = fetchMock.mock.calls[0]![0] as string;
    expect(new URLSearchParams(url.split("?")[1]).has("checkId")).toBe(false);
  });
});

describe("funzioni ticket (multi-stato)", () => {
  it("listTickets con statuses: manda il parametro comma-separated, non status", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { items: [], nextCursor: null }));

    await listTickets({ statuses: ["open", "triaged", "in_progress", "in_review"] });
    const url = new URL(fetchMock.mock.calls[0]![0] as string, "http://test.local");
    expect(url.searchParams.get("statuses")).toBe("open,triaged,in_progress,in_review");
    expect(url.searchParams.has("status")).toBe(false);
  });

  it("listTickets con statuses vuoto: omette il parametro", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { items: [], nextCursor: null }));

    await listTickets({ statuses: [] });
    const url = new URL(fetchMock.mock.calls[0]![0] as string, "http://test.local");
    expect(url.searchParams.has("statuses")).toBe(false);
  });

  it("listTickets con status singolo: manda status, non statuses", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { items: [], nextCursor: null }));

    await listTickets({ status: "done" });
    const url = new URL(fetchMock.mock.calls[0]![0] as string, "http://test.local");
    expect(url.searchParams.get("status")).toBe("done");
    expect(url.searchParams.has("statuses")).toBe(false);
  });
});

describe("funzioni backlog", () => {
  it("listBacklogItems: mette i filtri e il cursore nella query", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { items: [], nextCursor: null }));

    await listBacklogItems(
      { projectId: "p1", status: "new", urgency: "high", risk: "medium", q: "login" },
      "cursore-1",
      25,
    );
    const url = new URL(fetchMock.mock.calls[0]![0] as string, "http://test.local");
    expect(url.pathname).toBe("/api/backlog");
    expect(url.searchParams.get("projectId")).toBe("p1");
    expect(url.searchParams.get("status")).toBe("new");
    expect(url.searchParams.get("urgency")).toBe("high");
    expect(url.searchParams.get("risk")).toBe("medium");
    expect(url.searchParams.get("q")).toBe("login");
    expect(url.searchParams.get("cursor")).toBe("cursore-1");
    expect(url.searchParams.get("limit")).toBe("25");
  });

  it("listBacklogItems senza filtri: nessuna query", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { items: [], nextCursor: null }));

    await listBacklogItems({});
    expect(fetchMock.mock.calls[0]![0]).toBe("/api/backlog");
  });

  it("getBacklogItem: GET /api/backlog/:id (id url-encoded)", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, {}));

    await getBacklogItem("a/b");
    expect(fetchMock.mock.calls[0]![0]).toBe("/api/backlog/a%2Fb");
    expect(fetchMock.mock.calls[0]![1]?.method).toBe("GET");
  });

  it("patchBacklogItem: PATCH col body dei metadati", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, {}));

    await patchBacklogItem("id1", { status: "ready", effort: 3 });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/api/backlog/id1");
    expect(init?.method).toBe("PATCH");
    expect(init?.body).toBe(JSON.stringify({ status: "ready", effort: 3 }));
  });

  it("postBacklogItem: POST /api/backlog col draft", async () => {
    fetchMock.mockResolvedValue(jsonResponse(202, { queued: true }));

    await expect(
      postBacklogItem({ projectId: "p1", title: "T", body: "B" }),
    ).resolves.toEqual({ queued: true });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/api/backlog");
    expect(init?.method).toBe("POST");
  });

  it("convertBacklogItem: POST /:id/convert senza body", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { ticketId: "t1", ticketNumber: 7 }));

    await expect(convertBacklogItem("id1")).resolves.toEqual({ ticketId: "t1", ticketNumber: 7 });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/api/backlog/id1/convert");
    expect(init?.body).toBeUndefined();
  });

  it("mergeBacklogItem: POST /:id/merge col targetId", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, {}));

    await mergeBacklogItem("id1", "id2");
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/api/backlog/id1/merge");
    expect(init?.body).toBe(JSON.stringify({ targetId: "id2" }));
  });

  it("requestDeepDive: POST /:id/deep-dive col repositoryId", async () => {
    fetchMock.mockResolvedValue(jsonResponse(202, { queued: true }));

    await requestDeepDive("id1", "repo1");
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/api/backlog/id1/deep-dive");
    expect(init?.body).toBe(JSON.stringify({ repositoryId: "repo1" }));
  });

  it("refreshBacklogDocument / acceptSuggested / dismissSuggested: POST sui path giusti", async () => {
    // Una Response fresca per chiamata: il body si legge una volta sola.
    fetchMock.mockImplementation(() => Promise.resolve(jsonResponse(200, {})));

    await refreshBacklogDocument("id1");
    await acceptSuggested("id1");
    await dismissSuggested("id1");
    expect(fetchMock.mock.calls[0]![0]).toBe("/api/backlog/id1/refresh-document");
    expect(fetchMock.mock.calls[1]![0]).toBe("/api/backlog/id1/suggested/accept");
    expect(fetchMock.mock.calls[2]![0]).toBe("/api/backlog/id1/suggested/dismiss");
  });
});
