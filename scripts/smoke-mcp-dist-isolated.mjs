#!/usr/bin/env node
/**
 * Smoke del pacchetto `@stubwise/mcp` COME LO RICEVE chi lo installa da npm
 * (revisione finale della parità MCP, C1, 26 nov 2026): il `dist/` e il
 * `package.json` in una cartella a sé, con nel suo `node_modules` SOLO le
 * `dependencies` dichiarate, e `node` vero che importa i moduli. Nel
 * monorepo `@stubwise/shared` si risolve comunque (devDependency, workspace),
 * quindi un import di VALORE da lì passa i test e il build `tsc` e rompe
 * il pacchetto pubblicato per tutti: `ERR_MODULE_NOT_FOUND` all'avvio del
 * server MCP. Qui fallisce prima del merge. Va lanciato dopo il build.
 */
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const pkgDir = join(dirname(fileURLToPath(import.meta.url)), "../packages/mcp");
const manifest = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8"));
const root = mkdtempSync(join(tmpdir(), "stubwise-mcp-isolated-"));
try {
  const target = join(root, "pkg");
  mkdirSync(target);
  cpSync(join(pkgDir, "dist"), join(target, "dist"), { recursive: true });
  cpSync(join(pkgDir, "package.json"), join(target, "package.json"));
  // Solo le dipendenze dichiarate: un link alla copia installata nel monorepo.
  for (const dep of Object.keys(manifest.dependencies ?? {})) {
    const link = join(target, "node_modules", dep);
    mkdirSync(dirname(link), { recursive: true });
    symlinkSync(realpathSync(join(pkgDir, "node_modules", dep)), link, "dir");
  }
  // I moduli che il bin carica, senza avviarlo (index.js apre lo stdio).
  const probe = [
    'const s = await import("./dist/server.js");',
    'if (typeof s.buildServer !== "function") throw new Error("dist/server.js non esporta buildServer");',
    'await import("./dist/setup.js");',
    'await import("./dist/client.js");',
  ].join("\n");
  const run = spawnSync(process.execPath, ["--input-type=module", "-e", probe], { cwd: target, encoding: "utf8" });
  if (run.status !== 0) {
    console.error(`smoke-mcp-dist-isolated: il pacchetto pubblicato non parte con le sole dipendenze dichiarate (${Object.keys(manifest.dependencies ?? {}).join(", ")}):\n${run.stderr}`);
    process.exit(1);
  }
  console.error("smoke-mcp-dist-isolated: ok");
} finally {
  rmSync(root, { recursive: true, force: true });
}
