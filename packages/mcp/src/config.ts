import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, parse as parsePath } from "node:path";
import { z } from "zod";

/**
 * Configurazione risolta del server MCP Stubwise. Tutto proviene dall'ambiente
 * e dal filesystem (nessun segreto hardcoded):
 * - `baseUrl`: origine dell'istanza Stubwise (senza trailing slash), su cui il
 *   client HTTP monta i path `/api/...`.
 * - `token`: Personal Access Token (`stw_pat_...`) usato come Bearer. Sempre
 *   presente: senza token il server non parte.
 * - `projectSlug`: slug del progetto di default letto da `.stubwise.json` nella
 *   cartella corrente o in una antenata. `null` quando non c'è un file valido:
 *   i tool che richiedono un progetto lo chiederanno esplicitamente.
 */
export interface StubwiseConfig {
  baseUrl: string;
  token: string;
  projectSlug: string | null;
}

/** Input di `loadConfig`: iniettabili per testabilità (nessun accesso globale). */
export interface LoadConfigOptions {
  cwd: string;
  env: Record<string, string | undefined>;
}

const DEFAULT_BASE_URL = "http://localhost:3000";

const STUBWISE_FILE = ".stubwise.json";

/**
 * Cap difensivo sulla dimensione di `.stubwise.json`: il file è un banale
 * `{ "project": "slug" }`, mai grande. Un file patologico (o un symlink verso
 * qualcosa di enorme) verrebbe altrimenti letto per intero in memoria. Oltre
 * questa soglia lo ignoriamo (best-effort, non fatale).
 */
const MAX_STUBWISE_FILE_BYTES = 64 * 1024;

/** Forma attesa di `.stubwise.json`. Campi estranei ignorati (non `.strict()`). */
const stubwiseFileSchema = z.object({ project: z.string().min(1) });

/**
 * Risale le cartelle a partire da `cwd` cercando il primo `.stubwise.json`.
 * Si ferma alla radice del filesystem. Ritorna il percorso del file o `null`.
 */
function findStubwiseFile(cwd: string): string | null {
  const root = parsePath(cwd).root;
  let dir = cwd;
  // Ciclo limitato: dirname() converge sempre alla radice, oltre cui non sale.
  for (;;) {
    const candidate = join(dir, STUBWISE_FILE);
    if (existsSync(candidate)) return candidate;
    if (dir === root) return null;
    const parent = dirname(dir);
    // Guardia anti-loop: se dirname non fa progressi, esci.
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Legge lo slug del progetto da `.stubwise.json` risalendo da `cwd`. Non è mai
 * un errore fatale: file assente, JSON malformato o schema errato → `null`
 * (con un warning su stderr per i casi malformati, così l'utente capisce
 * perché il default di progetto non viene applicato).
 */
function readProjectSlug(cwd: string): string | null {
  const filePath = findStubwiseFile(cwd);
  if (!filePath) return null;

  // Cap difensivo sulla dimensione PRIMA di leggere: evita di caricare in
  // memoria un file patologico. statSync che fallisce non è fatale: proseguiamo
  // e lasciamo che sia readFileSync a segnalare l'eventuale errore.
  try {
    const size = statSync(filePath).size;
    if (size > MAX_STUBWISE_FILE_BYTES) {
      process.stderr.write(
        `stubwise-mcp: ${filePath} troppo grande (${size} byte > ${MAX_STUBWISE_FILE_BYTES}), ignoro il progetto di default\n`,
      );
      return null;
    }
  } catch {
    // Ignora: la readFileSync sotto riproverà e riporterà l'errore vero.
  }

  let raw: string;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch (err) {
    process.stderr.write(
      `stubwise-mcp: impossibile leggere ${filePath}: ${(err as Error).message}\n`,
    );
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    process.stderr.write(
      `stubwise-mcp: ${filePath} non è JSON valido, ignoro il progetto di default\n`,
    );
    return null;
  }

  const result = stubwiseFileSchema.safeParse(parsed);
  if (!result.success) {
    process.stderr.write(
      `stubwise-mcp: ${filePath} non ha il campo "project" atteso, ignoro il progetto di default\n`,
    );
    return null;
  }

  return result.data.project;
}

/** Toglie un eventuale trailing slash (ma non svuota "http://host"). */
function stripTrailingSlash(url: string): string {
  return url.endsWith("/") ? url.replace(/\/+$/, "") : url;
}

/**
 * Costruisce la configurazione del server MCP da ambiente + filesystem.
 * Lancia solo se manca il token: baseUrl e projectSlug hanno fallback sensati.
 */
export function loadConfig({ cwd, env }: LoadConfigOptions): StubwiseConfig {
  const baseUrl = stripTrailingSlash(env.STUBWISE_URL?.trim() || DEFAULT_BASE_URL);

  // Valida SUBITO che baseUrl sia un URL ben formato: un valore rotto darebbe
  // altrimenti un TypeError oscuro molto più a valle, dentro fetch.
  try {
    new URL(baseUrl);
  } catch {
    throw new Error(`STUBWISE_URL non è un URL valido: ${baseUrl}`);
  }

  const token = env.STUBWISE_TOKEN?.trim();
  if (!token) {
    throw new Error(
      "STUBWISE_TOKEN non impostato: crea un Personal Access Token nelle impostazioni Stubwise e impostalo come variabile d'ambiente",
    );
  }

  const projectSlug = readProjectSlug(cwd);

  return { baseUrl, token, projectSlug };
}
