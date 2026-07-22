import { describe, expect, it, vi } from "vitest";

import { StubwiseApiError, StubwiseClient } from "./client.js";
import type { StubwiseConfig } from "./config.js";

const CONFIG: StubwiseConfig = {
  baseUrl: "https://stubwise.example.com",
  token: "stw_pat_secret",
  projectSlug: null,
};

// UUID validi per i mock: gli schemi di validazione runtime usano z.uuid(), quindi
// jobId/resultItemId/ticketId nelle risposte finte devono essere UUID veri.
const JOB_ID = "11111111-1111-4111-8111-111111111111";
const ITEM_ID = "22222222-2222-4222-8222-222222222222";
const TICKET_ID = "33333333-3333-4333-8333-333333333333";

/** Costruisce un progetto pubblico completo (forma reale di GET /api/projects). */
function makeProject(over: { id: string; slug: string; name: string }): Record<string, unknown> {
  return {
    id: over.id,
    name: over.name,
    slug: over.slug,
    description: null,
    aiProviderId: null,
    docAutoUpdate: false,
    dailyReportEnabled: false,
    backlogEnabled: false,
    ingestionKey: "ingest_key",
    nextTicketNumber: 1,
    createdAt: "2026-07-22T00:00:00.000Z",
    // Campo extra reale della lista: deve essere ignorato dalla validazione.
    repositoryCount: 0,
  };
}

/** Costruisce una Response finta con corpo JSON. */
function jsonResponse(body: unknown, init: { status?: number } = {}): Response {
  const status = init.status ?? 200;
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Client con fetch iniettato (mock). */
function makeClient(fetchMock: ReturnType<typeof vi.fn>) {
  return new StubwiseClient(CONFIG, { fetch: fetchMock as unknown as typeof fetch });
}

describe("StubwiseClient", () => {
  it("invia l'header Authorization Bearer e content-type sul body", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ queued: true, jobId: JOB_ID }));
    const client = makeClient(fetchMock);

    await client.createBacklogItem({ projectId: "p1", title: "T", body: "B" });

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://stubwise.example.com/api/backlog");
    expect(init.method).toBe("POST");
    expect(init.headers.authorization).toBe("Bearer stw_pat_secret");
    expect(init.headers["content-type"]).toBe("application/json");
    expect(JSON.parse(init.body)).toEqual({ projectId: "p1", title: "T", body: "B" });
  });

  it("createBacklogItem ritorna il jobId", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ queued: true, jobId: JOB_ID }));
    const client = makeClient(fetchMock);

    const result = await client.createBacklogItem({ projectId: "p1", title: "T", body: "B" });
    expect(result).toEqual({ queued: true, jobId: JOB_ID });
  });

  it("createBacklogItem lancia invalid_response su risposta malformata", async () => {
    // jobId assente: la validazione runtime deve trasformarlo in errore parlante.
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ queued: true }));
    const client = makeClient(fetchMock);

    const err = await client
      .createBacklogItem({ projectId: "p1", title: "T", body: "B" })
      .catch((e) => e);
    expect(err).toBeInstanceOf(StubwiseApiError);
    expect(err.code).toBe("invalid_response");
    expect(err.status).toBe(0);
    expect(err.message).toContain("Risposta inattesa");
  });

  it("costruisce URL e query string omettendo i filtri undefined", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ items: [], nextCursor: null }));
    const client = makeClient(fetchMock);

    await client.listBacklog({ projectId: "p1", status: "new", q: "foo" });

    const url = new URL(fetchMock.mock.calls[0]![0]);
    expect(url.pathname).toBe("/api/backlog");
    expect(url.searchParams.get("projectId")).toBe("p1");
    expect(url.searchParams.get("status")).toBe("new");
    expect(url.searchParams.get("q")).toBe("foo");
    expect(url.searchParams.has("urgency")).toBe(false);
    expect(url.searchParams.has("limit")).toBe(false);
  });

  it("listTickets serializza statuses come CSV", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ items: [], nextCursor: null }));
    const client = makeClient(fetchMock);

    await client.listTickets({ projectId: "p1", statuses: ["open", "triaged"] });

    const url = new URL(fetchMock.mock.calls[0]![0]);
    expect(url.searchParams.get("statuses")).toBe("open,triaged");
  });

  it("setTicketStatus fa PATCH con { status }", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ id: "t1", status: "done" }));
    const client = makeClient(fetchMock);

    await client.setTicketStatus("t1", "done");

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://stubwise.example.com/api/tickets/t1");
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(init.body)).toEqual({ status: "done" });
  });

  it("mappa 401 in StubwiseApiError con status 401", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ code: "unauthorized", message: "no" }, { status: 401 }));
    const client = makeClient(fetchMock);

    await expect(client.listProjects()).rejects.toMatchObject({
      status: 401,
      name: "StubwiseApiError",
    });
    await expect(client.listProjects()).rejects.toThrow(/rigenera STUBWISE_TOKEN/);
  });

  it("mappa 403 in un messaggio di permessi", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({}, { status: 403 }));
    const client = makeClient(fetchMock);

    await expect(client.listProjects()).rejects.toMatchObject({ status: 403 });
    await expect(client.listProjects()).rejects.toThrow(/Permessi insufficienti/);
  });

  it("mappa 404 usando il messaggio del server", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        jsonResponse({ code: "backlog_item_not_found", message: "Backlog item not found" }, {
          status: 404,
        }),
      );
    const client = makeClient(fetchMock);

    const err = await client.getBacklogItem("missing").catch((e) => e);
    expect(err).toBeInstanceOf(StubwiseApiError);
    expect(err.status).toBe(404);
    expect(err.code).toBe("backlog_item_not_found");
  });

  it("estrae code/message dal body su altri errori", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ code: "invalid_cursor", message: "bad" }, { status: 400 }));
    const client = makeClient(fetchMock);

    const err = await client.listBacklog({ projectId: "p1" }).catch((e) => e);
    expect(err).toBeInstanceOf(StubwiseApiError);
    expect(err.status).toBe(400);
    expect(err.code).toBe("invalid_cursor");
    expect(err.message).toContain("bad");
  });

  it("mappa gli errori di rete in un messaggio con il baseUrl", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError("fetch failed"));
    const client = makeClient(fetchMock);

    const err = await client.listProjects().catch((e) => e);
    expect(err).toBeInstanceOf(StubwiseApiError);
    expect(err.status).toBe(0);
    expect(err.code).toBe("network_error");
    expect(err.message).toContain("https://stubwise.example.com");
  });

  it("getProjectBySlug filtra per slug e cacha la lista", async () => {
    const idA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const idB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const projects = [
      makeProject({ id: idA, slug: "alpha", name: "Alpha" }),
      makeProject({ id: idB, slug: "beta", name: "Beta" }),
    ];
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(projects));
    const client = makeClient(fetchMock);

    const found = await client.getProjectBySlug("beta");
    expect(found?.id).toBe(idB);

    const missing = await client.getProjectBySlug("gamma");
    expect(missing).toBeNull();

    // La seconda risoluzione riusa la cache: una sola chiamata fetch.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("getBacklogJob legge lo stato del job", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ status: "done", resultItemId: ITEM_ID, error: null }));
    const client = makeClient(fetchMock);

    const job = await client.getBacklogJob(JOB_ID);
    expect(job).toEqual({ status: "done", resultItemId: ITEM_ID, error: null });
    expect(fetchMock.mock.calls[0]![0]).toBe(
      `https://stubwise.example.com/api/backlog/jobs/${JOB_ID}`,
    );
  });

  it("getBacklogJob lancia invalid_response su status sconosciuto", async () => {
    // status fuori dall'enum backlogJobStatusSchema: errore di validazione chiaro.
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ status: "boom", resultItemId: null, error: null }));
    const client = makeClient(fetchMock);

    const err = await client.getBacklogJob(JOB_ID).catch((e) => e);
    expect(err).toBeInstanceOf(StubwiseApiError);
    expect(err.code).toBe("invalid_response");
    expect(err.status).toBe(0);
    expect(err.message).toContain("lo stato del job");
  });

  it("convertBacklogToTicket valida ticketId/ticketNumber", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ ticketId: TICKET_ID, ticketNumber: 7 }));
    const client = makeClient(fetchMock);

    const result = await client.convertBacklogToTicket(ITEM_ID);
    expect(result).toEqual({ ticketId: TICKET_ID, ticketNumber: 7 });

    const bad = vi.fn().mockResolvedValue(jsonResponse({ ticketId: TICKET_ID }));
    const err = await makeClient(bad)
      .convertBacklogToTicket(ITEM_ID)
      .catch((e) => e);
    expect(err).toBeInstanceOf(StubwiseApiError);
    expect(err.code).toBe("invalid_response");
  });
});
