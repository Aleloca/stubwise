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

  it("il .mcp.json del plugin fissa la versione esatta di @stubwise/mcp", () => {
    // Senza versione, `npx -y` può riusare una copia in cache: l'aggiornamento
    // del plugin non porterebbe con sé il server nuovo.
    const mcp = readJson("plugins/stubwise/.mcp.json") as {
      mcpServers: Record<string, { args?: string[] }>;
    };
    const mcpVersion = readJson("packages/mcp/package.json").version;
    expect(mcp.mcpServers.stubwise?.args).toContain(`@stubwise/mcp@${String(mcpVersion)}`);
  });

  it("plugin e @stubwise/mcp sono nello stesso gruppo `fixed` di Changesets", () => {
    // Ogni rilascio dell'MCP deve alzare anche il plugin: è la `version` del
    // manifest che Claude Code confronta, e senza il pin nuovo non arriva.
    const config = readJson(".changeset/config.json") as { fixed?: string[][] };
    expect(
      config.fixed?.some(
        (group) => group.includes("@stubwise/mcp") && group.includes("@stubwise/claude-plugin"),
      ),
    ).toBe(true);
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
