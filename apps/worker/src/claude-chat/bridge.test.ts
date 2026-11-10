import { afterEach, describe, expect, it, vi } from "vitest";
import { CHAT_MCP_SERVER_NAME, CHAT_TOOLS } from "@stubwise/shared";
import { buildChatMcpServer, CHAT_SERVER_NAME } from "../chat-mcp/server.js";
import { ChatToolArgError, chatServerPaths, startChatBridge, type ChatBridge } from "./bridge.js";

// Il ponte dei tool di lettura della chat (fetta 1): ogni tool diventa una o
// più GET sul server col token del turno (la visibilità dell'autore); il token
// non esce mai dal ponte, e un «non trovato» non dice se l'oggetto esiste.

let bridge: ChatBridge | undefined;
afterEach(async () => {
  await bridge?.close();
  bridge = undefined;
});

const call = (b: ChatBridge, secret: string, tool: string, args: unknown) =>
  fetch(`${b.url}/tools/${tool}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${secret}` },
    body: JSON.stringify(args),
  });

describe("il ponte dei tool della chat", () => {
  it("i nomi del server MCP sono quelli di @stubwise/shared", () => {
    expect(CHAT_SERVER_NAME).toBe(CHAT_MCP_SERVER_NAME);
    const registered = (buildChatMcpServer({ bridgeUrl: "http://x", secret: "s" }) as unknown as {
      _registeredTools: Record<string, unknown>;
    })._registeredTools;
    expect(Object.keys(registered).sort()).toEqual([...CHAT_TOOLS].sort());
    const P = "6f1c2a52-1d7b-4c3e-9a51-0b6a7f2e1a01";
    for (const tool of CHAT_TOOLS) {
      const code = tool === "read_request" ? "AUD-R1" : "AUD-1";
      expect(chatServerPaths(tool, { code, projectId: P, query: "q" }).length).toBeGreaterThan(0);
    }
  });

  it("ogni tool è una GET di lettura sul server col token del turno", async () => {
    const seen: { url: string; auth: string | null; method: string }[] = [];
    const fetchImpl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      seen.push({ url: String(url), auth: new Headers(init?.headers).get("authorization"), method: init?.method ?? "GET" });
      return Response.json([{ id: "p1", code: "AUD", name: "Audin", description: null, ingestionKey: "segreto" }]);
    });
    bridge = await startChatBridge({ serverUrl: "http://server:3000", fetchImpl: fetchImpl as never });
    const grant = bridge.grant({ sessionId: "s1", serverToken: "stw_chat_token-del-turno" });
    const res = await call(bridge, grant.secret, "list_projects", {});
    const body = (await res.json()) as { ok: boolean; text: string };
    expect(body.ok).toBe(true);
    expect(seen).toEqual([{ url: "http://server:3000/api/projects", auth: "Bearer stw_chat_token-del-turno", method: "GET" }]);
    // Il token non torna mai all'agente; nemmeno i campi che non servono a rispondere.
    expect(body.text).not.toContain("stw_chat_");
    expect(body.text).not.toContain("segreto");
    expect(body.text).toContain("AUD");
  });

  it("i percorsi dei tool: testo e progetto nella query, codici nel percorso", () => {
    const P = "6f1c2a52-1d7b-4c3e-9a51-0b6a7f2e1a01";
    expect(chatServerPaths("search_tasks", { text: "csv export", projectId: P })).toEqual([
      `/api/tasks?text=csv+export&projectIds=${P}&families=todo%2Cactive`,
    ]);
    expect(chatServerPaths("search_tasks", { includeClosed: true })).toEqual(["/api/tasks"]);
    expect(chatServerPaths("read_task", { code: "aud-12" })).toEqual(["/api/tasks/by-code/AUD-12"]);
    expect(chatServerPaths("read_request", { code: "aud-r4" })).toEqual(["/api/requests/by-code/AUD-R4"]);
    expect(chatServerPaths("search_docs", { projectId: P, query: "login" })).toEqual([
      `/api/projects/${P}/docs/search?q=login`,
    ]);
    expect(chatServerPaths("read_project_overview", { projectId: P })).toEqual([
      `/api/projects/${P}/briefs/latest`,
      `/api/projects/${P}/decisions?limit=50`,
    ]);
  });

  it("codici e progetti si VALIDANO: niente percorsi strani, niente chiamata al server", async () => {
    for (const [tool, args] of [
      ["read_task", { code: "../auth/me" }],
      ["read_task", { code: "AUD-R4" }],
      ["read_request", { code: "AUD-12" }],
      ["search_docs", { projectId: "../../auth", query: "x" }],
      ["read_project_overview", {}],
      ["search_tasks", { projectId: "AUD" }],
    ] as const) {
      expect(() => chatServerPaths(tool, args), `${tool} ${JSON.stringify(args)}`).toThrow(ChatToolArgError);
    }
    const fetchImpl = vi.fn(async () => Response.json([]));
    bridge = await startChatBridge({ serverUrl: "http://server:3000", fetchImpl: fetchImpl as never });
    const grant = bridge.grant({ sessionId: "s1", serverToken: "stw_chat_x" });
    const body = (await (await call(bridge, grant.secret, "read_task", { code: "../auth/me" })).json()) as { ok: boolean; text: string };
    expect(body).toEqual({ ok: false, text: "Invalid code: use one like AUD-12." });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("un 404 (o un 403) del server: «non trovato o non visibile», senza dire quale", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ code: "not_found" }), { status: 404 }));
    bridge = await startChatBridge({ serverUrl: "http://server:3000", fetchImpl: fetchImpl as never });
    const grant = bridge.grant({ sessionId: "s1", serverToken: "stw_chat_x" });
    const body = (await (await call(bridge, grant.secret, "read_task", { code: "ACQ-99" })).json()) as { ok: boolean; text: string };
    expect(body).toEqual({ ok: false, text: "Not found, or not visible to you: ACQ-99." });
  });

  it("segreto revocato o sconosciuto: 401, nessuna chiamata al server", async () => {
    const fetchImpl = vi.fn(async () => Response.json([]));
    bridge = await startChatBridge({ serverUrl: "http://server:3000", fetchImpl: fetchImpl as never });
    const grant = bridge.grant({ sessionId: "s1", serverToken: "stw_chat_x" });
    grant.revoke();
    expect((await call(bridge, grant.secret, "list_projects", {})).status).toBe(401);
    expect((await call(bridge, "inventato", "list_projects", {})).status).toBe(401);
    const other = bridge.grant({ sessionId: "s2", serverToken: "stw_chat_y" });
    bridge.revokeSession("s2");
    expect((await call(bridge, other.secret, "list_projects", {})).status).toBe(401);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
