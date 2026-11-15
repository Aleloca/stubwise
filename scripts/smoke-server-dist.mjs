#!/usr/bin/env node
/**
 * Smoke di avvio del server (15 nov 2026): `node` vero importa il
 * `dist/app.js` compilato, cioè TUTTO il grafo dei moduli del server
 * (rotte comprese), senza aprire porte. Un import che vitest tollera e node
 * no (il caso `ssh2`/`utils`) fallisce qui al link, come al `docker compose
 * up`. Va lanciato dopo il build.
 */
import { pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const app = join(dirname(fileURLToPath(import.meta.url)), "../apps/server/dist/app.js");
const mod = await import(pathToFileURL(app).href);
if (typeof mod.buildApp !== "function") {
  console.error("smoke-server-dist: dist/app.js non esporta buildApp");
  process.exit(1);
}
console.error("smoke-server-dist: ok");
process.exit(0);
