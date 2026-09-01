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

  it("listInbox filtra su status e kind (nessun projectId: l'inbox è per destinatario)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ items: [], nextCursor: null }));
    const client = makeClient(fetchMock);

    await client.listInbox({ status: "open", kind: "project.pulse" });

    const url = new URL(fetchMock.mock.calls[0]![0]);
    expect(url.pathname).toBe("/api/inbox");
    expect(url.searchParams.get("status")).toBe("open");
    expect(url.searchParams.get("kind")).toBe("project.pulse");
    expect(url.searchParams.has("projectId")).toBe(false);
  });

  it("listInbox senza filtri non manda query string (valgono i default del server)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ items: [], nextCursor: null }));
    const client = makeClient(fetchMock);

    await client.listInbox();

    expect(fetchMock.mock.calls[0]![0]).toBe("https://stubwise.example.com/api/inbox");
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

  it("createBacklogFromDesign fa POST /api/backlog/from-design con body { projectId, title, design } e Authorization", async () => {
    const url = `https://stubwise.example.com/backlog/${ITEM_ID}`;
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ itemId: ITEM_ID, url }, { status: 201 }));
    const client = makeClient(fetchMock);

    const result = await client.createBacklogFromDesign("p1", "Titolo", "# Design\nCorpo");
    expect(result).toEqual({ itemId: ITEM_ID, url });

    const [reqUrl, init] = fetchMock.mock.calls[0]!;
    expect(reqUrl).toBe("https://stubwise.example.com/api/backlog/from-design");
    expect(init.method).toBe("POST");
    expect(init.headers.authorization).toBe("Bearer stw_pat_secret");
    expect(init.headers["content-type"]).toBe("application/json");
    expect(JSON.parse(init.body)).toEqual({
      projectId: "p1",
      title: "Titolo",
      design: "# Design\nCorpo",
    });
  });

  it("createBacklogFromDesign lancia invalid_response su risposta malformata", async () => {
    // url assente: la validazione runtime deve trasformarlo in errore parlante.
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ itemId: ITEM_ID }));
    const client = makeClient(fetchMock);

    const err = await client.createBacklogFromDesign("p1", "T", "D").catch((e) => e);
    expect(err).toBeInstanceOf(StubwiseApiError);
    expect(err.code).toBe("invalid_response");
    expect(err.status).toBe(0);
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

  // --- run-ai ---------------------------------------------------------------

  it("runTicket fa POST /api/tickets/:id/run-ai e valida { jobId, status }", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ jobId: JOB_ID, status: "queued" }, { status: 202 }));
    const client = makeClient(fetchMock);

    const result = await client.runTicket(TICKET_ID);

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`https://stubwise.example.com/api/tickets/${TICKET_ID}/run-ai`);
    expect(init.method).toBe("POST");
    expect(init.headers.authorization).toBe("Bearer stw_pat_secret");
    expect(JSON.parse(init.body)).toEqual({});
    expect(result).toEqual({ jobId: JOB_ID, status: "queued" });
  });

  it("runTicket inoltra mode 'ai_plan' nel body e accetta awaiting_plan_approval", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ jobId: JOB_ID, status: "awaiting_plan_approval" }, { status: 202 }),
    );
    const client = makeClient(fetchMock);

    const result = await client.runTicket(TICKET_ID, { mode: "ai_plan" });

    const [, init] = fetchMock.mock.calls[0]!;
    expect(JSON.parse(init.body)).toEqual({ mode: "ai_plan" });
    expect(result.status).toBe("awaiting_plan_approval");
  });

  it("runTicket lancia invalid_response su forma sbagliata", async () => {
    // status fuori enum: la validazione runtime deve dare un errore parlante.
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ jobId: JOB_ID, status: "running" }, { status: 202 }));
    const client = makeClient(fetchMock);

    const err = await client.runTicket(TICKET_ID).catch((e) => e);
    expect(err).toBeInstanceOf(StubwiseApiError);
    expect(err.code).toBe("invalid_response");
    expect(err.status).toBe(0);
  });

  it("runTicket propaga il 409 job_in_flight con code e messaggio del server", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(
        { code: "job_in_flight", message: "A job for this ticket is already running" },
        { status: 409 },
      ),
    );
    const client = makeClient(fetchMock);

    const err = await client.runTicket(TICKET_ID).catch((e) => e);
    expect(err).toBeInstanceOf(StubwiseApiError);
    expect(err.status).toBe(409);
    expect(err.code).toBe("job_in_flight");
    expect(err.message).toBe("A job for this ticket is already running");
  });

  // --- design / plan --------------------------------------------------------

  it("setDesign('backlog', ...) fa PUT /api/backlog/:id/design con body { content } e Authorization", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ id: ITEM_ID }));
    const client = makeClient(fetchMock);

    await client.setDesign("backlog", ITEM_ID, "# Design\nCorpo");

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`https://stubwise.example.com/api/backlog/${ITEM_ID}/design`);
    expect(init.method).toBe("PUT");
    expect(init.headers.authorization).toBe("Bearer stw_pat_secret");
    expect(JSON.parse(init.body)).toEqual({ content: "# Design\nCorpo" });
  });

  it("setDesign('ticket', ...) fa PUT /api/tickets/:id/design", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ id: TICKET_ID }));
    const client = makeClient(fetchMock);

    await client.setDesign("ticket", TICKET_ID, "corpo");

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`https://stubwise.example.com/api/tickets/${TICKET_ID}/design`);
    expect(init.method).toBe("PUT");
    expect(JSON.parse(init.body)).toEqual({ content: "corpo" });
  });

  it("deleteDesign('ticket', ...) fa DELETE /api/tickets/:id/design senza body", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ id: TICKET_ID }));
    const client = makeClient(fetchMock);

    await client.deleteDesign("ticket", TICKET_ID);

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`https://stubwise.example.com/api/tickets/${TICKET_ID}/design`);
    expect(init.method).toBe("DELETE");
    expect(init.headers.authorization).toBe("Bearer stw_pat_secret");
    expect(init.body).toBeUndefined();
  });

  it("deleteDesign('backlog', ...) fa DELETE /api/backlog/:id/design", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ id: ITEM_ID }));
    const client = makeClient(fetchMock);

    await client.deleteDesign("backlog", ITEM_ID);

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`https://stubwise.example.com/api/backlog/${ITEM_ID}/design`);
    expect(init.method).toBe("DELETE");
  });

  it("setPlan('backlog', ...) fa PUT /api/backlog/:id/plan con body { content }", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ id: ITEM_ID }));
    const client = makeClient(fetchMock);

    await client.setPlan("backlog", ITEM_ID, "step 1");

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`https://stubwise.example.com/api/backlog/${ITEM_ID}/plan`);
    expect(init.method).toBe("PUT");
    expect(JSON.parse(init.body)).toEqual({ content: "step 1" });
  });

  it("setPlan('ticket', ...) fa PUT /api/tickets/:id/plan", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ id: TICKET_ID }));
    const client = makeClient(fetchMock);

    await client.setPlan("ticket", TICKET_ID, "step 1");

    const url = fetchMock.mock.calls[0]![0];
    expect(url).toBe(`https://stubwise.example.com/api/tickets/${TICKET_ID}/plan`);
  });

  it("deletePlan('ticket', ...) fa DELETE /api/tickets/:id/plan", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ id: TICKET_ID }));
    const client = makeClient(fetchMock);

    await client.deletePlan("ticket", TICKET_ID);

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`https://stubwise.example.com/api/tickets/${TICKET_ID}/plan`);
    expect(init.method).toBe("DELETE");
  });

  it("deletePlan('backlog', ...) fa DELETE /api/backlog/:id/plan", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ id: ITEM_ID }));
    const client = makeClient(fetchMock);

    await client.deletePlan("backlog", ITEM_ID);

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`https://stubwise.example.com/api/backlog/${ITEM_ID}/plan`);
    expect(init.method).toBe("DELETE");
  });
});
