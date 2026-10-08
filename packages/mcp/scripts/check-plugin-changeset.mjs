#!/usr/bin/env node
/**
 * CLI del controllo `plugin-changeset.mjs`, per la CI sulle PR.
 *
 *   node packages/mcp/scripts/check-plugin-changeset.mjs <base-sha>
 *
 * Va lanciato dalla radice del repository, con la storia della base
 * disponibile (`fetch-depth: 0`). Esce con 1 se il plugin cambia senza un
 * changeset che nomini plugin e `@stubwise/mcp`.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

import { PLUGIN_DIR, checkPluginChangeset } from "./plugin-changeset.mjs";

const base = process.argv[2];
if (!base) {
  console.error("Uso: check-plugin-changeset.mjs <base-sha>");
  process.exit(2);
}

function git(...args) {
  // stderr scartato: un `git show` di un file che alla base non c'era è un
  // esito atteso (vedi `versionAt`), non un errore da stampare.
  return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
}

const changedFiles = git("diff", "--name-only", `${base}...HEAD`)
  .split("\n")
  .filter((f) => f.length > 0);

const changesets = changedFiles
  .filter((f) => /^\.changeset\/[^/]+\.md$/.test(f) && f !== ".changeset/README.md")
  .filter((f) => existsSync(f))
  .map((f) => readFileSync(f, "utf8"));

function versionAt(ref) {
  try {
    const mergeBase = git("merge-base", ref, "HEAD").trim();
    return JSON.parse(git("show", `${mergeBase}:${PLUGIN_DIR}package.json`)).version ?? null;
  } catch {
    return null; // il plugin non esisteva alla base
  }
}

const headVersion = JSON.parse(readFileSync(`${PLUGIN_DIR}package.json`, "utf8")).version;
const baseVersion = versionAt(base);
// Alla base il plugin non c'era (la PR che lo introduce): serve comunque un
// changeset, perché è quello che lo porta alla prima versione rilasciata.
const pluginVersionChanged = baseVersion !== null && baseVersion !== headVersion;

const result = checkPluginChangeset({ changedFiles, changesets, pluginVersionChanged });
console.log(result.message);
process.exit(result.ok ? 0 : 1);
