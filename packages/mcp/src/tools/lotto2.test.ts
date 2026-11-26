import { describe, expect, it, vi } from "vitest";

import type { StubwiseClient } from "../client.js";
import type { StubwiseConfig } from "../config.js";
import { actionTools } from "./actions.js";
import { LOTTO2_CATALOG } from "./lotto2.fixture.js";
import type { ToolContext, ToolDef, ToolResult } from "./types.js";

/**
 * Lotto 2 della parità (design `docs/plans/2026-11-26-mcp-parita-design.md`
 * § 4): le voci del lavoro quotidiano si TROVANO con le parole di chi le
 * chiede e si CHIAMANO coi tool generici. Le ricerche girano su tutte le 146
 * voci del lotto (`lotto2.fixture.ts`, copiate dal server), così una voce
 * deve vincere sui suoi vicini veri, non su un catalogo di quattro.
 */
const config: StubwiseConfig = { baseUrl: "https://stubwise.example.com", token: "stw_pat_x", projectSlug: null };

function tool(name: string): ToolDef {
  const t = actionTools.find((d) => d.name === name);
  if (!t) throw new Error(`manca ${name}`);
  return t;
}

function ctxWith(client: Partial<Record<keyof StubwiseClient, unknown>>): ToolContext {
  return { client: client as unknown as StubwiseClient, config };
}

const text = (r: ToolResult) => r.content[0]?.text ?? "";
const entry = (action: string) => {
  const e = LOTTO2_CATALOG.find((x) => x.action === action);
  if (!e) throw new Error(`manca la voce ${action}`);
  return e;
};

/** Le prime `n` azioni che `find_actions` restituisce per una ricerca. */
async function top(query: string, n = 3): Promise<string[]> {
  const ctx = ctxWith({ getCatalog: vi.fn().mockResolvedValue(LOTTO2_CATALOG) });
  const r = await tool("find_actions").handler({ query }, ctx);
  expect(r.isError).toBeUndefined();
  return text(r)
    .split("\n")
    .filter((l) => l.startsWith("- "))
    .slice(0, n)
    .map((l) => l.slice(2).split(" ")[0]!);
}

describe("lotto 2: le voci si trovano con le parole di chi chiede", () => {
  // Per area, una frase come la direbbe una persona → l'azione attesa fra le prime tre.
  const cases: [area: string, query: string, action: string][] = [
    ["Task", "modifica una task", "tasks.update"],
    ["Task", "sposta la task a un altro giorno", "tasks.setDay"],
    ["Task", "elimina la task", "tasks.delete"],
    ["Task", "scrivi un commento", "comments.create"],
    ["Richieste", "archivia la richiesta", "requests.archive"],
    ["Richieste", "fondi una richiesta in un'altra", "requests.merge"],
    ["Home e filtri", "salva un filtro delle task", "filters.create"],
    ["Home e filtri", "fissa il filtro nella barra laterale", "filters.pin"],
    ["Progetti e panoramica", "registra una decisione", "decisions.record"],
    ["Progetti e panoramica", "il polso dei progetti", "projects.pulses"],
    ["Notifiche e ricerca", "rinvia la notifica", "inbox.snooze"],
    ["Notifiche e ricerca", "segna la notifica come letta", "inbox.markRead"],
    ["Persone e attività", "attività del giorno per persona", "people.activity"],
    ["Registro delle modifiche", "registro delle modifiche del progetto", "changeLog.project"],
    // Senza «PR»: oggi la sigla di due lettere fa prefisso a `project` e porta in testa
    // tutte le rotte di /api/projects (segnalato a 72, il punteggio è del lotto 0).
    ["Rilasci e PR", "chiedi una correzione", "pulls.requestCorrection"],
    ["Rilasci e PR", "correggi la pull request", "pulls.requestCorrection"],
    ["Rilasci e PR", "scrivi le note di rilascio", "pulls.setReleaseNotes"],
  ];
  it.each(cases)("%s: «%s» → %s", async (_area, query, action) => {
    expect(await top(query)).toContain(action);
  });
});

describe("lotto 2: le voci si chiamano coi tool generici", () => {
  it("read_action: le task di un progetto, con la query", async () => {
    const callAction = vi.fn().mockResolvedValue({ status: 200, data: { items: [{ code: "ACQ-12" }] } });
    const ctx = ctxWith({ getCatalog: vi.fn().mockResolvedValue(LOTTO2_CATALOG), callAction });
    const r = await tool("read_action").handler({ action: "tasks.list", query: { projectId: "p1" } }, ctx);
    expect(callAction).toHaveBeenCalledWith(entry("tasks.list"), { query: { projectId: "p1" } });
    expect(JSON.parse(text(r))).toEqual({ items: [{ code: "ACQ-12" }] });
  });

  it("read_action: una richiesta dal suo codice, col parametro del percorso", async () => {
    const callAction = vi.fn().mockResolvedValue({ status: 200, data: { code: "ACQ-R3" } });
    const ctx = ctxWith({ getCatalog: vi.fn().mockResolvedValue(LOTTO2_CATALOG), callAction });
    await tool("read_action").handler({ action: "requests.getByCode", params: { code: "ACQ-R3" } }, ctx);
    expect(callAction).toHaveBeenCalledWith(entry("requests.getByCode"), { params: { code: "ACQ-R3" } });
  });

  it("write_action: sposta una task su un giorno, con parametri e corpo", async () => {
    const callAction = vi.fn().mockResolvedValue({ status: 204, data: undefined });
    const ctx = ctxWith({ getCatalog: vi.fn().mockResolvedValue(LOTTO2_CATALOG), callAction });
    const r = await tool("write_action").handler({ action: "tasks.setDay", params: { ticketId: "t1" }, body: { day: "2026-12-03" } }, ctx);
    expect(callAction).toHaveBeenCalledWith(entry("tasks.setDay"), { params: { ticketId: "t1" }, body: { day: "2026-12-03" } });
    expect(text(r)).toBe("Fatto (HTTP 204).");
  });

  it("write_action: archivia una notifica", async () => {
    const callAction = vi.fn().mockResolvedValue({ status: 204, data: undefined });
    const ctx = ctxWith({ getCatalog: vi.fn().mockResolvedValue(LOTTO2_CATALOG), callAction });
    await tool("write_action").handler({ action: "inbox.archive", params: { id: "n1" } }, ctx);
    expect(callAction).toHaveBeenCalledWith(entry("inbox.archive"), { params: { id: "n1" } });
  });

  it("write_action: una voce coperta da un tool di oggi rimanda a quello, senza chiamare", async () => {
    const callAction = vi.fn();
    const ctx = ctxWith({ getCatalog: vi.fn().mockResolvedValue(LOTTO2_CATALOG), callAction });
    const r = await tool("write_action").handler({ action: "tickets.create", body: { title: "x" } }, ctx);
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("`create_ticket`");
    expect(callAction).not.toHaveBeenCalled();
  });

  it("le voci del lotto con un tool nominano solo tool del pacchetto", () => {
    const names = new Set(["create_ticket", "create_backlog_item", "create_backlog_from_design", "convert_backlog_to_ticket", "set_design", "delete_design", "set_plan", "delete_plan"]);
    const withTool = LOTTO2_CATALOG.filter((e) => e.tool !== undefined);
    // Ticket: create, design e piano (5); backlog: create, from-design, convert, design e piano (7).
    expect(withTool.length).toBe(12);
    for (const e of withTool) expect(names.has(e.tool!), e.action).toBe(true);
  });
});
