import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { LATEST_PLUGIN_VERSION } from "./plugin-version.js";

/**
 * PARITÀ della versione del plugin Claude Code «stubwise», sul repository vero.
 *
 * La fonte è `plugins/stubwise/package.json` (la alza Changesets); le copie le
 * riscrive `scripts/sync-plugin-version.mjs` nella PR di versioning. Se una
 * copia diverge — una modifica a mano, o la sincronizzazione saltata — gli
 * utenti riceverebbero un plugin la cui versione non dice il vero: Claude Code
 * non vedrebbe l'aggiornamento, o il server MCP avviserebbe a vuoto.
 */
const root = fileURLToPath(new URL("../../../", import.meta.url));

function readJson(rel: string): Record<string, unknown> {
  return JSON.parse(readFileSync(root + rel, "utf8")) as Record<string, unknown>;
}

describe("versione del plugin Claude Code", () => {
  const source = readJson("plugins/stubwise/package.json").version;

  it("la fonte ha una versione", () => {
    expect(typeof source).toBe("string");
  });

  it("plugin.json dice la stessa versione del package.json del plugin", () => {
    expect(readJson("plugins/stubwise/.claude-plugin/plugin.json").version).toBe(source);
  });

  it("il .mcp.json del plugin passa la stessa versione al server", () => {
    const mcp = readJson("plugins/stubwise/.mcp.json") as {
      mcpServers: Record<string, { env?: Record<string, string> }>;
    };
    expect(mcp.mcpServers.stubwise?.env?.STUBWISE_PLUGIN_VERSION).toBe(source);
  });

  it("la costante compilata in @stubwise/mcp è la stessa versione", () => {
    expect(LATEST_PLUGIN_VERSION).toBe(source);
  });

  it("la voce del marketplace non porta una versione sua (vince il manifest)", () => {
    const marketplace = readJson(".claude-plugin/marketplace.json") as {
      plugins: Array<{ name: string; version?: string }>;
    };
    const entry = marketplace.plugins.find((p) => p.name === "stubwise");
    expect(entry).toBeDefined();
    expect(entry?.version).toBeUndefined();
  });
});
