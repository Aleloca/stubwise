import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { StubwiseApiError, type StubwiseClient } from "../client.js";
import type { StubwiseConfig } from "../config.js";
import type { ToolContext, ToolDef, ToolResult } from "./types.js";
import { registerWriteTools, writeTools } from "./write.js";

// La risoluzione del progetto rilegge `.stubwise.json` risalendo da
// process.cwd(): senza questo isolamento i test cambierebbero esito a seconda
// che il repo di sviluppo abbia (o meno) un .stubwise.json committato.
let cwdDir: string;
beforeEach(() => {
  cwdDir = mkdtempSync(join(tmpdir(), "stubwise-mcp-write-"));
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
const JOB_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const BASE_URL = "https://stubwise.example.com";

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

/** Ticket finto nella forma difensiva del client. */
function fakeTicket(over: Partial<{ id: string; number: number; type: string; status: string }> = {}) {
  return {
    id: over.id ?? TICKET_ID,
    projectId: PROJECT_ID,
    number: over.number ?? 42,
    title: "Login rotto",
    body: "",
    type: over.type ?? "task",
    priority: "medium",
    status: over.status ?? "open",
    assigneeId: null,
    labels: [],
    createdAt: "2026-07-22T00:00:00.000Z",
    updatedAt: "2026-07-22T00:00:00.000Z",
  };
}

/**
 * Client mockato: ogni metodo usato dai tool di scrittura è un `vi.fn`. Il cast a
 * `StubwiseClient` è sicuro perché i tool ne toccano solo questi metodi.
 */
function makeClient() {
  return {
    getProjectBySlug: vi.fn(),
    createTicket: vi.fn(),
    convertBacklogToTicket: vi.fn(),
    setTicketStatus: vi.fn(),
    runTicket: vi.fn(),
    createBacklogItem: vi.fn(),
    createBacklogFromDesign: vi.fn(),
    getBacklogJob: vi.fn(),
    setDesign: vi.fn(),
    deleteDesign: vi.fn(),
    setPlan: vi.fn(),
    deletePlan: vi.fn(),
  };
}

type MockClient = ReturnType<typeof makeClient>;

function makeCtx(
  client: MockClient,
  overrides: Partial<Omit<ToolContext, "client">> = {},
): { ctx: ToolContext; client: MockClient } {
  const fullConfig: StubwiseConfig = {
    baseUrl: BASE_URL,
    token: "stw_pat_secret",
    projectSlug: null,
    ...(overrides.config ?? {}),
  };
  const ctx: ToolContext = {
    client: client as unknown as StubwiseClient,
    config: fullConfig,
    sleep: overrides.sleep,
    pollOptions: overrides.pollOptions,
  };
  return { ctx, client };
}

/** Recupera un tool di scrittura per nome (gli handler si testano direttamente). */
function tool(name: string): ToolDef {
  const def = writeTools.find((t) => t.name === name);
  if (!def) throw new Error(`tool ${name} non registrato`);
  return def;
}

describe("create_ticket", () => {
  it("risolve il progetto, applica il type di default 'task' e mette l'URL nell'output", async () => {
    const client = makeClient();
    client.getProjectBySlug.mockResolvedValue(fakeProject({ slug: "acme" }));
    client.createTicket.mockResolvedValue(fakeTicket({ type: "task", number: 7 }));
    const { ctx } = makeCtx(client);

    const res = await tool("create_ticket").handler(
      { project: "acme", title: "Nuovo bug" },
      ctx,
    );

    expect(client.getProjectBySlug).toHaveBeenCalledWith("acme");
    expect(client.createTicket).toHaveBeenCalledWith({
      projectId: PROJECT_ID,
      title: "Nuovo bug",
      body: undefined,
      type: "task",
      priority: undefined,
    });
    expect(res.isError).toBeUndefined();
    expect(firstText(res)).toContain("#7");
    expect(firstText(res)).toContain(`${BASE_URL}/tickets/${TICKET_ID}`);
  });

  it("passa type/priority espliciti quando forniti", async () => {
    const client = makeClient();
    client.getProjectBySlug.mockResolvedValue(fakeProject({ slug: "acme" }));
    client.createTicket.mockResolvedValue(fakeTicket({ type: "bug" }));
    const { ctx } = makeCtx(client, { config: { projectSlug: "acme" } as Partial<StubwiseConfig> as StubwiseConfig });

    await tool("create_ticket").handler({ title: "Crash", type: "bug", priority: "urgent" }, ctx);

    expect(client.createTicket).toHaveBeenCalledWith(
      expect.objectContaining({ type: "bug", priority: "urgent" }),
    );
  });

  it("senza progetto risolvibile ritorna errore /stubwise:init e non crea il ticket", async () => {
    const client = makeClient();
    const { ctx } = makeCtx(client, { config: { projectSlug: null } as StubwiseConfig });

    const res = await tool("create_ticket").handler({ title: "Orfano" }, ctx);

    expect(res.isError).toBe(true);
    expect(firstText(res)).toContain("/stubwise:init");
    expect(client.createTicket).not.toHaveBeenCalled();
  });
});

describe("convert_backlog_to_ticket", () => {
  it("converte e ritorna ticketNumber + URL", async () => {
    const client = makeClient();
    client.convertBacklogToTicket.mockResolvedValue({ ticketId: TICKET_ID, ticketNumber: 99 });
    const { ctx } = makeCtx(client);

    const res = await tool("convert_backlog_to_ticket").handler({ id: ITEM_ID }, ctx);

    expect(client.convertBacklogToTicket).toHaveBeenCalledWith(ITEM_ID);
    expect(res.isError).toBeUndefined();
    expect(firstText(res)).toContain("#99");
    expect(firstText(res)).toContain(`${BASE_URL}/tickets/${TICKET_ID}`);
  });

  it("cattura StubwiseApiError 403 (convert admin-only) in un ToolResult leggibile", async () => {
    const client = makeClient();
    client.convertBacklogToTicket.mockRejectedValue(
      new StubwiseApiError("Permessi insufficienti per questa operazione", 403, "forbidden"),
    );
    const { ctx } = makeCtx(client);

    const res = await tool("convert_backlog_to_ticket").handler({ id: ITEM_ID }, ctx);

    expect(res.isError).toBe(true);
    expect(firstText(res)).toContain("Permessi insufficienti");
  });
});

describe("set_ticket_status", () => {
  it("aggiorna lo stato e conferma il nuovo valore (done)", async () => {
    const client = makeClient();
    client.setTicketStatus.mockResolvedValue(fakeTicket({ number: 5, status: "done" }));
    const { ctx } = makeCtx(client);

    const res = await tool("set_ticket_status").handler({ id: TICKET_ID, status: "done" }, ctx);

    expect(client.setTicketStatus).toHaveBeenCalledWith(TICKET_ID, "done");
    expect(res.isError).toBeUndefined();
    expect(firstText(res)).toContain("#5");
    expect(firstText(res)).toContain("'done'");
  });

  it("aggiorna lo stato a in_progress", async () => {
    const client = makeClient();
    client.setTicketStatus.mockResolvedValue(fakeTicket({ status: "in_progress" }));
    const { ctx } = makeCtx(client);

    const res = await tool("set_ticket_status").handler(
      { id: TICKET_ID, status: "in_progress" },
      ctx,
    );

    expect(client.setTicketStatus).toHaveBeenCalledWith(TICKET_ID, "in_progress");
    expect(firstText(res)).toContain("'in_progress'");
  });

  it("lo schema zod rifiuta uno stato fuori enum (validato prima dell'handler)", () => {
    // In produzione l'SDK valida gli argomenti con questo inputSchema PRIMA di
    // invocare l'handler: uno stato non valido non arriva mai al client. Qui lo
    // verifichiamo costruendo l'oggetto zod dalla ZodRawShape del tool.
    const schema = z.object(tool("set_ticket_status").inputSchema);
    const bad = schema.safeParse({ id: TICKET_ID, status: "wontfix" });
    expect(bad.success).toBe(false);
    const good = schema.safeParse({ id: TICKET_ID, status: "triaged" });
    expect(good.success).toBe(true);
  });
});

describe("create_backlog_item (polling)", () => {
  /** Sleep iniettato che risolve subito e conta le chiamate (nessuna attesa reale). */
  function countingSleep() {
    const fn = vi.fn<(ms: number) => Promise<void>>().mockResolvedValue(undefined);
    return fn;
  }

  it("(a) job che diventa 'done' dopo un paio di poll → itemId + URL, senza attese reali", async () => {
    const client = makeClient();
    client.getProjectBySlug.mockResolvedValue(fakeProject({ slug: "acme" }));
    client.createBacklogItem.mockResolvedValue({ queued: true, jobId: JOB_ID });
    client.getBacklogJob
      .mockResolvedValueOnce({ status: "queued", resultItemId: null, error: null })
      .mockResolvedValueOnce({ status: "running", resultItemId: null, error: null })
      .mockResolvedValueOnce({ status: "done", resultItemId: ITEM_ID, error: null });
    const sleep = countingSleep();
    const { ctx } = makeCtx(client, { sleep, pollOptions: { intervalMs: 5, timeoutMs: 10_000 } });

    const res = await tool("create_backlog_item").handler(
      { project: "acme", title: "Idea", body: "Descrizione" },
      ctx,
    );

    expect(client.createBacklogItem).toHaveBeenCalledWith({
      projectId: PROJECT_ID,
      title: "Idea",
      body: "Descrizione",
    });
    expect(client.getBacklogJob).toHaveBeenCalledTimes(3);
    // Due attese (dopo queued e dopo running), tutte via lo sleep iniettato.
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(res.isError).toBeUndefined();
    expect(firstText(res)).toContain(ITEM_ID);
    expect(firstText(res)).toContain(`${BASE_URL}/backlog/${ITEM_ID}`);
    expect(firstText(res)).toContain("frontmatter");
  });

  it("(b) job 'failed' → messaggio di fallimento con l'errore", async () => {
    const client = makeClient();
    client.getProjectBySlug.mockResolvedValue(fakeProject({ slug: "acme" }));
    client.createBacklogItem.mockResolvedValue({ queued: true, jobId: JOB_ID });
    client.getBacklogJob.mockResolvedValue({
      status: "failed",
      resultItemId: null,
      error: "prompt injection rilevata",
    });
    const sleep = countingSleep();
    const { ctx } = makeCtx(client, { sleep, pollOptions: { intervalMs: 5, timeoutMs: 10_000 } });

    const res = await tool("create_backlog_item").handler(
      { project: "acme", title: "Idea", body: "Descrizione" },
      ctx,
    );

    expect(res.isError).toBe(true);
    expect(firstText(res)).toContain("fallita");
    expect(firstText(res)).toContain("prompt injection rilevata");
    expect(sleep).not.toHaveBeenCalled();
  });

  it("(c) TIMEOUT mentre è ancora queued → 'accodata, in corso' NON isError, senza attese reali", async () => {
    const client = makeClient();
    client.getProjectBySlug.mockResolvedValue(fakeProject({ slug: "acme" }));
    client.createBacklogItem.mockResolvedValue({ queued: true, jobId: JOB_ID });
    client.getBacklogJob.mockResolvedValue({ status: "queued", resultItemId: null, error: null });
    const sleep = countingSleep();
    // intervalMs 10, timeoutMs 25 → poll: elapsed 0→10→20, poi 20+10>25 → timeout.
    const { ctx } = makeCtx(client, { sleep, pollOptions: { intervalMs: 10, timeoutMs: 25 } });

    const res = await tool("create_backlog_item").handler(
      { project: "acme", title: "Idea", body: "Descrizione" },
      ctx,
    );

    expect(res.isError).toBeUndefined();
    expect(firstText(res)).toContain("accodata");
    expect(firstText(res)).toContain(JOB_ID);
    // Il polling è terminato per timeout accumulato, non per attese reali.
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(10);
  });

  it("(d) auto-merge: resultItemId punta a una voce esistente → id canonico referenziato", async () => {
    const CANONICAL_ID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
    const client = makeClient();
    client.getProjectBySlug.mockResolvedValue(fakeProject({ slug: "acme" }));
    client.createBacklogItem.mockResolvedValue({ queued: true, jobId: JOB_ID });
    client.getBacklogJob.mockResolvedValue({
      status: "done",
      resultItemId: CANONICAL_ID,
      error: null,
    });
    const sleep = countingSleep();
    const { ctx } = makeCtx(client, { sleep, pollOptions: { intervalMs: 5, timeoutMs: 10_000 } });

    const res = await tool("create_backlog_item").handler(
      { project: "acme", title: "Duplicato", body: "Simile a una esistente" },
      ctx,
    );

    expect(res.isError).toBeUndefined();
    expect(firstText(res)).toContain(CANONICAL_ID);
    expect(firstText(res)).toContain(`${BASE_URL}/backlog/${CANONICAL_ID}`);
  });

  it("(e) errore mid-poll transitorio (2 blip sotto soglia) poi 'done' → successo, il blip è tollerato", async () => {
    const client = makeClient();
    client.getProjectBySlug.mockResolvedValue(fakeProject({ slug: "acme" }));
    client.createBacklogItem.mockResolvedValue({ queued: true, jobId: JOB_ID });
    client.getBacklogJob
      .mockRejectedValueOnce(new StubwiseApiError("blip di rete", 502, "bad_gateway"))
      .mockRejectedValueOnce(new StubwiseApiError("altro blip", 503, "unavailable"))
      .mockResolvedValueOnce({ status: "done", resultItemId: ITEM_ID, error: null });
    const sleep = countingSleep();
    const { ctx } = makeCtx(client, { sleep, pollOptions: { intervalMs: 5, timeoutMs: 10_000 } });

    const res = await tool("create_backlog_item").handler(
      { project: "acme", title: "Idea", body: "Descrizione" },
      ctx,
    );

    // I due errori consecutivi sono sotto la soglia: il polling continua e
    // l'esito è il successo, NON un errore.
    expect(res.isError).toBeUndefined();
    expect(firstText(res)).toContain(ITEM_ID);
    expect(firstText(res)).toContain(`${BASE_URL}/backlog/${ITEM_ID}`);
    // 3 chiamate (2 in errore + 1 done), con un'attesa dopo ogni blip.
    expect(client.getBacklogJob).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it("(f) errori mid-poll PERSISTENTI (> soglia) → 'accodata' NON isError con jobId, si ferma presto", async () => {
    const client = makeClient();
    client.getProjectBySlug.mockResolvedValue(fakeProject({ slug: "acme" }));
    client.createBacklogItem.mockResolvedValue({ queued: true, jobId: JOB_ID });
    client.getBacklogJob.mockRejectedValue(new StubwiseApiError("rete giù", 502, "bad_gateway"));
    const sleep = countingSleep();
    // Timeout ampio: la terminazione è per errori consecutivi, NON per timeout.
    const { ctx } = makeCtx(client, { sleep, pollOptions: { intervalMs: 5, timeoutMs: 10_000 } });

    const res = await tool("create_backlog_item").handler(
      { project: "acme", title: "Idea", body: "Descrizione" },
      ctx,
    );

    // Esito PENDING non-eccezionale, con jobId referenziabile e nota sulla verifica.
    expect(res.isError).toBeUndefined();
    expect(firstText(res)).toContain("accodata");
    expect(firstText(res)).toContain(JOB_ID);
    expect(firstText(res)).toContain("verifica dello stato non riuscita");
    // Si ferma dopo MAX_CONSECUTIVE_POLL_ERRORS (3) + 1 tick, non fino al timeout
    // (che con intervalMs 5 / timeout 10_000 sarebbero ~2000 poll).
    expect(client.getBacklogJob).toHaveBeenCalledTimes(4);
    expect(sleep).toHaveBeenCalledTimes(3);
  });

  it("(g) 'done' senza resultItemId → errorResult (guardia)", async () => {
    const client = makeClient();
    client.getProjectBySlug.mockResolvedValue(fakeProject({ slug: "acme" }));
    client.createBacklogItem.mockResolvedValue({ queued: true, jobId: JOB_ID });
    client.getBacklogJob.mockResolvedValue({ status: "done", resultItemId: null, error: null });
    const sleep = countingSleep();
    const { ctx } = makeCtx(client, { sleep, pollOptions: { intervalMs: 5, timeoutMs: 10_000 } });

    const res = await tool("create_backlog_item").handler(
      { project: "acme", title: "Idea", body: "Descrizione" },
      ctx,
    );

    expect(res.isError).toBe(true);
    expect(firstText(res)).toContain("senza id risultante");
    expect(firstText(res)).toContain(JOB_ID);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("senza progetto risolvibile ritorna errore /stubwise:init e non accoda nulla", async () => {
    const client = makeClient();
    const { ctx } = makeCtx(client, { config: { projectSlug: null } as StubwiseConfig });

    const res = await tool("create_backlog_item").handler({ title: "X", body: "Y" }, ctx);

    expect(res.isError).toBe(true);
    expect(firstText(res)).toContain("/stubwise:init");
    expect(client.createBacklogItem).not.toHaveBeenCalled();
  });
});

describe("create_backlog_from_design", () => {
  it("risolve il progetto, salva il design verbatim e ritorna itemId + URL", async () => {
    const client = makeClient();
    client.getProjectBySlug.mockResolvedValue(fakeProject({ slug: "acme" }));
    const url = `${BASE_URL}/backlog/${ITEM_ID}`;
    client.createBacklogFromDesign.mockResolvedValue({ itemId: ITEM_ID, url });
    const { ctx } = makeCtx(client);

    const res = await tool("create_backlog_from_design").handler(
      { project: "acme", title: "Feature X", design: "# Design\nCorpo completo" },
      ctx,
    );

    expect(client.getProjectBySlug).toHaveBeenCalledWith("acme");
    expect(client.createBacklogFromDesign).toHaveBeenCalledWith(
      PROJECT_ID,
      "Feature X",
      "# Design\nCorpo completo",
    );
    expect(res.isError).toBeUndefined();
    expect(firstText(res)).toContain(ITEM_ID);
    expect(firstText(res)).toContain(url);
  });

  it("un errore del client diventa un ToolResult isError, non lancia", async () => {
    const client = makeClient();
    client.getProjectBySlug.mockResolvedValue(fakeProject({ slug: "acme" }));
    client.createBacklogFromDesign.mockRejectedValue(
      new StubwiseApiError("Errore Stubwise (HTTP 500)", 500, "api_error"),
    );
    const { ctx } = makeCtx(client);

    const res = await tool("create_backlog_from_design").handler(
      { project: "acme", title: "T", design: "D" },
      ctx,
    );

    expect(res.isError).toBe(true);
    expect(firstText(res)).toContain("Errore Stubwise");
  });

  it("senza progetto risolvibile ritorna errore /stubwise:init e non crea nulla", async () => {
    const client = makeClient();
    const { ctx } = makeCtx(client, { config: { projectSlug: null } as StubwiseConfig });

    const res = await tool("create_backlog_from_design").handler(
      { title: "X", design: "Y" },
      ctx,
    );

    expect(res.isError).toBe(true);
    expect(firstText(res)).toContain("/stubwise:init");
    expect(client.createBacklogFromDesign).not.toHaveBeenCalled();
  });
});

describe("set_design / delete_design / set_plan / delete_plan", () => {
  it("set_design chiama client.setDesign(target, id, content) e conferma con URL", async () => {
    const client = makeClient();
    client.setDesign.mockResolvedValue({ id: ITEM_ID });
    const { ctx } = makeCtx(client);

    const res = await tool("set_design").handler(
      { target: "backlog", id: ITEM_ID, content: "# Design" },
      ctx,
    );

    expect(client.setDesign).toHaveBeenCalledWith("backlog", ITEM_ID, "# Design");
    expect(res.isError).toBeUndefined();
    expect(firstText(res)).toContain(`${BASE_URL}/backlog/${ITEM_ID}`);
  });

  it("set_design su ticket usa l'URL /tickets nel messaggio", async () => {
    const client = makeClient();
    client.setDesign.mockResolvedValue({ id: TICKET_ID });
    const { ctx } = makeCtx(client);

    const res = await tool("set_design").handler(
      { target: "ticket", id: TICKET_ID, content: "corpo" },
      ctx,
    );

    expect(client.setDesign).toHaveBeenCalledWith("ticket", TICKET_ID, "corpo");
    expect(firstText(res)).toContain(`${BASE_URL}/tickets/${TICKET_ID}`);
  });

  it("delete_design chiama client.deleteDesign(target, id)", async () => {
    const client = makeClient();
    client.deleteDesign.mockResolvedValue({ id: ITEM_ID });
    const { ctx } = makeCtx(client);

    const res = await tool("delete_design").handler({ target: "backlog", id: ITEM_ID }, ctx);

    expect(client.deleteDesign).toHaveBeenCalledWith("backlog", ITEM_ID);
    expect(res.isError).toBeUndefined();
    expect(firstText(res)).toContain(`${BASE_URL}/backlog/${ITEM_ID}`);
  });

  it("set_plan chiama client.setPlan(target, id, content)", async () => {
    const client = makeClient();
    client.setPlan.mockResolvedValue({ id: TICKET_ID });
    const { ctx } = makeCtx(client);

    const res = await tool("set_plan").handler(
      { target: "ticket", id: TICKET_ID, content: "step 1" },
      ctx,
    );

    expect(client.setPlan).toHaveBeenCalledWith("ticket", TICKET_ID, "step 1");
    expect(res.isError).toBeUndefined();
    expect(firstText(res)).toContain(`${BASE_URL}/tickets/${TICKET_ID}`);
  });

  it("delete_plan chiama client.deletePlan(target, id)", async () => {
    const client = makeClient();
    client.deletePlan.mockResolvedValue({ id: ITEM_ID });
    const { ctx } = makeCtx(client);

    const res = await tool("delete_plan").handler({ target: "backlog", id: ITEM_ID }, ctx);

    expect(client.deletePlan).toHaveBeenCalledWith("backlog", ITEM_ID);
    expect(res.isError).toBeUndefined();
  });

  it("un errore del client (404 nessun design) diventa un ToolResult isError, non lancia", async () => {
    const client = makeClient();
    client.deleteDesign.mockRejectedValue(
      new StubwiseApiError("No active design to remove", 404, "no_active_design"),
    );
    const { ctx } = makeCtx(client);

    const res = await tool("delete_design").handler({ target: "ticket", id: TICKET_ID }, ctx);

    expect(res.isError).toBe(true);
    expect(firstText(res)).toContain("No active design to remove");
  });
});

describe("run_ticket", () => {
  it("202 queued: conferma l'avvio e mette l'URL del ticket nell'output", async () => {
    const client = makeClient();
    client.runTicket.mockResolvedValue({ jobId: JOB_ID, status: "queued" });
    const { ctx } = makeCtx(client);

    const res = await tool("run_ticket").handler({ id: TICKET_ID }, ctx);

    expect(client.runTicket).toHaveBeenCalledWith(TICKET_ID, { mode: undefined });
    expect(res.isError).toBeUndefined();
    expect(firstText(res)).toContain("prenderà in carico");
    // Un run che pianifica può fermarsi su una domanda: il testo lo dice e
    // toglie la tentazione di rilanciare il tool vedendo il job fermo.
    expect(firstText(res)).toContain("domanda");
    expect(firstText(res)).toContain("senza rilanciare run_ticket");
    expect(firstText(res)).toContain(JOB_ID);
    expect(firstText(res)).toContain(`${BASE_URL}/tickets/${TICKET_ID}`);
  });

  it("202 awaiting_plan_approval: dice che serve l'approvazione di un maintainer", async () => {
    const client = makeClient();
    client.runTicket.mockResolvedValue({ jobId: JOB_ID, status: "awaiting_plan_approval" });
    const { ctx } = makeCtx(client);

    const res = await tool("run_ticket").handler({ id: TICKET_ID }, ctx);

    expect(res.isError).toBeUndefined();
    expect(firstText(res)).toContain("approvazione");
    // L'agente non deve rilanciare il tool aspettando l'approvazione.
    expect(firstText(res)).toContain("non rilanciare run_ticket");
    expect(firstText(res)).toContain(JOB_ID);
    expect(firstText(res)).toContain(`${BASE_URL}/tickets/${TICKET_ID}`);
  });

  it("inoltra mode 'ai_plan' al client", async () => {
    const client = makeClient();
    client.runTicket.mockResolvedValue({ jobId: JOB_ID, status: "queued" });
    const { ctx } = makeCtx(client);

    await tool("run_ticket").handler({ id: TICKET_ID, mode: "ai_plan" }, ctx);

    expect(client.runTicket).toHaveBeenCalledWith(TICKET_ID, { mode: "ai_plan" });
  });

  it("409 job_in_flight: messaggio parlante con lo stato del server e l'URL", async () => {
    const client = makeClient();
    client.runTicket.mockRejectedValue(
      new StubwiseApiError("A job for this ticket is already running", 409, "job_in_flight"),
    );
    const { ctx } = makeCtx(client);

    const res = await tool("run_ticket").handler({ id: TICKET_ID }, ctx);

    expect(res.isError).toBe(true);
    expect(firstText(res)).toContain("C'è già un job in corso per questo ticket");
    expect(firstText(res)).toContain("A job for this ticket is already running");
    // Il job in volo può essere fermo sul gate del piano: il testo lo dice.
    expect(firstText(res)).toContain("che un maintainer lo approvi");
    expect(firstText(res)).toContain(`${BASE_URL}/tickets/${TICKET_ID}`);
  });

  it("403: propaga il messaggio di permessi insufficienti come ToolResult isError", async () => {
    const client = makeClient();
    client.runTicket.mockRejectedValue(
      new StubwiseApiError(
        "Permessi insufficienti per questa operazione (il token eredita i permessi del tuo utente)",
        403,
        "forbidden",
      ),
    );
    const { ctx } = makeCtx(client);

    const res = await tool("run_ticket").handler({ id: TICKET_ID }, ctx);

    expect(res.isError).toBe(true);
    expect(firstText(res)).toContain("Permessi insufficienti");
  });

  it("404: propaga il messaggio di ticket non trovato", async () => {
    const client = makeClient();
    client.runTicket.mockRejectedValue(
      new StubwiseApiError("Ticket not found", 404, "ticket_not_found"),
    );
    const { ctx } = makeCtx(client);

    const res = await tool("run_ticket").handler({ id: TICKET_ID }, ctx);

    expect(res.isError).toBe(true);
    expect(firstText(res)).toContain("Ticket not found");
  });
});

describe("registerWriteTools", () => {
  it("registra tutti i tool di scrittura con i nomi attesi", () => {
    const client = makeClient();
    const { ctx } = makeCtx(client);
    const registerTool = vi.fn<(...args: unknown[]) => unknown>();
    const server = { registerTool } as unknown as Parameters<typeof registerWriteTools>[0];

    registerWriteTools(server, ctx);

    expect(registerTool).toHaveBeenCalledTimes(10);
    const names = registerTool.mock.calls.map((c) => c[0]);
    expect(names).toEqual([
      "create_ticket",
      "convert_backlog_to_ticket",
      "set_ticket_status",
      "run_ticket",
      "create_backlog_item",
      "create_backlog_from_design",
      "set_design",
      "delete_design",
      "set_plan",
      "delete_plan",
    ]);
    for (const call of registerTool.mock.calls) {
      expect(call[1]).toHaveProperty("description");
      expect(call[1]).toHaveProperty("inputSchema");
      expect(typeof call[2]).toBe("function");
    }
  });
});
