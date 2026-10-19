import { realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Perimetro di LETTURA dei run di sola analisi del backlog (oggi il turno
 * di refinement): voce di backlog ab9bb5b2, scenario golden `refine-read`.
 *
 * Due pezzi, perché nessuno dei due basta da solo:
 *
 * 1. {@link scopedReadTools}: `Read`/`Grep`/`Glob` nell'allowlist SOLO sotto
 *    una directory (`Read(//<dir>/**)`). Con `Read` NUDO nell'allowlist il
 *    CLI (2.1.287, `permissionMode: "default"`) concede anche le letture
 *    FUORI dalla cwd — misurato: 3/3 rosso prima di questo modulo, il
 *    canarino finiva nella risposta. Ristretta, una lettura fuori chiede il
 *    permesso, e in `-p` una richiesta di permesso è un NO.
 *    Sintassi delle regole di percorso del CLI: `//abs/path` è assoluto dalla
 *    radice del filesystem; UNA sola `/` iniziale vuol dire «relativo al file
 *    di settings», ed è il motivo del doppio slash.
 * 2. {@link sensitiveReadDenyRules}: deny rule (`--disallowedTools`, che
 *    vince sull'allow) sui percorsi che non devono MAI essere letti, difesa in
 *    profondità se il primo pezzo cedesse (una cwd più larga, un cambio del
 *    CLI): `/proc` (l'environ dei processi), la config del CLI
 *    (`CLAUDE_CONFIG_DIR`: credenziali), le config MCP effimere degli altri
 *    run (`stubwise-mcp-*` in tmp: segreti del ponte e dell'ask-user) e il
 *    volume dei plugin.
 *
 * Ogni percorso entra anche nella sua forma REALE (`realpath`) quando è
 * diversa: su macOS `tmpdir()` è un symlink (`/var` → `/private/var`), e il
 * CLI confronta i percorsi risolti.
 */

const READ_TOOLS = ["Read", "Grep", "Glob"] as const;

/** `p` e la sua forma reale (se esiste ed è diversa), senza doppioni. */
function pathVariants(p: string): string[] {
  try {
    const real = realpathSync(p);
    return real === p ? [p] : [p, real];
  } catch {
    return [p];
  }
}

/** Regola di percorso del CLI per un percorso ASSOLUTO: `//abs/path/**`. */
function underRule(tool: string, absPath: string): string {
  const trimmed = absPath.replace(/\/+$/, "");
  return `${tool}(/${trimmed}/**)`;
}

/** `Read`/`Grep`/`Glob` ristretti a `dir` (e alla sua forma reale). Mai i tool nudi. */
export function scopedReadTools(dir: string): string[] {
  return pathVariants(dir).flatMap((d) => READ_TOOLS.map((tool) => underRule(tool, d)));
}

const FILE_TOOLS = ["Read", "Grep"] as const;

/**
 * Caratteri che in una regola di percorso del CLI sarebbero un pattern o
 * romperebbero la sintassi: glob, parentesi, backslash, e spazi/virgole (il CLI
 * divide la lista di `--allowedTools` su spazi e virgole).
 */
const RULE_UNSAFE = /[*?[\]{}()\\\s,]/;

/**
 * I file (relativi) che possono diventare una regola per file: senza `./`
 * iniziale, scartati quelli assoluti, con segmenti `.`/`..`, caratteri di pattern
 * o di sintassi. È il filtro di {@link scopedFileReadTools}: il chiamante lo usa
 * per dire all'agente quali file sono DAVVERO leggibili.
 */
export function ruleSafeFiles(files: readonly string[]): string[] {
  return files
    .map((f) => f.replace(/^(\.\/)+/, ""))
    .filter(
      (f) =>
        f !== "" &&
        !f.startsWith("/") &&
        !RULE_UNSAFE.test(f) &&
        !f.split("/").some((seg) => seg === ".." || seg === "."),
    );
}

/**
 * Allowlist CHIUSA per file (giro notturno, D13): per ogni file una regola
 * `Read(//<dir>/<file>)` e una `Grep(//<dir>/<file>)` — senza `/**` (per questo
 * non passa da `underRule`): serve una regola per file. Niente `Glob` (scoprire
 * altri file è proprio ciò che l'allowlist esclude) e mai un tool nudo; nessun
 * file → nessuna regola.
 *
 * Un percorso che allargherebbe la regola si SCARTA: segmenti `..`, assoluti,
 * caratteri di pattern (`*`, `?`, `[`, `{`) o di sintassi (parentesi, backslash,
 * spazi, virgole).
 * I file arrivano dai riassunti dei commit (numstat), quindi sono relativi alla
 * radice: un file scartato semplicemente non è leggibile.
 *
 * ⚠️ La regola chiude la lettura solo se la cwd del run NON è `dir`: il CLI
 * concede le letture sotto la cwd senza regole. Il chiamante fa girare il run in
 * una cwd vuota a parte.
 */
export function scopedFileReadTools(dir: string, files: readonly string[]): string[] {
  const safe = ruleSafeFiles(files);
  const roots = pathVariants(dir).map((d) => d.replace(/\/+$/, ""));
  return safe.flatMap((f) => roots.flatMap((root) => FILE_TOOLS.map((tool) => `${tool}(/${root}/${f})`)));
}

export interface SensitiveReadPaths {
  /** Volume dei plugin del registro (`PLUGINS_DIR`), se configurato. */
  pluginsDir?: string;
  /** Env da cui leggere `CLAUDE_CONFIG_DIR` (default `process.env`). */
  env?: NodeJS.ProcessEnv;
}

/** I percorsi assoluti che un run di analisi non legge MAI. */
export function sensitiveReadPaths(opts: SensitiveReadPaths = {}): string[] {
  const env = opts.env ?? process.env;
  const tmp = tmpdir();
  const configDir = env["CLAUDE_CONFIG_DIR"];
  const candidates = [
    "/proc",
    // La config del CLI, quella dell'env e quella di default (il CLI ripiega
    // su ~/.claude senza la variabile): entrambe, la regola non costa nulla.
    ...(configDir !== undefined && configDir !== "" ? [configDir] : []),
    join(env["HOME"] ?? homedir(), ".claude"),
    ...(opts.pluginsDir !== undefined && opts.pluginsDir !== "" ? [opts.pluginsDir] : []),
  ];
  // Le config MCP effimere dei run (`withMcpConfig`, cli-args.ts): il glob
  // sta sull'ultimo segmento, la forma reale si prende dalla tmp.
  const mcpTmp = pathVariants(tmp).map((t) => join(t, "stubwise-mcp-*"));
  return [...new Set([...candidates.flatMap(pathVariants), ...mcpTmp])];
}

/** Deny rule `Read`/`Grep`/`Glob` su ogni percorso sensibile. */
export function sensitiveReadDenyRules(opts: SensitiveReadPaths = {}): string[] {
  return sensitiveReadPaths(opts).flatMap((p) => READ_TOOLS.map((tool) => underRule(tool, p)));
}

/**
 * Unisce le deny rule del perimetro a quelle che il run ha già (le
 * `Skill(<plugin>:<skill>)` dei plugin, `openRunPlugins`): mai sostituirle.
 */
export function mergeDisallowedTools(...lists: (readonly string[] | undefined)[]): string[] {
  return [...new Set(lists.flatMap((l) => l ?? []))];
}
