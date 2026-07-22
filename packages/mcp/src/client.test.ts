import { describe, expect, it, vi } from "vitest";

import { StubwiseApiError, StubwiseClient } from "./client.js";
import type { StubwiseConfig } from "./config.js";

const CONFIG: StubwiseConfig = {
  baseUrl: "https://stubwise.example.com",
  token: "stw_pat_secret",
  projectSlug: null,
};

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
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ queued: true, jobId: "job-1" }));
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
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ queued: true, jobId: "job-42" }));
    const client = makeClient(fetchMock);

    const result = await client.createBacklogItem({ projectId: "p1", title: "T", body: "B" });
    expect(result).toEqual({ queued: true, jobId: "job-42" });
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
    const projects = [
      { id: "id-a", slug: "alpha", name: "Alpha" },
      { id: "id-b", slug: "beta", name: "Beta" },
    ];
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(projects));
    const client = makeClient(fetchMock);

    const found = await client.getProjectBySlug("beta");
    expect(found?.id).toBe("id-b");

    const missing = await client.getProjectBySlug("gamma");
    expect(missing).toBeNull();

    // La seconda risoluzione riusa la cache: una sola chiamata fetch.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("getBacklogJob legge lo stato del job", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ status: "done", resultItemId: "item-9", error: null }));
    const client = makeClient(fetchMock);

    const job = await client.getBacklogJob("job-1");
    expect(job).toEqual({ status: "done", resultItemId: "item-9", error: null });
    expect(fetchMock.mock.calls[0]![0]).toBe(
      "https://stubwise.example.com/api/backlog/jobs/job-1",
    );
  });
});
