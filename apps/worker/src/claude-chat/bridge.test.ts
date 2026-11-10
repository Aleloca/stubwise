import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CHAT_MCP_SERVER_NAME, CHAT_READ_TOOLS, CHAT_TOOLS, CLAUDE_PROPOSABLE_FNS } from "@stubwise/shared";
import { buildChatMcpServer, CHAT_SERVER_NAME, PROPOSABLE_FNS } from "../chat-mcp/server.js";
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
    expect([...PROPOSABLE_FNS]).toEqual([...CLAUDE_PROPOSABLE_FNS]);
    const P = "6f1c2a52-1d7b-4c3e-9a51-0b6a7f2e1a01";
    for (const tool of CHAT_READ_TOOLS) {
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

  it("list_people non porta email: solo ciò che serve a trovare una persona", async () => {
    const fetchImpl = vi.fn(async () =>
      Response.json([
        { id: "u1", name: "Marta Rossi", initials: "MR", departmentIds: [], email: "marta@example.com", deactivated: false, isClaude: false, claudeAssignableProjectIds: [] },
        { id: "u2", name: "Claude", initials: "CL", departmentIds: [], email: "claude@stubwise.local", isClaude: true, claudeAssignableProjectIds: ["p1"] },
      ]),
    );
    bridge = await startChatBridge({ serverUrl: "http://server:3000", fetchImpl: fetchImpl as never });
    const grant = bridge.grant({ sessionId: "s1", serverToken: "stw_chat_x" });
    const body = (await (await call(bridge, grant.secret, "list_people", {})).json()) as { ok: boolean; text: string };
    expect(body.ok).toBe(true);
    expect((fetchImpl.mock.calls[0] as unknown[])[0]).toBe("http://server:3000/api/people");
    expect(body.text).toContain("Marta Rossi");
    expect(body.text).toContain('"claudeAssignableProjectIds":["p1"]');
    expect(body.text).not.toContain("@");
    expect(body.text).not.toContain("email");
  });
});

describe("propose_action: il ponte scrive una PROPOSTA e risponde solo con l'esito", () => {
  const SESSION = "0b6a7f2e-1d7b-4c3e-9a51-6f1c2a521a01";
  const actions = [{ fn: "updateTask", args: { id: "6f1c2a52-1d7b-4c3e-9a51-0b6a7f2e1a01", patch: { assigneeId: null } } }];

  async function propose(answer: Response, args: Record<string, unknown> = { actions, summary: "Assegna" }) {
    const seen: { url: string; method: string; auth: string | null; body: Record<string, unknown> }[] = [];
    const fetchImpl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      seen.push({
        url: String(url),
        method: init?.method ?? "GET",
        auth: new Headers(init?.headers).get("authorization"),
        body: JSON.parse(String(init?.body)) as Record<string, unknown>,
      });
      return answer.clone();
    });
    bridge = await startChatBridge({ serverUrl: "http://server:3000", fetchImpl: fetchImpl as never });
    const grant = bridge.grant({ sessionId: SESSION, serverToken: "stw_chat_token-del-turno" });
    const reply = (await (await call(bridge, grant.secret, "propose_action", args)).json()) as { ok: boolean; text: string };
    return { reply, seen };
  }

  it("un POST sulla sola rotta delle proposte, col token del turno e il toolUseId; eseguita → i codici, mai il token", async () => {
    const { reply, seen } = await propose(
      Response.json({ status: "executed", proposalId: SESSION, codes: ["AUD-12"], reason: null, token: "stw_chat_eco" }),
      { actions, summary: "Assegna", toolUseId: "toolu_01ABC" },
    );
    expect(seen).toEqual([
      {
        url: `http://server:3000/api/claude/conversations/${SESSION}/proposals`,
        method: "POST",
        auth: "Bearer stw_chat_token-del-turno",
        body: { toolUseId: "toolu_01ABC", summary: "Assegna", actions },
      },
    ]);
    expect(reply.ok).toBe(true);
    expect(reply.text).toContain("EXECUTED");
    expect(reply.text).toContain("AUD-12");
    expect(reply.text).not.toContain("stw_chat_");
  });

  it("in attesa di conferma: dice che NON è fatto", async () => {
    const { reply } = await propose(Response.json({ status: "awaiting_confirmation", proposalId: SESSION, codes: [], reason: null }));
    expect(reply).toMatchObject({ ok: true });
    expect(reply.text).toContain("NOT DONE YET");
    expect(reply.text).not.toContain("EXECUTED");
  });

  it("rifiutata: il motivo del server, e niente di fatto", async () => {
    const { reply } = await propose(Response.json({ status: "refused", proposalId: null, codes: [], reason: "You can't edit tasks in Audin" }));
    expect(reply).toEqual({ ok: false, text: "REFUSED by Stubwise, nothing was changed: You can't edit tasks in Audin." });
  });

  it("un 400 è un rifiuto; un 404 dice che il turno non può più proporre", async () => {
    expect((await propose(new Response("{}", { status: 400 }))).reply.text).toMatch(/^REFUSED/);
    await bridge?.close();
    expect((await propose(new Response("{}", { status: 404 }))).reply.text).toContain("can no longer propose");
  });

  it("toolUseId mancante o strano: se ne conia uno nuovo (idempotenza solo con quello del CLI)", async () => {
    const { seen } = await propose(Response.json({ status: "awaiting_confirmation", proposalId: SESSION, codes: [] }), {
      actions,
      toolUseId: "../../x",
    });
    expect(seen[0]!.body["toolUseId"]).toMatch(/^chat_[0-9a-f-]{36}$/);
  });

  it("il server MCP inoltra il toolUseId del CLI (`_meta`) al ponte", async () => {
    const forwarded: unknown[] = [];
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      forwarded.push(JSON.parse(String(init?.body)));
      return Response.json({ ok: true, text: "NOT DONE YET" });
    });
    const server = buildChatMcpServer({ bridgeUrl: "http://bridge", secret: "s" }, fetchImpl as never);
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "t", version: "1" });
    await Promise.all([server.connect(a), client.connect(b)]);
    await client.callTool({ name: "propose_action", arguments: { actions, summary: "x" }, _meta: { "claudecode/toolUseId": "toolu_42" } });
    expect(forwarded).toEqual([{ actions, summary: "x", toolUseId: "toolu_42" }]);
    await client.close();
  });
});

describe("sul sorgente del ponte", () => {
  it("una sola chiamata che non è una GET: il POST della proposta, sulla sola rotta di scrittura del token", () => {
    const code = readFileSync(new URL("./bridge.ts", import.meta.url), "utf8");
    const methods = [...code.matchAll(/method: "([A-Z]+)"/g)].map((m) => m[1]);
    expect(methods.sort()).toEqual(["GET", "POST"]);
    const fetchUrls = [...code.matchAll(/fetchImpl\(`\$\{serverUrl\}([^`]*)`/g)].map((m) => m[1]);
    expect(fetchUrls.sort()).toEqual(["${path}", "/api/claude/conversations/${seg(turn.sessionId)}/proposals"].sort());
  });
});
