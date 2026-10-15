import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it, vi } from "vitest";
import { buildRefineMcpServer, loadRefineMcpConfig } from "./server.js";

async function connect(fetchImpl: typeof fetch) {
  const server = buildRefineMcpServer({ bridgeUrl: "http://127.0.0.1:9", secret: "s3cret" }, fetchImpl);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "t", version: "0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
}

describe("server MCP stubwise_refine", () => {
  it("espone i tre tool", async () => {
    const client = await connect(vi.fn());
    expect((await client.listTools()).tools.map((t) => t.name).sort()).toEqual(["set_design", "set_plan", "update_item"]);
  });

  it("inoltra al ponte col segreto e restituisce il messaggio", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      new Response(JSON.stringify({ ok: true, message: "Plan saved on the backlog item." }), { status: 200 }));
    const client = await connect(fetchImpl);
    const res = await client.callTool({ name: "set_plan", arguments: { markdown: "# P" } });
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(String(url)).toBe("http://127.0.0.1:9/tools/set_plan");
    expect(new Headers(init!.headers).get("authorization")).toBe("Bearer s3cret");
    expect(JSON.parse(String(init!.body))).toEqual({ markdown: "# P" });
    expect(res.isError).toBeFalsy();
    expect(JSON.stringify(res.content)).toContain("Plan saved");
  });

  it("un errore del ponte arriva all'agente come isError col messaggio", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      new Response(JSON.stringify({ ok: false, error: "item_closed", message: "The backlog item is converted" }), { status: 409 }));
    const client = await connect(fetchImpl);
    const res = await client.callTool({ name: "update_item", arguments: { title: "x" } });
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.content)).toContain("converted");
  });

  it("ponte irraggiungibile: isError, mai un'eccezione che chiude il server", async () => {
    const client = await connect(vi.fn<typeof fetch>(async () => { throw new Error("ECONNREFUSED"); }));
    const res = await client.callTool({ name: "set_design", arguments: { markdown: "x" } });
    expect(res.isError).toBe(true);
  });

  it("config: URL e segreto obbligatori", () => {
    expect(() => loadRefineMcpConfig({})).toThrow(/REFINE_BRIDGE_URL/);
    expect(loadRefineMcpConfig({ REFINE_BRIDGE_URL: "http://127.0.0.1:1", REFINE_BRIDGE_SECRET: "s" }))
      .toEqual({ bridgeUrl: "http://127.0.0.1:1", secret: "s" });
  });
});
