import { describe, expect, it, vi } from "vitest";

import { StubwiseApiError, type StubwiseClient } from "../client.js";
import type { StubwiseConfig } from "../config.js";
import { readTools, registerReadTools } from "./read.js";
import type { ToolContext, ToolDef, ToolResult } from "./types.js";

/** Testo del primo blocco di contenuto (i tool ne emettono sempre uno). */
function firstText(res: ToolResult): string {
  return res.content[0]?.text ?? "";
}

const PROJECT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ITEM_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const TICKET_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

/** Progetto finto (solo i campi che i tool usano; forma reale di GET /api/projects). */
function fakeProject(over: Partial<{ id: string; slug: string; name: string }> = {}) {
  return {
    id: over.id ?? PROJECT_ID,
    name: over.name ?? "Acme",
    slug: over.slug ?? "acme",
    description: null,
    aiProviderId: null,
    docAutoUpdate: false,
    dailyReportEnabled: false,
    backlogEnabled: true,
    ingestionKey: "ingest_key",
    nextTicketNumber: 1,
    createdAt: "2026-07-22T00:00:00.000Z",
  };
}

/**
 * Client mockato: ogni metodo usato dai tool è un `vi.fn`. Il cast a
 * `StubwiseClient` è sicuro perché i tool ne toccano solo questi metodi.
 */
function makeClient() {
  return {
    listProjects: vi.fn(),
    getProjectBySlug: vi.fn(),
    listBacklog: vi.fn(),
    getBacklogItem: vi.fn(),
    listTickets: vi.fn(),
    getTicket: vi.fn(),
  };
}

type MockClient = ReturnType<typeof makeClient>;

function makeCtx(
  client: MockClient,
  config: Partial<StubwiseConfig> = {},
): { ctx: ToolContext; client: MockClient } {
  const fullConfig: StubwiseConfig = {
    baseUrl: "https://stubwise.example.com",
    token: "stw_pat_secret",
    projectSlug: null,
    ...config,
  };
  return { ctx: { client: client as unknown as StubwiseClient, config: fullConfig }, client };
}

/** Recupera un tool di lettura per nome (gli handler si testano direttamente). */
function tool(name: string): ToolDef {
  const def = readTools.find((t) => t.name === name);
  if (!def) throw new Error(`tool ${name} non registrato`);
  return def;
}

describe("list_projects", () => {
  it("elenca id/slug/name dei progetti", async () => {
    const client = makeClient();
    client.listProjects.mockResolvedValue([
      fakeProject({ slug: "acme", name: "Acme" }),
      fakeProject({ id: "d0000000-0000-4000-8000-000000000000", slug: "beta", name: "Beta" }),
    ]);
    const { ctx } = makeCtx(client);

    const res = await tool("list_projects").handler({}, ctx);

    expect(client.listProjects).toHaveBeenCalledOnce();
    expect(res.isError).toBeUndefined();
    expect(firstText(res)).toContain("acme");
    expect(firstText(res)).toContain("Beta");
    expect(firstText(res)).toContain(PROJECT_ID);
  });

  it("gestisce l'assenza di progetti", async () => {
    const client = makeClient();
    client.listProjects.mockResolvedValue([]);
    const { ctx } = makeCtx(client);

    const res = await tool("list_projects").handler({}, ctx);

    expect(firstText(res)).toContain("Nessun progetto");
  });

  it("cattura gli errori del client in un ToolResult d'errore", async () => {
    const client = makeClient();
    client.listProjects.mockRejectedValue(
      new StubwiseApiError("Token non valido", 401, "unauthorized"),
    );
    const { ctx } = makeCtx(client);

    const res = await tool("list_projects").handler({}, ctx);

    expect(res.isError).toBe(true);
    expect(firstText(res)).toContain("Token non valido");
  });
});

describe("list_backlog", () => {
  it("risolve il progetto dall'arg e passa projectId + filtri al client", async () => {
    const client = makeClient();
    client.getProjectBySlug.mockResolvedValue(fakeProject({ slug: "acme" }));
    client.listBacklog.mockResolvedValue({
      items: [
        {
          id: ITEM_ID,
          projectId: PROJECT_ID,
          title: "Ricerca full-text",
          status: "refined",
          effort: 3,
          risk: "medium",
          urgency: "high",
          createdAt: "2026-07-22T00:00:00.000Z",
          updatedAt: "2026-07-22T00:00:00.000Z",
        },
      ],
      nextCursor: null,
    });
    const { ctx } = makeCtx(client);

    const res = await tool("list_backlog").handler(
      { project: "acme", status: "refined", urgency: "high", q: "search", limit: 10 },
      ctx,
    );

    expect(client.getProjectBySlug).toHaveBeenCalledWith("acme");
    expect(client.listBacklog).toHaveBeenCalledWith({
      projectId: PROJECT_ID,
      status: "refined",
      urgency: "high",
      q: "search",
      limit: 10,
    });
    expect(res.isError).toBeUndefined();
    expect(firstText(res)).toContain("Ricerca full-text");
    expect(firstText(res)).toContain(ITEM_ID);
    expect(firstText(res)).toContain("effort: 3");
  });

  it("usa il projectSlug di default della config quando l'arg è assente", async () => {
    const client = makeClient();
    client.getProjectBySlug.mockResolvedValue(fakeProject({ slug: "acme" }));
    client.listBacklog.mockResolvedValue({ items: [], nextCursor: null });
    const { ctx } = makeCtx(client, { projectSlug: "acme" });

    const res = await tool("list_backlog").handler({}, ctx);

    expect(client.getProjectBySlug).toHaveBeenCalledWith("acme");
    expect(client.listBacklog).toHaveBeenCalledWith({
      projectId: PROJECT_ID,
      status: undefined,
      urgency: undefined,
      q: undefined,
      limit: undefined,
    });
    expect(firstText(res)).toContain("Nessuna voce");
  });

  it("senza progetto risolvibile ritorna un errore che invita a /stubwise:init (non lancia)", async () => {
    const client = makeClient();
    const { ctx } = makeCtx(client, { projectSlug: null });

    const res = await tool("list_backlog").handler({}, ctx);

    expect(res.isError).toBe(true);
    expect(firstText(res)).toContain("/stubwise:init");
    expect(client.listBacklog).not.toHaveBeenCalled();
  });

  it("con progetto inesistente ritorna un errore parlante", async () => {
    const client = makeClient();
    client.getProjectBySlug.mockResolvedValue(null);
    const { ctx } = makeCtx(client);

    const res = await tool("list_backlog").handler({ project: "ghost" }, ctx);

    expect(res.isError).toBe(true);
    expect(firstText(res)).toContain("'ghost' non trovato");
    expect(client.listBacklog).not.toHaveBeenCalled();
  });
});

describe("get_backlog_item", () => {
  it("ritorna metadati + documento completo senza richiedere il progetto", async () => {
    const client = makeClient();
    client.getBacklogItem.mockResolvedValue({
      id: ITEM_ID,
      projectId: PROJECT_ID,
      title: "Ricerca full-text",
      document: "# Analisi\nContenuto del refinement.",
      status: "refined",
      effort: 3,
      risk: "medium",
      riskNote: null,
      urgency: "high",
      implementationPlan: "1. Indicizza\n2. Interfaccia",
      originContent: "Testo originale della voce.",
      createdAt: "2026-07-22T00:00:00.000Z",
      updatedAt: "2026-07-22T00:00:00.000Z",
    });
    const { ctx } = makeCtx(client);

    const res = await tool("get_backlog_item").handler({ id: ITEM_ID }, ctx);

    expect(client.getBacklogItem).toHaveBeenCalledWith(ITEM_ID);
    expect(res.isError).toBeUndefined();
    expect(firstText(res)).toContain("Contenuto del refinement");
    expect(firstText(res)).toContain(ITEM_ID);
    expect(firstText(res)).toContain("1. Indicizza");
    expect(firstText(res)).toContain("Testo originale della voce.");
  });

  it("mostra un empty state quando implementationPlan/originContent sono null", async () => {
    const client = makeClient();
    client.getBacklogItem.mockResolvedValue({
      id: ITEM_ID,
      projectId: PROJECT_ID,
      title: "Idea grezza",
      document: "# Bozza",
      status: "new",
      effort: null,
      risk: null,
      riskNote: null,
      urgency: null,
      implementationPlan: null,
      originContent: null,
      createdAt: "2026-07-22T00:00:00.000Z",
      updatedAt: "2026-07-22T00:00:00.000Z",
    });
    const { ctx } = makeCtx(client);

    const res = await tool("get_backlog_item").handler({ id: ITEM_ID }, ctx);

    expect(firstText(res)).toContain("Piano di implementazione");
    expect(firstText(res)).toContain("Contenuto d'origine");
  });

  it("cattura StubwiseApiError 404 in un ToolResult d'errore", async () => {
    const client = makeClient();
    client.getBacklogItem.mockRejectedValue(
      new StubwiseApiError("Risorsa non trovata su Stubwise", 404, "not_found"),
    );
    const { ctx } = makeCtx(client);

    const res = await tool("get_backlog_item").handler({ id: ITEM_ID }, ctx);

    expect(res.isError).toBe(true);
    expect(firstText(res)).toContain("non trovata");
  });
});

describe("list_tickets", () => {
  it("normalizza statuses CSV in array e passa i filtri al client", async () => {
    const client = makeClient();
    client.getProjectBySlug.mockResolvedValue(fakeProject({ slug: "acme" }));
    client.listTickets.mockResolvedValue({
      items: [
        {
          id: TICKET_ID,
          projectId: PROJECT_ID,
          number: 42,
          title: "Login rotto",
          body: "",
          type: "bug",
          priority: "high",
          status: "open",
          assigneeId: null,
          labels: [],
          createdAt: "2026-07-22T00:00:00.000Z",
          updatedAt: "2026-07-22T00:00:00.000Z",
        },
      ],
      nextCursor: null,
    });
    const { ctx } = makeCtx(client);

    const res = await tool("list_tickets").handler(
      { project: "acme", statuses: "open, triaged", type: "bug", priority: "high" },
      ctx,
    );

    expect(client.listTickets).toHaveBeenCalledWith({
      projectId: PROJECT_ID,
      statuses: ["open", "triaged"],
      type: "bug",
      priority: "high",
      q: undefined,
      limit: undefined,
    });
    expect(firstText(res)).toContain("#42");
    expect(firstText(res)).toContain("Login rotto");
  });

  it("accetta statuses come array", async () => {
    const client = makeClient();
    client.getProjectBySlug.mockResolvedValue(fakeProject({ slug: "acme" }));
    client.listTickets.mockResolvedValue({ items: [], nextCursor: null });
    const { ctx } = makeCtx(client, { projectSlug: "acme" });

    await tool("list_tickets").handler({ statuses: ["open", "in_progress"] }, ctx);

    expect(client.listTickets).toHaveBeenCalledWith(
      expect.objectContaining({ statuses: ["open", "in_progress"] }),
    );
  });

  it("senza progetto risolvibile ritorna errore e non chiama il client", async () => {
    const client = makeClient();
    const { ctx } = makeCtx(client, { projectSlug: null });

    const res = await tool("list_tickets").handler({}, ctx);

    expect(res.isError).toBe(true);
    expect(firstText(res)).toContain("/stubwise:init");
    expect(client.listTickets).not.toHaveBeenCalled();
  });

  it("cattura StubwiseApiError del client in un ToolResult d'errore", async () => {
    const client = makeClient();
    client.getProjectBySlug.mockResolvedValue(fakeProject({ slug: "acme" }));
    client.listTickets.mockRejectedValue(
      new StubwiseApiError("Errore interno su Stubwise", 500, "internal_error"),
    );
    const { ctx } = makeCtx(client, { projectSlug: "acme" });

    const res = await tool("list_tickets").handler({}, ctx);

    expect(res.isError).toBe(true);
    expect(firstText(res)).toContain("Errore interno");
  });
});

describe("get_ticket", () => {
  it("ritorna il ticket serializzato", async () => {
    const client = makeClient();
    client.getTicket.mockResolvedValue({
      id: TICKET_ID,
      projectId: PROJECT_ID,
      number: 42,
      title: "Login rotto",
      body: "Non riesco ad autenticarmi.",
      type: "bug",
      priority: "high",
      status: "open",
      assigneeId: null,
      labels: ["auth"],
      implementationPlan: "1. Ripara la sessione",
      originContent: "Segnalazione originale utente.",
      createdAt: "2026-07-22T00:00:00.000Z",
      updatedAt: "2026-07-22T00:00:00.000Z",
    });
    const { ctx } = makeCtx(client);

    const res = await tool("get_ticket").handler({ id: TICKET_ID }, ctx);

    expect(client.getTicket).toHaveBeenCalledWith(TICKET_ID);
    expect(res.isError).toBeUndefined();
    expect(firstText(res)).toContain("Login rotto");
    expect(firstText(res)).toContain("auth");
    expect(firstText(res)).toContain("1. Ripara la sessione");
    expect(firstText(res)).toContain("Segnalazione originale utente.");
  });

  it("cattura StubwiseApiError 404 in un ToolResult d'errore", async () => {
    const client = makeClient();
    client.getTicket.mockRejectedValue(
      new StubwiseApiError("Risorsa non trovata su Stubwise", 404, "not_found"),
    );
    const { ctx } = makeCtx(client);

    const res = await tool("get_ticket").handler({ id: TICKET_ID }, ctx);

    expect(res.isError).toBe(true);
    expect(firstText(res)).toContain("non trovata");
  });
});

describe("registerReadTools", () => {
  it("registra tutti i tool di lettura con i nomi attesi", () => {
    const client = makeClient();
    const { ctx } = makeCtx(client);
    const registerTool = vi.fn<(...args: unknown[]) => unknown>();
    const server = { registerTool } as unknown as Parameters<typeof registerReadTools>[0];

    registerReadTools(server, ctx);

    expect(registerTool).toHaveBeenCalledTimes(5);
    const names = registerTool.mock.calls.map((c) => c[0]);
    expect(names).toEqual([
      "list_projects",
      "list_backlog",
      "get_backlog_item",
      "list_tickets",
      "get_ticket",
    ]);
    // Ogni registrazione passa un config con description + inputSchema e una callback.
    for (const call of registerTool.mock.calls) {
      expect(call[1]).toHaveProperty("description");
      expect(call[1]).toHaveProperty("inputSchema");
      expect(typeof call[2]).toBe("function");
    }
  });
});
