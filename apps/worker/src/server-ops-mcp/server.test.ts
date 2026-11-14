import { SERVER_ANALYSIS_TOOLS, SERVER_FIX_TOOLS, SERVER_MCP_SERVER_NAME } from "@stubwise/shared";
import { describe, expect, it } from "vitest";
import { SERVER_OPS_SERVER_NAME, SERVER_OPS_TOOL_DEFS, loadServerOpsMcpConfig } from "./server.js";

// Area 8, F4b, S5: l'entry autonoma resta ALLINEATA a `@stubwise/shared`.
describe("server MCP stubwise_server", () => {
  it("nome e strumenti identici a quelli di shared (nessuno in più)", () => {
    expect(SERVER_OPS_SERVER_NAME).toBe(SERVER_MCP_SERVER_NAME);
    expect(new Set(SERVER_OPS_TOOL_DEFS.map((t) => t.name))).toEqual(new Set([...SERVER_ANALYSIS_TOOLS, ...SERVER_FIX_TOOLS]));
    expect(SERVER_OPS_TOOL_DEFS).toHaveLength(new Set([...SERVER_ANALYSIS_TOOLS, ...SERVER_FIX_TOOLS]).size);
  });

  it("senza URL o segreto del ponte non parte", () => {
    expect(() => loadServerOpsMcpConfig({ SERVER_OPS_BRIDGE_SECRET: "s" })).toThrow(/URL/);
    expect(() => loadServerOpsMcpConfig({ SERVER_OPS_BRIDGE_URL: "http://127.0.0.1:1" })).toThrow(/SECRET/);
  });
});
