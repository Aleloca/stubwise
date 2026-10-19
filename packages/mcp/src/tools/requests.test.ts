import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { StubwiseClient } from "../client.js";
import { requestTools } from "./requests.js";
import type { ToolContext, ToolDef, ToolResult } from "./types.js";

let cwdDir: string;
beforeEach(() => {
  cwdDir = mkdtempSync(join(tmpdir(), "stubwise-mcp-requests-"));
  vi.spyOn(process, "cwd").mockReturnValue(cwdDir);
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(cwdDir, { recursive: true, force: true });
});

const PROJECT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ITEM_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const TICKET_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const CONVERTED_TICKET_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

const project = { id: PROJECT_ID, slug: "audin", name: "Audin AI", backlogEnabled: true };

function text(res: ToolResult): string {
  return res.content.map((c) => c.text).join("\n");
}

function fakeTicket(over: Partial<{ id: string; number: number; title: string; status: string }>) {
  return {
    id: over.id ?? TICKET_ID,
    projectId: PROJECT_ID,
    number: over.number ?? 12,
    title: over.title ?? "Login rotto",
    body: "",
    type: "bug",
    priority: "medium",
    status: over.status ?? "open",
    assigneeId: null,
    labels: [],
    createdAt: "2026-10-01T09:00:00.000Z",
    updatedAt: "2026-10-01T09:00:00.000Z",
  };
}

function fakeItem(over: Partial<{ id: string; title: string; status: string }>) {
  return {
    id: over.id ?? ITEM_ID,
    projectId: PROJECT_ID,
    title: over.title ?? "Export CSV",
    status: over.status ?? "new",
    effort: null,
    risk: null,
    urgency: null,
    createdAt: "2026-10-02T09:00:00.000Z",
    updatedAt: "2026-10-02T09:00:00.000Z",
  };
}

function makeClient() {
  return {
    getProjectBySlug: vi.fn().mockResolvedValue(project),
    listProjects: vi.fn().mockResolvedValue([project]),
    listTickets: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
    listBacklog: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
    listTicketComments: vi.fn().mockResolvedValue([]),
    getBacklogItem: vi.fn(),
    getTicket: vi.fn(),
  };
}

function makeCtx(client: ReturnType<typeof makeClient>): ToolContext {
  return {
    client: client as unknown as StubwiseClient,
    config: { baseUrl: "https://stubwise.example.com", token: "stw_pat_x", projectSlug: null },
  };
}

function tool(name: string): ToolDef {
  const def = requestTools.find((t) => t.name === name);
  if (!def) throw new Error(`tool ${name} non registrato`);
  return def;
}

describe("my_requests — stati in parole semplici", () => {
  it.each([
    ["open", "ricevuta, non ancora presa in carico"],
    ["triaged", "ricevuta, non ancora presa in carico"],
    ["in_progress", "in lavorazione"],
    ["in_review", "in verifica"],
    ["done", "rilasciata"],
    ["closed", "chiusa"],
  ])("ticket %s → «%s»", async (status, label) => {
    const client = makeClient();
    client.listTickets.mockResolvedValue({ items: [fakeTicket({ status })], nextCursor: null });

    const res = await tool("my_requests").handler({ status: "all" }, makeCtx(client));

    expect(res.isError).toBeUndefined();
    expect(text(res)).toContain(`#12 «Login rotto»`);
    expect(text(res)).toContain(label);
  });

  it.each([
    ["new", "ricevuta"],
    ["refining", "in valutazione"],
    ["ready", "pronta per essere sviluppata"],
    ["archived", "archiviata"],
  ])("voce %s → «%s»", async (status, label) => {
    const client = makeClient();
    client.listBacklog.mockResolvedValue({ items: [fakeItem({ status })], nextCursor: null });

    const res = await tool("my_requests").handler({ status: "all" }, makeCtx(client));

    expect(text(res)).toContain("«Export CSV»");
    expect(text(res)).toContain(label);
  });

  it("voce convertita → «in sviluppo (ticket #N)» con lo stato del ticket", async () => {
    const client = makeClient();
    client.listBacklog.mockResolvedValue({
      items: [fakeItem({ status: "converted" })],
      nextCursor: null,
    });
    client.getBacklogItem.mockResolvedValue({
      ...fakeItem({ status: "converted" }),
      tickets: [{ id: CONVERTED_TICKET_ID, number: 15, title: "Export CSV", role: "converted_to" }],
    });
    client.getTicket.mockResolvedValue(
      fakeTicket({ id: CONVERTED_TICKET_ID, number: 15, status: "in_progress" }),
    );

    const res = await tool("my_requests").handler({}, makeCtx(client));

    expect(client.getBacklogItem).toHaveBeenCalledWith(ITEM_ID);
    expect(client.getTicket).toHaveBeenCalledWith(CONVERTED_TICKET_ID);
    expect(text(res)).toContain("in sviluppo (ticket #15)");
    expect(text(res)).toContain("in lavorazione");
  });
});

describe("my_requests — filtri", () => {
  it("di default chiede solo i propri e solo quelli aperti (esclude done/closed/archived)", async () => {
    const client = makeClient();
    client.listTickets.mockResolvedValue({
      items: [
        fakeTicket({ id: "t1", number: 1, title: "Aperto", status: "open" }),
        fakeTicket({ id: "t2", number: 2, title: "Fatto", status: "done" }),
        fakeTicket({ id: "t3", number: 3, title: "Chiuso", status: "closed" }),
      ],
      nextCursor: null,
    });
    client.listBacklog.mockResolvedValue({
      items: [
        fakeItem({ id: "i1", title: "Nuova", status: "new" }),
        fakeItem({ id: "i2", title: "Archiviata", status: "archived" }),
      ],
      nextCursor: null,
    });

    const res = await tool("my_requests").handler({}, makeCtx(client));

    expect(client.listTickets).toHaveBeenCalledWith(
      expect.objectContaining({
        mine: true,
        statuses: ["open", "triaged", "in_progress", "in_review"],
      }),
    );
    expect(client.listBacklog).toHaveBeenCalledWith(expect.objectContaining({ mine: true }));
    const out = text(res);
    expect(out).toContain("«Aperto»");
    expect(out).toContain("«Nuova»");
    expect(out).not.toContain("«Fatto»");
    expect(out).not.toContain("«Chiuso»");
    expect(out).not.toContain("«Archiviata»");
  });

  it("con un progetto filtra su quel progetto", async () => {
    const client = makeClient();

    await tool("my_requests").handler({ project: "audin" }, makeCtx(client));

    expect(client.getProjectBySlug).toHaveBeenCalledWith("audin");
    expect(client.listTickets).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: PROJECT_ID, mine: true }),
    );
    expect(client.listBacklog).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: PROJECT_ID, mine: true }),
    );
  });

  it("niente di niente → lo dice", async () => {
    const client = makeClient();
    const res = await tool("my_requests").handler({}, makeCtx(client));
    expect(text(res)).toMatch(/nessuna/i);
  });
});

describe("my_requests — note del maintainer", () => {
  it("mostra gli ultimi 3 commenti umani non eliminati, non quelli AI/sistema né gli eliminati", async () => {
    const client = makeClient();
    client.listTickets.mockResolvedValue({ items: [fakeTicket({})], nextCursor: null });
    client.listTicketComments.mockResolvedValue([
      {
        body: "primo umano",
        author: "user",
        createdAt: "2026-10-01T10:00:00.000Z",
        deletedAt: null,
      },
      {
        body: "secondo umano",
        author: "user",
        createdAt: "2026-10-02T10:00:00.000Z",
        deletedAt: null,
      },
      { body: "nota AI", author: "ai", createdAt: "2026-10-03T10:00:00.000Z", deletedAt: null },
      {
        body: "",
        author: "user",
        createdAt: "2026-10-04T10:00:00.000Z",
        deletedAt: "2026-10-04T11:00:00.000Z",
      },
      {
        body: "terzo umano",
        author: "user",
        createdAt: "2026-10-05T10:00:00.000Z",
        deletedAt: null,
      },
      {
        body: "quarto umano",
        author: "user",
        createdAt: "2026-10-06T10:00:00.000Z",
        deletedAt: null,
      },
      { body: "evento", author: "system", createdAt: "2026-10-07T10:00:00.000Z", deletedAt: null },
    ]);

    const res = await tool("my_requests").handler({}, makeCtx(client));

    expect(client.listTicketComments).toHaveBeenCalledWith(TICKET_ID);
    const out = text(res);
    expect(out).not.toContain("primo umano");
    expect(out).toContain("secondo umano");
    expect(out).toContain("terzo umano");
    expect(out).toContain("quarto umano");
    expect(out).not.toContain("nota AI");
    expect(out).not.toContain("evento");
    // Il commento eliminato (corpo vuoto) non diventa una riga vuota fra le note.
    expect(out).not.toMatch(/2026-10-04/);
  });

  it("commenti non leggibili → la riga del ticket c'è lo stesso", async () => {
    const client = makeClient();
    client.listTickets.mockResolvedValue({ items: [fakeTicket({})], nextCursor: null });
    client.listTicketComments.mockRejectedValue(new Error("boom"));

    const res = await tool("my_requests").handler({}, makeCtx(client));

    expect(res.isError).toBeUndefined();
    expect(text(res)).toContain("#12 «Login rotto»");
  });
});
