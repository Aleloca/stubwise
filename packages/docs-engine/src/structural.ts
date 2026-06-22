/**
 * Pass strutturale di `@stubwise/docs-engine`: da un `RepoReader` a un `RepoMap`.
 *
 * Logica PURA e deterministica (nessun accesso a fs/rete: il reader è iniettato):
 *  1. lista i file, conta i linguaggi per estensione ed esclude rumore
 *     (`dist/`, `build/`, `node_modules/`, `vendor/`, `.git/`, file binari);
 *  2. segmenta i file in moduli — confine = file manifest, fallback = directory
 *     a profondità `moduleDepth`;
 *  3. per i moduli TS/JS estrae la superficie pubblica (`export …`) e risolve gli
 *     import relativi nel grafo delle dipendenze (euristiche regex, v1);
 *  4. assegna uno `score` a ogni modulo e applica il budget `maxModules`,
 *     loggando in `skipped` i moduli tagliati.
 *
 * Le euristiche di superficie/dipendenze sono v1 e focalizzate su TS/JS; sono
 * volutamente semplici e isolate (`extractPublicSurface`, `extractRelativeImports`)
 * per essere estese ad altri linguaggi senza toccare l'orchestrazione.
 */
import type { RepoReader } from "./fs.js";
import type { RepoFile, RepoMap } from "./types.js";

export type { RepoMap, ModuleNode } from "./types.js";

export interface BuildRepoMapOptions {
  /** Numero massimo di moduli da tenere nel map (i restanti vanno in `skipped`). */
  maxModules: number;
  /** Profondità di directory usata come confine di modulo in assenza di manifest. */
  moduleDepth?: number;
}

/** Segmenti di path che identificano directory da escludere completamente. */
const EXCLUDED_DIRS = new Set([
  "dist",
  "build",
  "node_modules",
  "vendor",
  ".git",
]);

/** Estensioni binarie/non testuali: i file vengono esclusi e loggati in `skipped`. */
const BINARY_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".ico",
  ".svg",
  ".pdf",
  ".zip",
  ".gz",
  ".tar",
  ".woff",
  ".woff2",
  ".ttf",
  ".eot",
  ".mp4",
  ".mov",
  ".mp3",
  ".wasm",
  ".bin",
  ".lock",
]);

/** Estensione di un path (con il punto, in lowercase) o `null` se assente. */
function extname(path: string): string | null {
  const base = path.slice(path.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return null; // niente punto, o dotfile senza estensione
  return base.slice(dot).toLowerCase();
}

/** True se il path attraversa una directory esclusa. */
function isExcludedPath(path: string): boolean {
  return path.split("/").some((segment) => EXCLUDED_DIRS.has(segment));
}

interface FilterResult {
  kept: RepoFile[];
  languages: Record<string, number>;
  skipped: { path: string; reason: string }[];
}

/** Applica esclusioni dir/binari e conta i linguaggi sui file rimanenti. */
function filterFiles(files: RepoFile[]): FilterResult {
  const kept: RepoFile[] = [];
  const languages: Record<string, number> = {};
  const skipped: { path: string; reason: string }[] = [];

  for (const file of files) {
    if (isExcludedPath(file.path)) {
      skipped.push({ path: file.path, reason: "excluded directory" });
      continue;
    }
    const ext = extname(file.path);
    if (ext && BINARY_EXTENSIONS.has(ext)) {
      skipped.push({ path: file.path, reason: "binary file" });
      continue;
    }
    kept.push(file);
    if (ext) languages[ext] = (languages[ext] ?? 0) + 1;
  }

  return { kept, languages, skipped };
}

export async function buildRepoMap(
  reader: RepoReader,
  options: BuildRepoMapOptions,
): Promise<RepoMap> {
  void options;
  const files = await reader.list();
  const { languages, skipped } = filterFiles(files);

  return { languages, modules: [], skipped };
}
