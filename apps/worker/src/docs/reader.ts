import type { RepoFile, RepoReader } from "@stubwise/docs-engine";
import { execa } from "execa";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";

/**
 * Implementazione reale di `RepoReader` (l'interfaccia pura di docs-engine) su
 * una directory di worktree git. È l'UNICO punto della pipeline Docs dove sono
 * ammessi fs ed exec: il motore (i prompt/parser puri del DAG in docs-engine) resta
 * puro e riceve questo reader iniettato (il survey dell'orientamento lo usa).
 *
 * - `list()` shella su `git ls-files` nel worktree: elenca SOLO i file tracciati,
 *   quindi rispetta automaticamente il `.gitignore` (niente node_modules/dist
 *   committati per sbaglio a parte, che docs-engine filtra comunque). La size di
 *   ogni file viene letta con `fs.stat` (un file tracciato ma cancellato dal
 *   working tree viene saltato: `stat` fallisce e lo escludiamo).
 * - `read(path)` legge il file sotto il worktree come UTF-8 e lo ritorna come
 *   stringa. NON è pensato per binari: il motore filtra a monte per estensione, e
 *   un eventuale binario letto qui verrebbe decodificato come utf-8 lossy. Sopra
 *   `MAX_READ_BYTES` il file viene RIFIUTATO con un errore chiaro (un sorgente
 *   enorme è quasi sempre generato/minificato e non va documentato, oltre a non
 *   stare nel budget di contesto dell'agent).
 *
 * Sicurezza: i path arrivano da `git ls-files` (già relativi alla root del
 * worktree e tracciati), non da input utente; `read` li ricongiunge a `dir` con
 * `join`. Il timeout sul `git ls-files` evita di appendere il worker su un repo
 * patologico.
 */

const GIT_LS_FILES_TIMEOUT_MS = 120_000;

/**
 * Tetto sulla dimensione di un singolo file leggibile da `read()`. Oltre questa
 * soglia il file viene rifiutato con un errore chiaro: un sorgente più grande è
 * quasi sempre generato/minificato (non documentabile) e non sta comunque nel
 * budget di contesto dell'agent.
 */
const MAX_READ_BYTES = 2 * 1024 * 1024;

export function createWorktreeReader(dir: string): RepoReader {
  return {
    async list(): Promise<RepoFile[]> {
      // -z: separatore NUL, robusto a path con spazi/newline.
      const { stdout } = await execa("git", ["ls-files", "-z"], {
        cwd: dir,
        timeout: GIT_LS_FILES_TIMEOUT_MS,
      });
      const paths = stdout.split("\0").filter((p) => p.length > 0);
      const files: RepoFile[] = [];
      for (const path of paths) {
        try {
          const info = await stat(join(dir, path));
          if (info.isFile()) files.push({ path, size: info.size });
        } catch {
          // File tracciato ma assente dal working tree (es. cancellato senza
          // commit): non documentabile, lo si salta in silenzio.
        }
      }
      return files;
    },
    async read(path: string): Promise<string> {
      const full = join(dir, path);
      const info = await stat(full);
      if (info.size > MAX_READ_BYTES) {
        throw new Error(
          `[docs] file '${path}' troppo grande (${info.size} byte > ${MAX_READ_BYTES}): non leggibile`,
        );
      }
      return readFile(full, "utf8");
    },
  };
}
