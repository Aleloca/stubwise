import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  PLUGIN_VERSION_FILES,
  readPluginVersion,
  renderPluginVersionModule,
  syncPluginVersion,
} from "./plugin-version.mjs";

/**
 * Radice finta con le quattro copie della versione del plugin, tutte
 * disallineate rispetto alla fonte (il package.json del plugin): così ogni
 * file deve essere riscritto, e un file dimenticato dallo script resta
 * visibilmente indietro.
 */
function makeRoot(dir: string, version: string): void {
  mkdirSync(join(dir, "plugins/stubwise/.claude-plugin"), { recursive: true });
  mkdirSync(join(dir, "packages/mcp/src"), { recursive: true });
  writeFileSync(
    join(dir, PLUGIN_VERSION_FILES.packageJson),
    JSON.stringify({ name: "@stubwise/claude-plugin", version, private: true }, null, 2) + "\n",
  );
  writeFileSync(
    join(dir, PLUGIN_VERSION_FILES.manifest),
    JSON.stringify({ name: "stubwise", version: "0.0.1", description: "x" }, null, 2) + "\n",
  );
  writeFileSync(
    join(dir, PLUGIN_VERSION_FILES.mcpJson),
    JSON.stringify(
      {
        mcpServers: {
          stubwise: {
            command: "npx",
            args: ["-y", "@stubwise/mcp"],
            env: { STUBWISE_TOKEN: "${STUBWISE_TOKEN:-}", STUBWISE_PLUGIN_VERSION: "0.0.1" },
          },
        },
      },
      null,
      2,
    ) + "\n",
  );
  writeFileSync(join(dir, PLUGIN_VERSION_FILES.mcpConstant), renderPluginVersionModule("0.0.1"));
}

describe("syncPluginVersion", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "stubwise-plugin-version-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("copia la versione del package.json del plugin nelle tre copie", () => {
    makeRoot(dir, "1.4.2");

    const changed = syncPluginVersion(dir);

    expect(changed.sort()).toEqual(
      [
        PLUGIN_VERSION_FILES.manifest,
        PLUGIN_VERSION_FILES.mcpJson,
        PLUGIN_VERSION_FILES.mcpConstant,
      ].sort(),
    );
    const manifest = JSON.parse(readFileSync(join(dir, PLUGIN_VERSION_FILES.manifest), "utf8"));
    expect(manifest.version).toBe("1.4.2");
    // Il resto del manifest non si tocca.
    expect(manifest.description).toBe("x");
    const mcp = JSON.parse(readFileSync(join(dir, PLUGIN_VERSION_FILES.mcpJson), "utf8"));
    expect(mcp.mcpServers.stubwise.env.STUBWISE_PLUGIN_VERSION).toBe("1.4.2");
    // Le altre variabili restano com'erano, `${…:-}` compreso.
    expect(mcp.mcpServers.stubwise.env.STUBWISE_TOKEN).toBe("${STUBWISE_TOKEN:-}");
    expect(readFileSync(join(dir, PLUGIN_VERSION_FILES.mcpConstant), "utf8")).toContain(
      'export const LATEST_PLUGIN_VERSION = "1.4.2";',
    );
  });

  it("una seconda esecuzione non cambia niente", () => {
    makeRoot(dir, "1.4.2");
    syncPluginVersion(dir);

    expect(syncPluginVersion(dir)).toEqual([]);
  });

  it("rifiuta un .mcp.json senza il server stubwise invece di inventarlo", () => {
    makeRoot(dir, "1.4.2");
    writeFileSync(join(dir, PLUGIN_VERSION_FILES.mcpJson), JSON.stringify({ mcpServers: {} }));

    expect(() => syncPluginVersion(dir)).toThrow(/stubwise/);
  });
});

describe("readPluginVersion", () => {
  it("rifiuta una versione mancante", () => {
    const dir = mkdtempSync(join(tmpdir(), "stubwise-plugin-version-"));
    try {
      mkdirSync(join(dir, "plugins/stubwise"), { recursive: true });
      writeFileSync(join(dir, PLUGIN_VERSION_FILES.packageJson), "{}");
      expect(() => readPluginVersion(dir)).toThrow(/version/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
