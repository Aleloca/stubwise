import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it, vi } from "vitest";

import type { StubwiseClient } from "./client.js";
import type { StubwiseConfig } from "./config.js";
import { SERVER_INSTRUCTIONS } from "./instructions.js";
import { SERVER_VERSION, buildServer } from "./server.js";
import type { ToolContext } from "./tools/types.js";

/** Config finta: `buildServer` non la legge, serve solo a comporre il ctx. */
const fakeConfig: StubwiseConfig = {
  baseUrl: "http://localhost:9999",
  token: "stw_pat_test",
  projectSlug: null,
};

/**
 * Contesto minimale: `buildServer` inoltra il ctx agli handler ma non li invoca,
 * quindi un client vuoto castato basta (nessun metodo viene toccato a build-time).
 */
const ctx: ToolContext = {
  client: {} as unknown as StubwiseClient,
  config: fakeConfig,
};

describe("buildServer", () => {
  it("registra tutti i tool (read + write + docs e richieste) con i nomi attesi", () => {
    // Spia il registerTool reale dell'SDK: buildServer usa l'istanza McpServer,
    // così verifichiamo l'assemblaggio end-to-end senza toccare il transport.
    const spy = vi.spyOn(McpServer.prototype, "registerTool");

    const server = buildServer(ctx);
    expect(server).toBeInstanceOf(McpServer);

    const names = spy.mock.calls.map((c) => c[0]);
    expect(names).toEqual([
      "list_projects",
      "list_backlog",
      "get_backlog_item",
      "list_tickets",
      "get_ticket",
      "list_proposals",
      "list_mail_proposals",
      "get_project_brief",
      "list_decisions",
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
      "search_project_docs",
      "read_doc_page",
      "my_requests",
    ]);

    spy.mockRestore();
  });
});

describe("istruzioni di server", () => {
  it("McpServer nasce con le istruzioni per i collaboratori", () => {
    const server = buildServer(ctx);
    // L'SDK le conserva sul Server sottostante e le manda nell'handshake.
    const instructions = (server.server as unknown as { _instructions?: string })._instructions;
    expect(instructions).toBe(SERVER_INSTRUCTIONS);
    expect(SERVER_INSTRUCTIONS.trim().length).toBeGreaterThan(0);
    expect(SERVER_INSTRUCTIONS).toContain("chiedi conferma");
    expect(SERVER_INSTRUCTIONS).not.toContain("/stubwise:init");
    // Un token admin non fa partire l'avviso `request.created`: niente promesse.
    expect(SERVER_INSTRUCTIONS).not.toMatch(/maintainer viene avvisato/);
  });

  it("resta concisa (≤ ~1.500 parole) e non cita comandi distruttivi", () => {
    expect(SERVER_INSTRUCTIONS.split(/\s+/).filter(Boolean).length).toBeLessThanOrEqual(1_600);
    expect(SERVER_INSTRUCTIONS).not.toContain("rm -rf");
  });

  it("nomina i tool che il flusso usa", () => {
    for (const name of [
      "search_project_docs",
      "read_doc_page",
      "my_requests",
      "create_ticket",
      "create_backlog_item",
      "list_projects",
    ]) {
      expect(SERVER_INSTRUCTIONS).toContain(name);
    }
  });
});

describe("SERVER_VERSION", () => {
  it("è la versione dichiarata nel package.json (non un literal disallineato)", () => {
    // Legge il package.json reale del pacchetto: se qualcuno reintroduce un
    // literal hardcoded, questo test lo becca al primo bump di versione.
    const pkgPath = fileURLToPath(new URL("../package.json", import.meta.url));
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { version: string };

    expect(SERVER_VERSION).toBe(pkg.version);
  });
});
