/**
 * Gate del RUMORE: un file che, da solo, non è una modifica di prodotto. Un commit che
 * tocca solo rumore non va al modello (riceve un riassunto deterministico, vedi
 * `commit-summary.ts`), e il rumore non entra nel changelog dei Docs.
 *
 * Regola CONSERVATIVA e DICHIARATA (decisione D16 del Piano B, maintainer). Un file è
 * rumore se:
 * 1. il basename è un lockfile (`pnpm-lock.yaml`, `package-lock.json`, `yarn.lock`);
 * 2. il percorso inizia con una cartella di processo (`plans/`, `docs/`, `manual/`,
 *    `guides/`, `.github/`) — gli stessi artefatti di sessione/processo che
 *    l'orientamento (packages/docs-engine/src/recursive/orient.ts) esclude dal tecnico,
 *    più la CI. `docs/` e `plans/` restano rumore per scelta del maintainer;
 * 3. il percorso contiene un segmento di cartella `vendor/`, `node_modules/` o `dist/` a
 *    qualunque profondità (codice vendorizzato o generato);
 * 4. il basename finisce con `.min.js`, `.min.css`, `.map` o `.snap`.
 *
 * Cosa resta FUORI, e perché:
 * - `build/`: in troppi repository è codice sorgente (script di build), non un artefatto;
 * - un controllo d'intestazione «generated»: chiederebbe di leggere il contenuto, e il gate
 *   deve restare una funzione PURA del percorso, testabile e identica per i Docs.
 *
 * Allargare la lista è una modifica esplicita, con un test (`noise.test.ts` fissa le
 * liste qui sotto).
 */

/** Lockfile, riconosciuti per basename ovunque siano. */
export const NOISE_LOCKFILES: readonly string[] = ["pnpm-lock.yaml", "package-lock.json", "yarn.lock"];

/** Cartelle di processo, per prefisso del percorso normalizzato. */
export const NOISE_DOC_PREFIXES: readonly string[] = ["plans/", "docs/", "manual/", "guides/"];

/** La CI, per prefisso del percorso normalizzato. */
export const NOISE_CI_PREFIXES: readonly string[] = [".github/"];

/** Segmenti di cartella di codice generato o vendorizzato, a qualunque profondità. */
export const NOISE_DIR_SEGMENTS: readonly string[] = ["vendor", "node_modules", "dist"];

/** Suffissi del basename di codice generato. */
export const NOISE_SUFFIXES: readonly string[] = [".min.js", ".min.css", ".map", ".snap"];

/** Categoria di un file di rumore: il riassunto deterministico la nomina. */
export type NoiseCategory = "docs" | "lockfile" | "generated" | "ci";

function normalize(path: string): string {
  return path.trim().replace(/\\/g, "/").replace(/^\/+/, "");
}

/** Categoria di rumore di `path`, o null se il file è materiale. */
export function noiseCategory(path: string): NoiseCategory | null {
  const normalized = normalize(path);
  if (normalized === "") return null;
  const segments = normalized.split("/");
  const basename = segments[segments.length - 1] ?? "";
  if (NOISE_LOCKFILES.includes(basename)) return "lockfile";
  if (NOISE_CI_PREFIXES.some((p) => normalized.startsWith(p))) return "ci";
  if (NOISE_DOC_PREFIXES.some((p) => normalized.startsWith(p))) return "docs";
  // Solo i segmenti di CARTELLA (non il basename): un file chiamato `dist` non è una cartella.
  if (segments.slice(0, -1).some((s) => NOISE_DIR_SEGMENTS.includes(s))) return "generated";
  if (NOISE_SUFFIXES.some((s) => basename.endsWith(s))) return "generated";
  return null;
}

/** true se `path` è rumore (un percorso vuoto lo è: non porta nessuna modifica). */
export function isNoise(path: string): boolean {
  if (normalize(path) === "") return true;
  return noiseCategory(path) !== null;
}
