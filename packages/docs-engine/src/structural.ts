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
 * per essere estese ad altri linguaggi senza toccare l'orchestrazione. I commenti
 * `//` e `/* … *\/` sono rimossi prima delle regex (`stripComments`) per evitare
 * archi/export fantasma; la superficie copre anche i re-export di barrel
 * (`export { … } from`, `export *`). LIMITE v1 NOTO: un import/export letterale
 * dentro una STRINGA può ancora generare un falso positivo (stringhe non gestite).
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

/** Estensioni dei file analizzati per superficie pubblica e import (TS/JS, v1). */
const TS_JS_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);

// Pesi dello scoring (documentati). La dimensione è il segnale grezzo dominante;
// la centralità nel grafo (archi entranti + uscenti) e l'ampiezza della superficie
// pubblica fanno da modulatori, con un peso volutamente alto per contare quanto
// molte righe di codice (un arco/un export "vale" come ~centinaia di byte).
const WEIGHT_SIZE = 1; // per byte di codice del modulo
const WEIGHT_CENTRALITY = 500; // per arco entrante o uscente nel dep graph
const WEIGHT_SURFACE = 200; // per simbolo nella superficie pubblica

/**
 * Euristica regex (v1, TS/JS) per i simboli esportati con dichiarazione diretta.
 * Cattura il nome dopo `export [default] function|const|let|var|class|interface|
 * type|enum`. I re-export (`export { … } from`, `export *`) sono gestiti a parte
 * (vedi `REEXPORT_NAMED_RE` / `REEXPORT_STAR_RE`).
 */
const EXPORT_RE =
  /^\s*export\s+(?:default\s+)?(?:async\s+)?(?:function|const|let|var|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/gm;

/**
 * Euristica regex (v1, TS/JS) per i re-export nominali da barrel/index:
 * `export { a, b as c } from "./mod"`. Cattura la lista di nomi tra graffe; i
 * singoli identificatori (e l'eventuale alias dopo `as`) sono estratti a valle.
 */
const REEXPORT_NAMED_RE = /^\s*export\s+\{([^}]*)\}\s*from\s*["'`][^"'`]+["'`]/gm;

/**
 * Euristica regex (v1, TS/JS) per i re-export wildcard: `export * from "./mod"`
 * o `export * as ns from "./mod"`. Marca la superficie con `"*"` (re-export
 * opaco) o con il namespace quando presente (`export * as ns`).
 */
const REEXPORT_STAR_RE =
  /^\s*export\s+\*\s*(?:as\s+([A-Za-z_$][\w$]*)\s+)?from\s*["'`][^"'`]+["'`]/gm;

/**
 * Euristica regex (v1, TS/JS) per gli import/require con specifier relativo.
 * Cattura il path tra apici di `import … from "…"`, `import "…"` e `require("…")`.
 */
const IMPORT_RE =
  /(?:import\s+(?:[^"'`]*?\s+from\s+)?|require\(\s*)["'`](\.[^"'`]+)["'`]/g;

/**
 * Rimuove i commenti `//` di riga e `/* … *\/` a blocco da un sorgente TS/JS,
 * sostituendoli con spazi equivalenti (preserva offset/righe). Evita falsi
 * positivi delle regex di import/export su testo dentro i commenti
 * (es. `// import "../x"`).
 *
 * LIMITE v1: NON gestisce le stringhe — un `import`/`export` letterale dentro una
 * stringa (es. `const s = '// import "../x"'`) può ancora generare falsi
 * positivi. È il residuo noto, raro nei sorgenti reali.
 */
function stripComments(source: string): string {
  // sostituisce ogni carattere non-newline con uno spazio (mantiene gli offset)
  const blank = (s: string) => s.replace(/[^\n]/g, " ");
  return source
    .replace(/\/\*[\s\S]*?\*\//g, blank) // blocco /* ... */
    .replace(/\/\/[^\n]*/g, blank); // riga // ...
}

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

/**
 * Normalizza un path listato dal reader rimuovendo un eventuale prefisso `./`
 * (ripetuto), così `./src/a.ts` è trattato come `src/a.ts`. Path già normalizzati
 * restano invariati.
 */
function normalizeListedPath(path: string): string {
  let p = path;
  while (p.startsWith("./")) p = p.slice(2);
  return p;
}

/** Applica esclusioni dir/binari e conta i linguaggi sui file rimanenti. */
function filterFiles(files: RepoFile[]): FilterResult {
  const kept: RepoFile[] = [];
  const languages: Record<string, number> = {};
  const skipped: { path: string; reason: string }[] = [];

  for (const raw of files) {
    // normalizza un eventuale `./` iniziale prima di ogni decisione sul path
    const file: RepoFile = { ...raw, path: normalizeListedPath(raw.path) };
    if (isExcludedPath(file.path)) {
      skipped.push({ path: file.path, reason: "excluded directory" });
      continue;
    }
    const ext = extname(file.path);
    if (ext && BINARY_EXTENSIONS.has(ext)) {
      skipped.push({ path: file.path, reason: "non-source file" });
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
 * Sotto-modulo di un file POSSEDUTO da un manifest in `manifestDir`:
 *  - il modulo manifest stesso (`manifestDir`) se il file sta direttamente nella
 *    sua directory (nessun segmento intermedio);
 *  - `manifestDir + primi `depth` segmenti di sottodirectory` altrimenti.
 *
 * Questa è la chiave per cui un manifest di root (`""`) non assorbe l'intero
 * repo: `src/a/x.ts` e `src/b/y.ts` mappano a `src/a` e `src/b`. La decisione se
 * APPLICARE davvero il sotto-segmento è presa in `segmentModules` (vedi sotto).
 */
function manifestSubModule(
  filePath: string,
  manifestDir: string,
  depth: number,
): string {
  const fileDir = dirname(filePath);
  if (fileDir === manifestDir) return manifestDir; // file diretto → modulo manifest
  const rel =
    manifestDir === "" ? fileDir : fileDir.slice(manifestDir.length + 1);
  const sub = rel.split("/").slice(0, depth).join("/");
  return manifestDir === "" ? sub : `${manifestDir}/${sub}`;
}

/**
 * Assegna ogni file a un modulo. Confine = directory di un manifest (ha priorità
 * il manifest più profondo che contiene il file); fallback = directory a `depth`.
 *
 * REGOLA DI SOTTO-SEGMENTAZIONE DEL MANIFEST: i file di un manifest vengono prima
 * bucketizzati per sotto-directory (vedi `manifestSubModule`). Se il manifest
 * produce PIÙ di un bucket distinto, ogni bucket diventa un modulo a sé (così un
 * `package.json` di root con `src/a/*` e `src/b/*` rende `src/a` e `src/b`, non un
 * unico modulo gigante). Se invece il manifest è "piatto" e produce un solo
 * bucket, tutto resta accorpato nel modulo manifest (così `packages/a` con
 * `src/index.ts` + `src/util.ts` resta un solo modulo). Il manifest più profondo
 * vince sempre (comportamento monorepo invariato).
 *
 * Ritorna i moduli con `files`, `manifest` e `language` dominante valorizzati.
 * Solo il modulo che coincide con la dir del manifest porta il `manifest`.
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

  // Per ogni file determina il manifest proprietario (il più profondo) o null.
  const ownerByFile = new Map<string, string | null>();
  // Bucket candidati per manifest, per decidere se sotto-segmentare.
  const bucketsByManifest = new Map<string, Set<string>>();
  for (const file of kept) {
    const fileDir = dirname(file.path);
    let owner: string | null = null;
    for (const md of manifestDirs) {
      if (isUnder(fileDir, md) && (owner === null || md.length > owner.length)) {
        owner = md;
      }
    }
    ownerByFile.set(file.path, owner);
    // Conta i bucket SOLO dai file non-manifest: il manifest siede sempre nella
    // sua dir e formerebbe un bucket spurio, falsando la decisione di split.
    if (owner !== null && !MANIFEST_FILES.includes(basename(file.path))) {
      const sub = manifestSubModule(file.path, owner, depth);
      const set = bucketsByManifest.get(owner) ?? new Set<string>();
      set.add(sub);
      bucketsByManifest.set(owner, set);
    }
  }

  // Un manifest sotto-segmenta solo se i suoi file ricadono in più bucket distinti.
  const splitManifests = new Set<string>();
  for (const [md, buckets] of bucketsByManifest) {
    if (buckets.size > 1) splitManifests.add(md);
  }

  const filesByModule = new Map<string, RepoFile[]>();
  for (const file of kept) {
    const owner = ownerByFile.get(file.path) ?? null;
    let modulePath: string;
    if (owner === null) {
      modulePath = dirAtDepth(file.path, depth);
    } else if (splitManifests.has(owner)) {
      modulePath = manifestSubModule(file.path, owner, depth);
    } else {
      modulePath = owner; // manifest piatto: tutto nel modulo manifest
    }
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

/**
 * Nomi dei simboli esportati da un sorgente TS/JS (euristica regex v1). Cattura:
 *  - dichiarazioni dirette (`export const foo`, `export function bar`, …);
 *  - re-export nominali da barrel (`export { a, b as c } from "…"` → `a`, `c`);
 *  - re-export wildcard (`export * from "…"` → marcatore `"*"`;
 *    `export * as ns from "…"` → `ns`).
 *
 * I commenti vengono rimossi a monte (`stripComments`). LIMITE v1: stringhe non
 * gestite (vedi `stripComments`).
 */
function extractPublicSurface(source: string): string[] {
  const clean = stripComments(source);
  const names = new Set<string>();
  for (const match of clean.matchAll(EXPORT_RE)) {
    if (match[1]) names.add(match[1]);
  }
  for (const match of clean.matchAll(REEXPORT_NAMED_RE)) {
    const list = match[1];
    if (!list) continue;
    for (const part of list.split(",")) {
      const token = part.trim();
      if (!token) continue;
      // `a as b` esporta `b`; altrimenti il nome stesso. Ignora `type` modifier.
      const segs = token.split(/\s+as\s+/);
      const exported = (segs.length > 1 ? segs[1] : segs[0])!
        .replace(/^type\s+/, "")
        .trim();
      if (exported && exported !== "default") names.add(exported);
    }
  }
  for (const match of clean.matchAll(REEXPORT_STAR_RE)) {
    names.add(match[1] ?? "*");
  }
  return [...names];
}

/**
 * Specifier di import/require relativi presenti in un sorgente TS/JS. I commenti
 * sono rimossi a monte (`stripComments`) per evitare archi fantasma da import
 * commentati. LIMITE v1: stringhe non gestite (vedi `stripComments`).
 */
function extractRelativeImports(source: string): string[] {
  const clean = stripComments(source);
  const specs: string[] = [];
  for (const match of clean.matchAll(IMPORT_RE)) {
    if (match[1]) specs.push(match[1]);
  }
  return specs;
}

/** Normalizza un path risolvendo i segmenti `.` e `..`. */
function normalizePath(path: string): string {
  const out: string[] = [];
  for (const segment of path.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") out.pop();
    else out.push(segment);
  }
  return out.join("/");
}

/**
 * Risolve uno specifier relativo (importato da `fromFile`) nel path del modulo
 * proprietario, o `null` se cade fuori dai moduli noti. `moduleDirs` è ordinato
 * per profondità decrescente così da preferire il modulo più specifico.
 */
function resolveImportToModule(
  spec: string,
  fromFile: string,
  moduleDirs: string[],
): string | null {
  const resolved = normalizePath(`${dirname(fromFile)}/${spec}`);
  for (const dir of moduleDirs) {
    if (isUnder(resolved, dir)) return dir;
  }
  return null;
}

/**
 * Arricchisce i moduli TS/JS con `publicSurface` (export) e `dependsOn` (import
 * relativi risolti ad altri moduli). Euristiche regex v1: si limitano a TS/JS e
 * non interpretano la semantica completa del linguaggio.
 */
async function enrichTsJsModules(
  modules: ModuleNode[],
  reader: RepoReader,
): Promise<void> {
  // moduli ordinati per profondità (numero di segmenti) decrescente: l'import
  // viene attribuito al modulo più specifico che lo contiene.
  const moduleDirs = modules
    .map((m) => m.path)
    .sort((a, b) => b.split("/").length - a.split("/").length);

  for (const module of modules) {
    const surface = new Set<string>();
    const deps = new Set<string>();
    for (const file of module.files) {
      const ext = extname(file);
      if (!ext || !TS_JS_EXTENSIONS.has(ext)) continue;
      const source = await reader.read(file);
      for (const name of extractPublicSurface(source)) surface.add(name);
      for (const spec of extractRelativeImports(source)) {
        const target = resolveImportToModule(spec, file, moduleDirs);
        // ignora gli import che restano nel modulo stesso (no auto-dipendenza)
        if (target !== null && target !== module.path) deps.add(target);
      }
    }
    module.publicSurface = [...surface];
    module.dependsOn = [...deps];
  }
}

/**
 * Calcola lo `score` di ogni modulo: `WEIGHT_SIZE*byte + WEIGHT_CENTRALITY*grado +
 * WEIGHT_SURFACE*#export`, dove il grado è la somma di archi entranti e uscenti
 * nel dep graph. Muta i moduli in place.
 */
function scoreModules(
  modules: ModuleNode[],
  sizeByPath: Map<string, number>,
): void {
  // grado entrante: quanti moduli dipendono da ciascun modulo.
  const inDegree = new Map<string, number>();
  for (const module of modules) {
    for (const dep of module.dependsOn) {
      inDegree.set(dep, (inDegree.get(dep) ?? 0) + 1);
    }
  }
  for (const module of modules) {
    const size = module.files.reduce(
      (sum, f) => sum + (sizeByPath.get(f) ?? 0),
      0,
    );
    const centrality = module.dependsOn.length + (inDegree.get(module.path) ?? 0);
    module.score =
      WEIGHT_SIZE * size +
      WEIGHT_CENTRALITY * centrality +
      WEIGHT_SURFACE * module.publicSurface.length;
  }
}

export async function buildRepoMap(
  reader: RepoReader,
  options: BuildRepoMapOptions,
): Promise<RepoMap> {
  // moduleDepth ha senso solo >= 1: a 0 il fallback per directory collasserebbe
  // tutto nella root. Clampiamo difensivamente al minimo 1.
  const moduleDepth = Math.max(1, options.moduleDepth ?? DEFAULT_MODULE_DEPTH);
  const files = await reader.list();
  const { kept, languages, skipped } = filterFiles(files);

  const modules = segmentModules(kept, moduleDepth);
  await enrichTsJsModules(modules, reader);

  const sizeByPath = new Map(kept.map((f) => [f.path, f.size]));
  scoreModules(modules, sizeByPath);

  // Ordina per score decrescente e applica il budget: i moduli oltre `maxModules`
  // finiscono in `skipped` con reason "module budget".
  modules.sort((a, b) => b.score - a.score);
  const cut = modules.slice(options.maxModules);
  for (const module of cut) {
    skipped.push({ path: module.path, reason: "module budget" });
  }
  const keptModules = modules.slice(0, options.maxModules);

  return { languages, modules: keptModules, skipped };
}
