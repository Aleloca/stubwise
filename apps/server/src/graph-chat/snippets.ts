import { join } from "node:path";
// ATTENZIONE: import dal SUBPATH, non dal barrel `@stubwise/shared` — vedi il
// docblock di mirror-slug.ts (node:crypto romperebbe il build della SPA).
import { mirrorSlug } from "@stubwise/shared/mirror-slug";
import { execa } from "execa";
import type { SubgraphNode } from "./subgraph.js";

/**
 * Estrattore degli snippet di codice citati nel sottografo.
 *
 * Il server monta il volume `mirrors` in READ-ONLY (gli stessi bare repo che il
 * worker clona e aggiorna) e legge i blob con `git --git-dir=<mirror> show
 * <sha>:<path>`. Lo `<sha>` è il commit su cui il grafo è stato costruito: le
 * righe indicate dai nodi combaciano col contenuto anche se nel frattempo il
 * mirror è avanzato. Se quel commit non è (più) risolvibile si ripiega su HEAD,
 * dove le righe possono essere leggermente sfalsate ma il file è comunque il più
 * informativo che abbiamo.
 *
 * REGOLA D'ORO: un problema su un singolo snippet si salta in silenzio (log
 * debug) e non deve MAI diventare un errore in chat. Anche un problema globale
 * (directory del mirror assente, git non installato) si limita a restituire
 * quello che si era già accumulato — spesso `[]`.
 */

/** Estratto di codice pronto per il prompt. */
export interface Snippet {
  /** Percorso relativo alla radice del repository. */
  path: string;
  /** Prima riga inclusa (1-based). */
  startLine: number;
  /** Ultima riga inclusa (1-based). */
  endLine: number;
  /** Righe grezze, senza numeri di riga aggiunti. */
  code: string;
}

/** Logger minimale in stile pino (vedi GraphMcpLogger in client.ts). */
export interface SnippetLogger {
  debug(obj: unknown, msg?: string): void;
}

export interface ExtractSnippetsParams {
  /** Radice dei mirror bare montata sul server (`MIRRORS_DIR`). */
  mirrorsDir: string;
  /** URL del repository: determina la directory del mirror via {@link mirrorSlug}. */
  repoUrl: string;
  /** Commit su cui è stato costruito il grafo (`repo_graphs.commit_sha`). */
  commitSha: string;
  /** Nodi del sottografo, nell'ordine di rilevanza restituito da graphify. */
  nodes: SubgraphNode[];
  /** Numero massimo di nodi da cui leggere (`GRAPH_CHAT_SNIPPET_NODES`). */
  maxNodes: number;
  /** Tetto complessivo dei caratteri di codice (`GRAPH_CHAT_SNIPPET_MAX_CHARS`). */
  maxTotalChars: number;
  logger?: SnippetLogger;
}

/** Righe di contesto sopra la definizione (firma, decoratori, docblock corto). */
const LINES_BEFORE = 3;
/** Righe sotto la definizione: quanto basta per il corpo di una funzione media. */
const LINES_AFTER = 35;

/**
 * Timeout di un `git show`: legge un blob da un repo locale, se non risponde in
 * fretta qualcosa non va (disco occupato, mirror in fetch) e si rinuncia.
 */
const GIT_TIMEOUT_MS = 3_000;

/**
 * Oltre questa dimensione il file non è codice sorgente sensato (bundle, dump,
 * binario): non lo si taglia nemmeno, si salta.
 */
const MAX_FILE_CHARS = 1_000_000;

/**
 * Legge un file dal mirror bare al revision indicato. Ritorna `null` su
 * qualunque esito non utile: `reject: false` fa sì che nemmeno un exit code
 * diverso da zero o un timeout diventino eccezioni.
 */
async function gitShow(gitDir: string, revision: string, path: string): Promise<string | null> {
  const result = await execa("git", [`--git-dir=${gitDir}`, "show", `${revision}:${path}`], {
    timeout: GIT_TIMEOUT_MS,
    reject: false,
    // Mai prompt interattivi: meglio fallire subito che restare appesi.
    env: { GIT_TERMINAL_PROMPT: "0" },
    maxBuffer: MAX_FILE_CHARS * 2,
  });
  if (result.exitCode !== 0) return null;
  const { stdout } = result;
  if (typeof stdout !== "string" || stdout.length === 0) return null;
  // Difensivo: file enorme o binario (un NUL non compare mai nel sorgente).
  if (stdout.length > MAX_FILE_CHARS || stdout.includes("\u0000")) return null;
  return stdout;
}

/**
 * Costruisce gli estratti di codice per i nodi dati, nell'ordine ricevuto,
 * fermandosi al primo che farebbe sforare {@link ExtractSnippetsParams.maxTotalChars}
 * (quello che sfora NON viene incluso).
 */
export async function extractSnippets(params: ExtractSnippetsParams): Promise<Snippet[]> {
  const { mirrorsDir, repoUrl, commitSha, nodes, maxNodes, maxTotalChars, logger } = params;
  const snippets: Snippet[] = [];

  try {
    const gitDir = join(mirrorsDir, mirrorSlug(repoUrl));
    let totalChars = 0;

    for (const node of nodes.slice(0, maxNodes)) {
      const content =
        (await gitShow(gitDir, commitSha, node.path)) ??
        // Il commit del grafo può essere sparito (mirror ricreato) o il file
        // può essere nato dopo: HEAD è il ripiego.
        (await gitShow(gitDir, "HEAD", node.path));
      if (content === null) {
        logger?.debug(
          { path: node.path, commitSha, gitDir },
          "[graph-chat] snippet saltato: file non leggibile dal mirror",
        );
        continue;
      }

      const lines = content.split("\n");
      // Un file che finisce con newline produce un'ultima riga vuota: non conta.
      if (lines.at(-1) === "") lines.pop();
      const startLine = Math.max(1, node.line - LINES_BEFORE);
      const endLine = Math.min(lines.length, node.line + LINES_AFTER);
      if (startLine > lines.length) continue; // Riga oltre la fine: nodo stantio.

      const code = lines.slice(startLine - 1, endLine).join("\n");
      if (totalChars + code.length > maxTotalChars) break;
      totalChars += code.length;
      snippets.push({ path: node.path, startLine, endLine, code });
    }
  } catch (err) {
    // Nessun errore risale alla chat: si tiene quel che si è accumulato.
    logger?.debug({ err, repoUrl }, "[graph-chat] estrazione degli snippet interrotta");
  }

  return snippets;
}
