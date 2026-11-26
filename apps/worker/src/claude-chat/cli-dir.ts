import { mkdir, readdir, realpath, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Le cartelle del CLI di una conversazione libera (chat con Claude).
 *
 * La CWD è deterministica e vuota (`<tmp>/stubwise-chat/<sessionId>`): il CLI
 * indicizza le sessioni di `--resume` per cwd (come `refineParentDir` del
 * refinement), quindi una cwd nuova a ogni turno renderebbe `--resume`
 * inutile. Le TRASCRIZIONI del CLI stanno in
 * `<CLAUDE_CONFIG_DIR>/projects/<cwd con ogni carattere non alfanumerico
 * come «-»>`, sul volume persistente: contengono la conversazione e vanno via
 * con lei — all'eliminazione e con la potatura (14 giorni, come le sessioni).
 * Il CLI usa il percorso REALE (su macOS `/private/tmp`): si toglie con
 * entrambi.
 */

export interface ChatCliPaths {
  /** Radice delle cwd (default `os.tmpdir()`). */
  tmp?: string;
  /** `CLAUDE_CONFIG_DIR` (default `process.env`, poi `~/.claude`). */
  configDir?: string;
}

const CHAT_DIR = "stubwise-chat";

export function chatCwd(sessionId: string, tmp: string = tmpdir()): string {
  return join(tmp, CHAT_DIR, sessionId);
}

/** Il nome della cartella del progetto del CLI per una cwd. */
export function cliProjectDirName(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9-]/g, "-");
}

const configDirOf = (paths: ChatCliPaths) =>
  paths.configDir ?? process.env["CLAUDE_CONFIG_DIR"] ?? join(homedir(), ".claude");

/** La cwd pronta (vuota se nuova; la stessa a ogni turno). */
export async function ensureChatCwd(sessionId: string, paths: ChatCliPaths = {}): Promise<string> {
  const cwd = chatCwd(sessionId, paths.tmp);
  await mkdir(cwd, { recursive: true });
  return cwd;
}

async function realOrSelf(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return path;
  }
}

/** Le cwd possibili (data e reale), anche se la cartella non c'è più. */
async function cwdVariants(sessionId: string, paths: ChatCliPaths): Promise<string[]> {
  const tmp = paths.tmp ?? tmpdir();
  const realTmp = await realOrSelf(tmp);
  return [...new Set([chatCwd(sessionId, tmp), chatCwd(sessionId, realTmp)])];
}

/** Via cwd e trascrizioni del CLI della conversazione. Idempotente. */
export async function removeChatCliState(sessionId: string, paths: ChatCliPaths = {}): Promise<void> {
  const projects = join(configDirOf(paths), "projects");
  for (const cwd of await cwdVariants(sessionId, paths)) {
    await rm(join(projects, cliProjectDirName(cwd)), { recursive: true, force: true });
    await rm(cwd, { recursive: true, force: true });
  }
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Le conversazioni che hanno trascrizioni nel CLI, dai nomi delle cartelle
 * (anche quelle la cui cwd è sparita con un riavvio del container): la
 * potatura toglie quelle che non esistono più.
 */
export async function chatSessionIdsInCliProjects(paths: ChatCliPaths = {}): Promise<string[]> {
  const projects = join(configDirOf(paths), "projects");
  const tmp = paths.tmp ?? tmpdir();
  const prefixes = [...new Set([tmp, await realOrSelf(tmp)])].map((t) => `${cliProjectDirName(join(t, CHAT_DIR))}-`);
  let names: string[];
  try {
    names = await readdir(projects);
  } catch {
    return [];
  }
  const ids = new Set<string>();
  for (const name of names) {
    const prefix = prefixes.find((p) => name.startsWith(p));
    const id = prefix ? name.slice(prefix.length) : undefined;
    if (id && UUID.test(id) && id.length === 36) ids.add(id);
  }
  return [...ids];
}

/**
 * Le trascrizioni dei turni di PRIMA della correzione della review (cwd
 * `mkdtemp(<tmp>/stubwise-chat-XXXXXX)`, una per turno, mai ripresa): il resto
 * del nome è il suffisso casuale di `mkdtemp`, mai un uuid. La potatura le
 * toglie. Restituisce quante.
 */
export async function removeLegacyChatCliDirs(paths: ChatCliPaths = {}): Promise<number> {
  const projects = join(configDirOf(paths), "projects");
  const tmp = paths.tmp ?? tmpdir();
  const prefixes = [...new Set([tmp, await realOrSelf(tmp)])].map((t) => `${cliProjectDirName(t)}-stubwise-chat-`);
  let names: string[];
  try {
    names = await readdir(projects);
  } catch {
    return 0;
  }
  let removed = 0;
  for (const name of names) {
    const prefix = prefixes.find((p) => name.startsWith(p));
    if (!prefix) continue;
    const rest = name.slice(prefix.length);
    if (/^[A-Za-z0-9]{6}$/.test(rest)) {
      await rm(join(projects, name), { recursive: true, force: true });
      removed += 1;
    }
  }
  return removed;
}
