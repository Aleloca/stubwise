#!/usr/bin/env node
/**
 * Allinea le copie della versione del plugin Claude Code «stubwise» alla sua
 * fonte (`plugins/stubwise/package.json`). Va lanciato dalla radice del
 * monorepo subito dopo `changeset version`: è lo script `version-packages`
 * della radice, che il workflow `release.yml` usa come comando di versioning.
 * Vedi `plugin-version.mjs` per le copie e il perché.
 */
import { syncPluginVersion } from "./plugin-version.mjs";

const changed = syncPluginVersion(process.cwd());
if (changed.length === 0) {
  console.log("Versione del plugin già allineata.");
} else {
  console.log(`Versione del plugin allineata in: ${changed.join(", ")}`);
}
