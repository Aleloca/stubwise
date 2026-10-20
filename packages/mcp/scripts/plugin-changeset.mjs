/**
 * Controllo CI: una modifica al plugin Claude Code «stubwise» deve arrivare
 * con un changeset, altrimenti il contenuto cambia ma la versione no, e nessun
 * utente riceve l'aggiornamento (Claude Code confronta la `version` del
 * manifest, non i file).
 *
 * Il changeset deve nominare ANCHE `@stubwise/mcp`. I due pacchetti sono un
 * gruppo `fixed` di Changesets (`.changeset/config.json`) e il plugin fissa la
 * versione esatta del server che avvia (`@stubwise/mcp@<versione>` nel suo
 * `.mcp.json`): escono sempre insieme, con la stessa versione. Con `fixed`
 * basterebbe nominarne uno; la regola più stretta resta perché il changelog
 * di entrambi dica cosa cambia, e perché l'avviso «plugin vecchio» si basa
 * sulla versione `latest` di `@stubwise/mcp` su npm, che deve quindi uscire
 * a ogni rilascio del plugin.
 *
 * Fa eccezione la PR di versioning di Changesets, che alza la versione del
 * plugin (e consuma i changeset): lì il bump è già avvenuto.
 */

export const PLUGIN_DIR = "plugins/stubwise/";
export const PLUGIN_PACKAGE = "@stubwise/claude-plugin";
export const MCP_PACKAGE = "@stubwise/mcp";

/** I nomi dei pacchetti nel frontmatter di un changeset. */
export function parseChangesetPackages(markdown) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(markdown);
  if (!match) return [];
  const names = [];
  for (const line of match[1].split(/\r?\n/)) {
    const m = /^\s*["']([^"']+)["']\s*:/.exec(line);
    if (m) names.push(m[1]);
  }
  return names;
}

/** File del plugin che, cambiando, chiedono un changeset. */
function touchesPlugin(file) {
  return file.startsWith(PLUGIN_DIR) && file !== `${PLUGIN_DIR}CHANGELOG.md`;
}

/**
 * @param {{ changedFiles: string[], changesets: string[], pluginVersionChanged: boolean }} input
 *   `changesets`: il contenuto dei changeset aggiunti o modificati nella PR.
 * @returns {{ ok: boolean, message: string }}
 */
export function checkPluginChangeset({ changedFiles, changesets, pluginVersionChanged }) {
  const touched = changedFiles.filter(touchesPlugin);
  if (touched.length === 0) {
    return { ok: true, message: "Il plugin Claude Code non è stato toccato." };
  }
  if (pluginVersionChanged) {
    return { ok: true, message: "La versione del plugin è alzata in questa PR." };
  }
  const named = changesets.map(parseChangesetPackages);
  if (named.some((pkgs) => pkgs.includes(PLUGIN_PACKAGE) && pkgs.includes(MCP_PACKAGE))) {
    return { ok: true, message: "C'è un changeset per il plugin e per @stubwise/mcp." };
  }
  const onlyPlugin = named.some((pkgs) => pkgs.includes(PLUGIN_PACKAGE));
  return {
    ok: false,
    message: [
      `Questa PR cambia il plugin Claude Code (${touched.join(", ")})`,
      onlyPlugin
        ? `e il changeset nomina "${PLUGIN_PACKAGE}" ma non "${MCP_PACKAGE}".`
        : "senza un changeset.",
      `Aggiungi in .changeset/ un file con "${PLUGIN_PACKAGE}" e "${MCP_PACKAGE}" nel frontmatter`,
      "(stesso file): senza la versione nuova nessuno riceve l'aggiornamento, e i due",
      "pacchetti escono sempre insieme (gruppo `fixed`, il plugin fissa la versione del server).",
    ].join(" "),
  };
}
