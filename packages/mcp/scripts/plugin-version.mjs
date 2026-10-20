/**
 * La versione del plugin Claude Code «stubwise» ha UNA fonte e tre copie
 * (più il pin di `@stubwise/mcp`, vedi sotto).
 *
 * Fonte: `plugins/stubwise/package.json` — è quella che Changesets alza nella
 * PR di versioning (il plugin è un pacchetto privato del workspace).
 *
 * Copie, riscritte da `syncPluginVersion` subito dopo `changeset version`
 * (script `version-packages` della radice, lanciato da `release.yml`):
 * - `plugins/stubwise/.claude-plugin/plugin.json` → `version`: è ciò che Claude
 *   Code confronta per decidere se c'è un aggiornamento (la `version` del
 *   manifest vince su tutto, e finché non cambia nessuno riceve niente);
 * - `plugins/stubwise/.mcp.json` → `env.STUBWISE_PLUGIN_VERSION` del server
 *   `stubwise`: è come il server MCP sa quale versione del plugin lo ha avviato;
 * - `packages/mcp/src/plugin-version.ts` → `LATEST_PLUGIN_VERSION`: l'ultima
 *   versione rilasciata, compilata dentro `@stubwise/mcp` per l'avviso
 *   «plugin vecchio».
 *
 *
 * Nello stesso passo `.mcp.json` riceve anche il PIN di `@stubwise/mcp`: negli
 * `args` del server, `@stubwise/mcp@<versione>` con la versione di
 * `packages/mcp/package.json`. Senza versione `npx -y` può riusare una copia in
 * cache, e un plugin aggiornato continuerebbe ad avviare il server vecchio. Il
 * pin nuovo arriva agli utenti solo se sale anche la versione del plugin: per
 * questo i due pacchetti stanno nello stesso gruppo `fixed` di
 * `.changeset/config.json` (escono sempre insieme, con la stessa versione).
 *
 * Changesets non esegue gli script `version` dei pacchetti, per questo la
 * sincronizzazione è un comando a sé dopo `changeset version`. Il test di
 * parità (`packages/mcp/src/plugin-version.test.ts`) fallisce se le quattro
 * divergono, quindi una modifica a mano a una sola copia non arriva su main.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Percorsi, relativi alla radice del monorepo, della fonte e delle copie. */
export const PLUGIN_VERSION_FILES = Object.freeze({
  packageJson: "plugins/stubwise/package.json",
  manifest: "plugins/stubwise/.claude-plugin/plugin.json",
  mcpJson: "plugins/stubwise/.mcp.json",
  mcpConstant: "packages/mcp/src/plugin-version.ts",
  /** Fonte della versione di `@stubwise/mcp`, fissata negli `args` di `.mcp.json`. */
  mcpPackageJson: "packages/mcp/package.json",
});

/** Il pacchetto npm che il server `stubwise` del plugin avvia con `npx`. */
export const MCP_NPM_PACKAGE = "@stubwise/mcp";

/** Nome del server MCP del plugin, dentro `.mcp.json`. */
export const PLUGIN_MCP_SERVER = "stubwise";

function readVersion(root, relPath) {
  const pkg = JSON.parse(readFileSync(join(root, relPath), "utf8"));
  if (typeof pkg.version !== "string" || pkg.version.length === 0) {
    throw new Error(`${relPath}: campo "version" mancante`);
  }
  return pkg.version;
}

/** Legge la versione dalla fonte. Lancia se manca: meglio fermare il rilascio. */
export function readPluginVersion(root) {
  return readVersion(root, PLUGIN_VERSION_FILES.packageJson);
}

/** `@stubwise/mcp` oppure `@stubwise/mcp@<qualunque versione>`. */
function isMcpPackageArg(arg) {
  return (
    arg === MCP_NPM_PACKAGE || (typeof arg === "string" && arg.startsWith(`${MCP_NPM_PACKAGE}@`))
  );
}

/** Il sorgente del modulo generato con la costante. */
export function renderPluginVersionModule(version) {
  return [
    "/**",
    " * Ultima versione rilasciata del plugin Claude Code «stubwise», compilata dentro",
    " * `@stubwise/mcp` per l'avviso «plugin vecchio» (vedi `notices.ts`).",
    " *",
    " * GENERATO da `packages/mcp/scripts/sync-plugin-version.mjs` a partire da",
    " * `plugins/stubwise/package.json`: non modificarlo a mano. Il test di parità",
    " * (`plugin-version.test.ts`) fallisce se diverge dalle altre copie.",
    " */",
    `export const LATEST_PLUGIN_VERSION = ${JSON.stringify(version)};`,
    "",
  ].join("\n");
}

function writeIfChanged(root, relPath, content, changed) {
  const path = join(root, relPath);
  const before = readFileSync(path, "utf8");
  if (before !== content) {
    writeFileSync(path, content);
    changed.push(relPath);
  }
}

function jsonText(value) {
  return JSON.stringify(value, null, 2) + "\n";
}

/**
 * Riscrive le tre copie con la versione della fonte, e il pin di
 * `@stubwise/mcp` in `.mcp.json`. Ritorna i percorsi
 * cambiati (vuoto se era già tutto allineato). Non inventa niente: un
 * `.mcp.json` senza il server `stubwise` è un errore, non un file da completare.
 */
export function syncPluginVersion(root) {
  const version = readPluginVersion(root);
  const changed = [];

  const manifest = JSON.parse(readFileSync(join(root, PLUGIN_VERSION_FILES.manifest), "utf8"));
  manifest.version = version;
  writeIfChanged(root, PLUGIN_VERSION_FILES.manifest, jsonText(manifest), changed);

  const mcp = JSON.parse(readFileSync(join(root, PLUGIN_VERSION_FILES.mcpJson), "utf8"));
  const server = mcp?.mcpServers?.[PLUGIN_MCP_SERVER];
  if (!server) {
    throw new Error(
      `${PLUGIN_VERSION_FILES.mcpJson}: manca il server "${PLUGIN_MCP_SERVER}" in mcpServers`,
    );
  }
  server.env = { ...(server.env ?? {}), STUBWISE_PLUGIN_VERSION: version };
  const args = Array.isArray(server.args) ? server.args : [];
  const at = args.findIndex(isMcpPackageArg);
  if (at < 0) {
    throw new Error(
      `${PLUGIN_VERSION_FILES.mcpJson}: il server "${PLUGIN_MCP_SERVER}" non avvia ${MCP_NPM_PACKAGE}`,
    );
  }
  args[at] = `${MCP_NPM_PACKAGE}@${readVersion(root, PLUGIN_VERSION_FILES.mcpPackageJson)}`;
  writeIfChanged(root, PLUGIN_VERSION_FILES.mcpJson, jsonText(mcp), changed);

  writeIfChanged(
    root,
    PLUGIN_VERSION_FILES.mcpConstant,
    renderPluginVersionModule(version),
    changed,
  );

  return changed;
}
