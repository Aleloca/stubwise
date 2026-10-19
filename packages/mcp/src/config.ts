import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, parse as parsePath } from "node:path";
import { z } from "zod";

import { normalizeEnvValue } from "./notices.js";

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
  /**
   * Lettore del file personale (`~/.config/stubwise/config.json`). Iniettabile
   * perché i test non tocchino il disco vero; di default `readUserConfigFile`.
   */
  readUserConfig?: () => UserConfig | null;
}

/** Contenuto del file personale scritto da `setup`. */
export interface UserConfig {
  url?: string;
  token?: string;
}

const userConfigSchema = z.object({
  url: z.string().min(1).optional(),
  token: z.string().min(1).optional(),
});

/** Percorso del file personale: uguale su macOS, Linux e Windows. */
export function userConfigPath(env: Record<string, string | undefined>): string {
  return (
    normalizeEnvValue(env.STUBWISE_CONFIG) ?? join(homedir(), ".config", "stubwise", "config.json")
  );
}

/**
 * Legge il file personale. Assente → `null`; presente ma illeggibile o con JSON
 * rotto → errore che NOMINA il file (chi l'ha scritto a mano deve poterlo
 * correggere, o rilanciare `setup`). Il token non finisce mai nel messaggio.
 */
export function readUserConfigFile(env: Record<string, string | undefined>): UserConfig | null {
  const file = userConfigPath(env);
  if (!existsSync(file)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    throw new Error(
      `Il file di configurazione ${file} non è leggibile (JSON non valido): correggilo o rilancia «npx -y @stubwise/mcp setup».`,
    );
  }
  const result = userConfigSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(
      `Il file di configurazione ${file} non ha la forma attesa ({"url": "...", "token": "..."}): correggilo o rilancia «npx -y @stubwise/mcp setup».`,
    );
  }
  return result.data;
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
 *
 * Esportata perché va rieseguita FRESCA a ogni tool call (vedi `resolveProject`):
 * il server MCP carica lo slug una sola volta all'avvio, ma `.stubwise.json` può
 * essere creato DOPO (flusso `/stubwise:init` → uso immediato), quindi la
 * rilettura per-chiamata evita di dover riavviare Claude Code.
 */
export function readProjectSlug(cwd: string): string | null {
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
export function loadConfig({ cwd, env, readUserConfig }: LoadConfigOptions): StubwiseConfig {
  // Ordine: ambiente > file personale > default. Il file si legge una volta.
  const file = (readUserConfig ?? (() => readUserConfigFile(env)))();
  // `normalizeEnvValue`: vuoto e `${VAR}` letterale valgono come assenti.
  // Claude Code passa così com'è una `${STUBWISE_URL}` non impostata di un
  // `.mcp.json` (provato con la 2.1.294): senza, chi non ha STUBWISE_URL
  // riceveva «non è un URL valido» invece del default.
  const baseUrl = stripTrailingSlash(
    normalizeEnvValue(env.STUBWISE_URL) ?? normalizeEnvValue(file?.url) ?? DEFAULT_BASE_URL,
  );

  // Valida SUBITO che baseUrl sia un URL ben formato: un valore rotto darebbe
  // altrimenti un TypeError oscuro molto più a valle, dentro fetch.
  try {
    new URL(baseUrl);
  } catch {
    throw new Error(`STUBWISE_URL non è un URL valido: ${baseUrl}`);
  }

  const token = normalizeEnvValue(env.STUBWISE_TOKEN) ?? normalizeEnvValue(file?.token);
  if (!token) {
    throw new Error(
      "Stubwise non è ancora configurato: apri le impostazioni di Stubwise, sezione «Claude Code», e incolla nel terminale il comando che trovi lì.",
    );
  }

  const projectSlug = readProjectSlug(cwd);

  return { baseUrl, token, projectSlug };
}
