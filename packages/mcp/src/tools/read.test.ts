import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { StubwiseApiError, type StubwiseClient } from "../client.js";
import type { StubwiseConfig } from "../config.js";
import { readTools, registerReadTools } from "./read.js";
import type { ToolContext, ToolDef, ToolResult } from "./types.js";

// La risoluzione del progetto rilegge `.stubwise.json` risalendo da
// process.cwd(): senza questo isolamento i test cambierebbero esito a seconda
// che il repo di sviluppo abbia (o meno) un .stubwise.json committato.
let cwdDir: string;
beforeEach(() => {
  cwdDir = mkdtempSync(join(tmpdir(), "stubwise-mcp-read-"));
  vi.spyOn(process, "cwd").mockReturnValue(cwdDir);
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(cwdDir, { recursive: true, force: true });
});

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
    listInbox: vi.fn(),
    listProjectBriefs: vi.fn(),
    listProjectDecisions: vi.fn(),
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

describe("list_proposals", () => {
  const NOTIFICATION_ID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
  const BACKLOG_A = "f1111111-1111-4111-8111-111111111111";
  const BACKLOG_B = "f2222222-2222-4222-8222-222222222222";

  /** Riga d'inbox di un pulse, col contorno completo salvo override. */
  function fakePulseItem(over: Record<string, unknown> = {}) {
    return {
      id: NOTIFICATION_ID,
      kind: "project.pulse",
      status: "open",
      text: "Nessun lavoro in corso su Acme (giorni di fermo: 5): ci sono proposte nel backlog.",
      url: "https://stubwise.example.com/backlog?project=acme",
      pulse: {
        projectName: "Acme",
        idleDays: 5,
        proposals: [
          {
            backlogItemId: BACKLOG_A,
            title: "Export CSV degli ordini",
            urgency: "high",
            effort: 2,
            hasAnalysis: true,
          },
          {
            backlogItemId: BACKLOG_B,
            title: "Ricerca full text",
            urgency: null,
            effort: null,
            hasAnalysis: false,
          },
        ],
      },
      projectId: PROJECT_ID,
      ticketId: null,
      createdAt: "2026-09-01T07:00:00.000Z",
      ...over,
    };
  }

  it("chiede al server le sole notifiche pulse aperte ed elenca le proposte", async () => {
    const client = makeClient();
    client.listInbox.mockResolvedValue({ items: [fakePulseItem()], nextCursor: null });
    const { ctx } = makeCtx(client);

    const res = await tool("list_proposals").handler({}, ctx);

    expect(client.listInbox).toHaveBeenCalledWith({ status: "open", kind: "project.pulse" });
    expect(res.isError).toBeUndefined();
    const text = firstText(res);
    expect(text).toContain("Acme");
    expect(text).toContain("fermo da 5 giorni");
    expect(text).toContain("1. Export CSV degli ordini");
    expect(text).toContain("urgenza: high");
    expect(text).toContain("effort: 2");
    expect(text).toContain("analisi tecnica: pronta");
    expect(text).toContain(BACKLOG_A);
    // Seconda proposta: urgenza/effort mancanti resi a parole, non "null".
    expect(text).toContain("2. Ricerca full text");
    expect(text).toContain("urgenza: non stimata");
    expect(text).toContain("effort: non stimato");
    expect(text).not.toContain("null");
    // L'id della notifica c'è: è l'ancora per ritrovarla in inbox.
    expect(text).toContain(NOTIFICATION_ID);
    // E si dice dove si risponde davvero.
    expect(text).toContain("Slack");
  });

  it("rende comprensibile la lista vuota, senza segnalarla come errore", async () => {
    const client = makeClient();
    client.listInbox.mockResolvedValue({ items: [], nextCursor: null });
    const { ctx } = makeCtx(client);

    const res = await tool("list_proposals").handler({}, ctx);

    expect(res.isError).toBeUndefined();
    const text = firstText(res);
    expect(text).toContain("Nessuna proposta");
    // Spiega che l'inbox è per destinatario: "vuota" non vuol dire "il progetto
    // non ha proposte".
    expect(text).toContain("destinatario");
  });

  it("regge una riga senza il blocco pulse (payload non allineato): niente indici inventati", async () => {
    const client = makeClient();
    const item = fakePulseItem();
    delete (item as { pulse?: unknown }).pulse;
    client.listInbox.mockResolvedValue({ items: [item], nextCursor: null });
    const { ctx } = makeCtx(client);

    const res = await tool("list_proposals").handler({}, ctx);

    expect(res.isError).toBeUndefined();
    const text = firstText(res);
    // Degrada al testo localizzato della notifica, con l'id per ritrovarla.
    expect(text).toContain("Nessun lavoro in corso su Acme");
    expect(text).toContain(NOTIFICATION_ID);
    expect(text).toContain("dettaglio delle proposte non disponibile");
    // Nessuna voce di backlog nominata: senza il blocco non si sa quale sia.
    expect(text).not.toContain(BACKLOG_A);
  });

  it("cattura gli errori del client in un ToolResult d'errore", async () => {
    const client = makeClient();
    client.listInbox.mockRejectedValue(
      new StubwiseApiError("Token non valido", 401, "unauthorized"),
    );
    const { ctx } = makeCtx(client);

    const res = await tool("list_proposals").handler({}, ctx);

    expect(res.isError).toBe(true);
    expect(firstText(res)).toContain("Token non valido");
  });
});

describe("get_project_brief", () => {
  const BRIEF_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

  function fakeBrief(over: Record<string, unknown> = {}) {
    return {
      id: BRIEF_ID,
      projectId: PROJECT_ID,
      periodStart: "2026-08-31",
      periodEnd: "2026-09-06",
      status: "done",
      summary: "## Dove siamo\n\nIl progetto è a metà del lavoro sul login.",
      sections: { whereWeAre: "Il progetto è a metà del lavoro sul login." },
      notificationId: null,
      createdAt: "2026-09-07T07:30:00.000Z",
      finishedAt: "2026-09-07T07:31:00.000Z",
      ...over,
    };
  }

  it("restituisce il markdown dell'ULTIMO brief, col periodo che copre", async () => {
    const client = makeClient();
    client.getProjectBySlug.mockResolvedValue(fakeProject());
    client.listProjectBriefs.mockResolvedValue([fakeBrief()]);
    const { ctx } = makeCtx(client);

    const res = await tool("get_project_brief").handler({ project: "acme" }, ctx);

    expect(client.listProjectBriefs).toHaveBeenCalledWith(PROJECT_ID, 1);
    expect(res.isError).toBeUndefined();
    const text = firstText(res);
    expect(text).toContain("2026-08-31");
    expect(text).toContain("2026-09-06");
    expect(text).toContain("Il progetto è a metà del lavoro sul login.");
  });

  it("nessun brief: lo dice, e non è un errore", async () => {
    const client = makeClient();
    client.getProjectBySlug.mockResolvedValue(fakeProject());
    client.listProjectBriefs.mockResolvedValue([]);
    const { ctx } = makeCtx(client);

    const res = await tool("get_project_brief").handler({ project: "acme" }, ctx);
    expect(res.isError).toBeUndefined();
    expect(firstText(res)).toContain("Nessun brief");
  });

  it("brief senza testo (istanza senza provider AI): lo dichiara invece di mostrare il vuoto", async () => {
    const client = makeClient();
    client.getProjectBySlug.mockResolvedValue(fakeProject());
    client.listProjectBriefs.mockResolvedValue([fakeBrief({ summary: null, sections: null })]);
    const { ctx } = makeCtx(client);

    const res = await tool("get_project_brief").handler({ project: "acme" }, ctx);
    expect(res.isError).toBeUndefined();
    expect(firstText(res)).toContain("senza testo");
  });

  it("brief ancora in coda: lo dice, senza far finta che sia pronto", async () => {
    const client = makeClient();
    client.getProjectBySlug.mockResolvedValue(fakeProject());
    client.listProjectBriefs.mockResolvedValue([
      fakeBrief({ status: "queued", summary: null, sections: null, finishedAt: null }),
    ]);
    const { ctx } = makeCtx(client);

    const res = await tool("get_project_brief").handler({ project: "acme" }, ctx);
    expect(firstText(res)).toContain("in corso");
  });

  it("progetto non risolvibile: errore del resolver, nessuna chiamata ai brief", async () => {
    const client = makeClient();
    client.getProjectBySlug.mockResolvedValue(null);
    const { ctx } = makeCtx(client);

    const res = await tool("get_project_brief").handler({ project: "ignoto" }, ctx);
    expect(res.isError).toBe(true);
    expect(client.listProjectBriefs).not.toHaveBeenCalled();
  });
});

describe("registerReadTools", () => {
  it("registra tutti i tool di lettura con i nomi attesi", () => {
    const client = makeClient();
    const { ctx } = makeCtx(client);
    const registerTool = vi.fn<(...args: unknown[]) => unknown>();
    const server = { registerTool } as unknown as Parameters<typeof registerReadTools>[0];

    registerReadTools(server, ctx);

    expect(registerTool).toHaveBeenCalledTimes(8);
    const names = registerTool.mock.calls.map((c) => c[0]);
    expect(names).toEqual([
      "list_projects",
      "list_backlog",
      "get_backlog_item",
      "list_tickets",
      "get_ticket",
      "list_proposals",
      "get_project_brief",
      "list_decisions",
    ]);
    // Ogni registrazione passa un config con description + inputSchema e una callback.
    for (const call of registerTool.mock.calls) {
      expect(call[1]).toHaveProperty("description");
      expect(call[1]).toHaveProperty("inputSchema");
      expect(typeof call[2]).toBe("function");
    }
  });
});

describe("list_decisions", () => {
  const DECISION_ID = "cccccccc-dddd-4eee-8fff-aaaaaaaaaaaa";

  function fakeDecision(over: Record<string, unknown> = {}) {
    return {
      id: DECISION_ID,
      projectId: PROJECT_ID,
      source: "ask_user",
      ticketId: null,
      ticketNumber: 42,
      title: "Domanda dell'agente: quale formato per l'export?",
      context: null,
      decision: "CSV",
      consequences: "Nessuna dipendenza nuova",
      decidedBy: { id: "11111111-2222-4333-8444-555555555555", email: "ada@example.com" },
      decidedAt: "2026-09-06T10:00:00.000Z",
      supersededById: null,
      createdAt: "2026-09-06T10:00:00.000Z",
      ...over,
    };
  }

  it("elenca le decisioni con origine, attore e ticket", async () => {
    const client = makeClient();
    client.getProjectBySlug.mockResolvedValue(fakeProject());
    client.listProjectDecisions.mockResolvedValue([fakeDecision()]);
    const { ctx } = makeCtx(client);

    const res = await tool("list_decisions").handler({ project: "acme" }, ctx);

    expect(client.listProjectDecisions).toHaveBeenCalledWith(PROJECT_ID, { limit: 20 });
    expect(res.isError).toBeUndefined();
    const text = firstText(res);
    expect(text).toContain("CSV");
    expect(text).toContain("Nessuna dipendenza nuova");
    expect(text).toContain("risposta a una domanda dell'agente");
    expect(text).toContain("ada@example.com");
    expect(text).toContain("ticket #42");
  });

  it("marca le decisioni superate, che restano nell'elenco", async () => {
    const client = makeClient();
    client.getProjectBySlug.mockResolvedValue(fakeProject());
    client.listProjectDecisions.mockResolvedValue([
      fakeDecision({ supersededById: "99999999-8888-4777-8666-555555555555" }),
    ]);
    const { ctx } = makeCtx(client);

    const text = firstText(await tool("list_decisions").handler({ project: "acme" }, ctx));
    expect(text).toContain("[SUPERATA]");
  });

  it("nessuna decisione non è un errore: lo dice e spiega come si riempie", async () => {
    const client = makeClient();
    client.getProjectBySlug.mockResolvedValue(fakeProject());
    client.listProjectDecisions.mockResolvedValue([]);
    const { ctx } = makeCtx(client);

    const res = await tool("list_decisions").handler({ project: "acme" }, ctx);
    expect(res.isError).toBeUndefined();
    expect(firstText(res)).toContain("Nessuna decisione registrata");
  });

  it("passa il filtro di origine al client", async () => {
    const client = makeClient();
    client.getProjectBySlug.mockResolvedValue(fakeProject());
    client.listProjectDecisions.mockResolvedValue([]);
    const { ctx } = makeCtx(client);

    await tool("list_decisions").handler({ project: "acme", source: "manual", limit: 5 }, ctx);
    expect(client.listProjectDecisions).toHaveBeenCalledWith(PROJECT_ID, {
      limit: 5,
      source: "manual",
    });
  });
});
