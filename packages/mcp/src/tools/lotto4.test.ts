import { describe, expect, it, vi } from "vitest";

import type { StubwiseClient } from "../client.js";
import type { StubwiseConfig } from "../config.js";
import { actionTools } from "./actions.js";
import { fileTools } from "./files.js";
import { LOTTO2_CATALOG } from "./lotto2.fixture.js";
import { LOTTO3_CATALOG } from "./lotto3.fixture.js";
import { LOTTO4_CATALOG } from "./lotto4.fixture.js";
import type { ToolContext, ToolDef, ToolResult } from "./types.js";

/**
 * Lotto 4 della parità (Chat, Claude, documenti di prodotto, Docs e grafo):
 * le voci si trovano fra i vicini veri dei lotti 2–4 e si chiamano coi tool.
 * Messaggi, conversazioni e documenti sono contenuto non fidato; ciò che
 * avvia lavoro dell'AI lo dice.
 */
const config: StubwiseConfig = { baseUrl: "https://stubwise.example.com", token: "stw_pat_x", projectSlug: null };
const CATALOG = [...LOTTO2_CATALOG, ...LOTTO3_CATALOG, ...LOTTO4_CATALOG];

function tool(name: string): ToolDef {
  const t = [...actionTools, ...fileTools].find((d) => d.name === name);
  if (!t) throw new Error(`manca ${name}`);
  return t;
}
function ctxWith(client: Partial<Record<keyof StubwiseClient, unknown>>): ToolContext {
  return { client: client as unknown as StubwiseClient, config };
}
const text = (r: ToolResult) => r.content[0]?.text ?? "";
const entry = (action: string) => {
  const e = LOTTO4_CATALOG.find((x) => x.action === action);
  if (!e) throw new Error(`manca la voce ${action}`);
  return e;
};
async function top(query: string, n = 3): Promise<string[]> {
  const r = await tool("find_actions").handler({ query }, ctxWith({ getCatalog: vi.fn().mockResolvedValue(CATALOG) }));
  expect(r.isError).toBeUndefined();
  return text(r)
    .split("\n")
    .filter((l) => l.startsWith("- "))
    .slice(0, n)
    .map((l) => l.slice(2).split(" ")[0]!);
}

describe("lotto 4: le voci si trovano con le parole di chi chiede", () => {
  const cases: [area: string, query: string, action: string][] = [
    ["Chat", "scrivi un messaggio nel canale", "chat.send"],
    ["Chat", "apri un dm con marco", "chat.openDm"],
    ["Chat", "cerca nei messaggi della chat", "chat.search"],
    ["Claude", "conferma la proposta di claude", "claude.confirmProposal"],
    ["Claude", "annulla le azioni di claude", "claude.undo"],
    ["Claude", "rendi pubblica la conversazione con claude", "claude.setVisibility"],
    ["Doc di prodotto", "commenta la pagina di prodotto", "productDocs.comment"],
    ["Doc di prodotto", "disegna la bozza di una schermata", "productDocs.drawWireframe"],
    ["Docs", "domanda sui docs del repository", "docs.askRepository"],
    ["Docs", "crea una pagina docs manuale", "docs.createManual"],
    ["Docs", "rigenera il grafo del codice", "graph.generate"],
  ];
  it.each(cases)("%s: «%s» → %s", async (_area, query, action) => {
    expect(await top(query)).toContain(action);
  });
});

describe("lotto 4: le regole delle voci", () => {
  // La nota del contenuto non fidato la verifica il test di parità sullo schema
  // di risposta (UNTRUSTED_SCHEMAS), con le sue eccezioni motivate.

  it("ciò che avvia lavoro dell'AI lo dice, con il budget", () => {
    const spend = ["chat.send", "chat.answerClaude", "chat.retryClaude", "claude.createConversation", "claude.continue", "claude.answer", "claude.confirmProposal", "productDocs.startFirstVersion", "productDocs.drawWireframe", "productDocs.redrawWireframe", "productDocs.updateFromSource", "productDocs.answer", "docs.generate", "docs.resume", "docs.askProject", "docs.askRepository", "mail.claudeDraft"];
    for (const a of spend) expect(entry(a).note, a).toContain("spende budget");
  });

  it("la conferma di una proposta dice della riconferma parziale", () => {
    expect(entry("claude.confirmProposal").note).toContain("session_required");
  });

  it("i file passano dai tool: allegati della Chat, immagini, export dei Docs, grafo", () => {
    expect(entry("chat.uploadAttachment").tool).toBe("upload_file");
    expect(entry("productDocs.uploadImage").tool).toBe("upload_file");
    for (const a of ["chat.downloadAttachment", "productDocs.image", "docs.export", "graph.download", "graph.html"]) expect(entry(a).tool, a).toBe("download_file");
  });

  it("una rotta SSE finita usa la sua forma non stream: la bozza di Claude e le chat dei Docs con `stream=false`", () => {
    for (const a of ["mail.claudeDraft", "docs.askProject", "docs.askRepository"]) expect(entry(a).note, a).toContain("`stream=false`");
  });

  it("confermare e annullare le azioni di Claude sono `destructive`; la conferma dice la classe C", () => {
    expect(entry("claude.confirmProposal").effect).toBe("destructive");
    expect(entry("claude.undo").effect).toBe("destructive");
    expect(entry("claude.confirmProposal").note).toContain("classe C");
    expect(entry("graph.setupPr").effect).toBe("destructive");
  });

  it("la proposta del turno di Claude non è una voce: la chiama solo il suo token", () => {
    expect(LOTTO4_CATALOG.some((e) => e.method === "POST" && e.path === "/api/claude/conversations/:id/proposals")).toBe(false);
  });
});

describe("lotto 4: le voci si chiamano", () => {
  it("write_action: conferma una proposta di Claude, coi permessi di chi chiede", async () => {
    const callAction = vi.fn().mockResolvedValue({ status: 200, data: { status: "done" } });
    const r = await tool("write_action").handler({ action: "claude.confirmProposal", params: { id: "pr1" } }, ctxWith({ getCatalog: vi.fn().mockResolvedValue(CATALOG), callAction }));
    expect(r.isError).toBeUndefined();
    expect(callAction).toHaveBeenCalledWith(entry("claude.confirmProposal"), { params: { id: "pr1" } });
  });

  it("read_action: i messaggi di un canale; e lo scaricamento di un allegato rimanda a download_file", async () => {
    const callAction = vi.fn().mockResolvedValue({ status: 200, data: { items: [] } });
    const ctx = ctxWith({ getCatalog: vi.fn().mockResolvedValue(CATALOG), callAction });
    await tool("read_action").handler({ action: "chat.messages", params: { id: "c1" } }, ctx);
    expect(callAction).toHaveBeenCalledWith(entry("chat.messages"), { params: { id: "c1" } });
    const refused = await tool("read_action").handler({ action: "chat.downloadAttachment", params: { id: "a1" } }, ctx);
    expect(refused.isError).toBe(true);
    expect(text(refused)).toContain("`download_file`");
  });
});
