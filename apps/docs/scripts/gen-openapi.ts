/**
 * Genera la spec OpenAPI del server e la scrive in src/openapi.json, da cui
 * il plugin starlight-openapi costruisce la pagina di riferimento dell'API.
 *
 * La spec è derivata dagli schemi Zod delle route (Task 9): buildApp() la
 * espone via app.swagger(). Non serve un database — buildApp si costruisce
 * senza db e /api/openapi.json risponde comunque (vedi apps/server/src/app.ts).
 * Per questo l'import punta DIRETTAMENTE ai sorgenti del server (tsx li esegue
 * come TypeScript), così non dipendiamo da un build o da un'istanza in esecuzione.
 *
 * Eseguito come prebuild di `astro build` (vedi package.json): la spec è sempre
 * rigenerata dal codice corrente prima di ogni build della documentazione.
 */
import { buildApp } from "@stubwise/server/app";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const outPath = join(here, "..", "src", "openapi.json");

const app = buildApp();
// @fastify/swagger popola lo spec solo dopo che i plugin sono pronti.
await app.ready();
const spec = app.swagger();
await app.close();

await mkdir(dirname(outPath), { recursive: true });
await writeFile(outPath, `${JSON.stringify(spec, null, 2)}\n`, "utf8");

console.log(`[docs] spec OpenAPI scritta in ${outPath} (${spec.paths ? Object.keys(spec.paths).length : 0} path)`);
