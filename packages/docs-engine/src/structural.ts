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
import type { ModuleNode, RepoFile, RepoMap } from "./types.js";

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

/** File manifest che definiscono il confine di un modulo (in ordine di priorità). */
const MANIFEST_FILES = [
  "package.json",
  "composer.json",
  "pyproject.toml",
  "go.mod",
  "Cargo.toml",
];

/** Profondità di directory usata come confine di modulo in assenza di manifest. */
const DEFAULT_MODULE_DEPTH = 2;

/** Estensione di un path (con il punto, in lowercase) o `null` se assente. */
function extname(path: string): string | null {
  const base = path.slice(path.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return null; // niente punto, o dotfile senza estensione
  return base.slice(dot).toLowerCase();
}

/** Basename di un path. */
function basename(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

/** Dirname di un path (`""` per file in root). */
function dirname(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash < 0 ? "" : path.slice(0, slash);
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

/** True se `dir` è `ancestor` o una sua sotto-directory. */
function isUnder(dir: string, ancestor: string): boolean {
  if (ancestor === "") return true;
  return dir === ancestor || dir.startsWith(`${ancestor}/`);
}

/** Directory del file troncata alle prime `depth` componenti (confine di fallback). */
function dirAtDepth(filePath: string, depth: number): string {
  const segments = filePath.split("/");
  // l'ultima componente è il nome del file: le directory sono segments[0..-2]
  const dirSegments = segments.slice(0, -1);
  return dirSegments.slice(0, depth).join("/");
}

/**
 * Assegna ogni file a un modulo. Confine = directory di un manifest (ha priorità
 * il manifest più profondo che contiene il file); fallback = directory a `depth`.
 * Ritorna i moduli con `files`, `manifest` e `language` dominante valorizzati.
 */
function segmentModules(kept: RepoFile[], depth: number): ModuleNode[] {
  // Directory che contengono un manifest → confine di modulo.
  const manifestByDir = new Map<string, string>();
  for (const file of kept) {
    if (MANIFEST_FILES.includes(basename(file.path))) {
      const dir = dirname(file.path);
      // mantieni il primo manifest trovato per directory (priorità d'ordine)
      if (!manifestByDir.has(dir)) manifestByDir.set(dir, file.path);
    }
  }
  const manifestDirs = [...manifestByDir.keys()];

  // Per ogni file, scegli il modulo: il manifest-dir più profondo che lo contiene,
  // altrimenti la sua directory troncata a `depth`.
  const filesByModule = new Map<string, RepoFile[]>();
  for (const file of kept) {
    const fileDir = dirname(file.path);
    let owner: string | null = null;
    for (const md of manifestDirs) {
      if (isUnder(fileDir, md) && (owner === null || md.length > owner.length)) {
        owner = md;
      }
    }
    const modulePath = owner ?? dirAtDepth(file.path, depth);
    const bucket = filesByModule.get(modulePath);
    if (bucket) bucket.push(file);
    else filesByModule.set(modulePath, [file]);
  }

  const modules: ModuleNode[] = [];
  for (const [modulePath, moduleFiles] of filesByModule) {
    modules.push({
      path: modulePath,
      language: dominantLanguage(moduleFiles),
      files: moduleFiles.map((f) => f.path),
      manifest: manifestByDir.get(modulePath) ?? null,
      publicSurface: [],
      dependsOn: [],
      score: 0,
    });
  }
  return modules;
}

/**
 * Linguaggio dominante (estensione più frequente) di un insieme di file, o `null`.
 * I file manifest (es. `package.json`) sono ignorati: descrivono il modulo, non
 * il suo linguaggio di codice.
 */
function dominantLanguage(files: RepoFile[]): string | null {
  const counts = new Map<string, number>();
  for (const file of files) {
    if (MANIFEST_FILES.includes(basename(file.path))) continue;
    const ext = extname(file.path);
    if (ext) counts.set(ext, (counts.get(ext) ?? 0) + 1);
  }
  let best: string | null = null;
  let bestCount = 0;
  for (const [ext, count] of counts) {
    if (count > bestCount) {
      best = ext;
      bestCount = count;
    }
  }
  return best;
}

export async function buildRepoMap(
  reader: RepoReader,
  options: BuildRepoMapOptions,
): Promise<RepoMap> {
  const moduleDepth = options.moduleDepth ?? DEFAULT_MODULE_DEPTH;
  const files = await reader.list();
  const { kept, languages, skipped } = filterFiles(files);

  const modules = segmentModules(kept, moduleDepth);

  return { languages, modules, skipped };
}
