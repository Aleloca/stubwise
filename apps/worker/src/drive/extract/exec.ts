import { execFile } from "node:child_process";
import { access, constants } from "node:fs/promises";
import { delimiter, isAbsolute, join } from "node:path";
import { EXTRACT_LIMITS } from "./limits.js";

/**
 * Il lanciatore dei processi figli dell'estrazione (area 5, fetta 3). Il file
 * è input NON fidato, quindi:
 * - `execFile`, MAI una shell, con un array di argomenti che chi chiama
 *   compone da costanti, numeri calcolati e percorsi della tmp del job: mai un
 *   pezzo del nome o del contenuto del file;
 * - davanti, in produzione, `prlimit` con memoria e cpu limitate;
 * - al timeout il figlio si uccide con SIGKILL;
 * - un binario assente, un timeout, un crash sono RISULTATI, non eccezioni:
 *   chi chiama li trasforma in un motivo di `no_text` (fail-open).
 */
export type ExecResult =
  | { ok: true; stdout: Buffer }
  | { ok: false; kind: "missing" | "timeout" | "failed" | "output_limit"; detail: string };

export type ExecOptions = { cwd: string; timeoutMs: number; maxBuffer: number };
export type Exec = (cmd: string, args: readonly string[], opts: ExecOptions) => Promise<ExecResult>;
type Spawn = (file: string, args: readonly string[], opts: ExecOptions) => Promise<ExecResult>;

/** L'ambiente dei figli: solo il PATH, la lingua e un thread per tesseract. */
const CHILD_ENV = { PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin", LANG: "C.UTF-8", OMP_THREAD_LIMIT: "1" };

const realSpawn: Spawn = (file, args, opts) =>
  new Promise((resolve) => {
    execFile(
      file,
      [...args],
      { cwd: opts.cwd, timeout: opts.timeoutMs, killSignal: "SIGKILL", maxBuffer: opts.maxBuffer, encoding: "buffer", shell: false, env: CHILD_ENV, windowsHide: true },
      (error, stdout) => {
        if (!error) return resolve({ ok: true, stdout });
        const e = error as NodeJS.ErrnoException & { killed?: boolean; signal?: string | null; code?: string | number };
        if (e.code === "ENOENT") return resolve({ ok: false, kind: "missing", detail: `${file} not found` });
        if (e.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") return resolve({ ok: false, kind: "output_limit", detail: "stdout over the limit" });
        if (e.killed && e.signal === "SIGKILL") return resolve({ ok: false, kind: "timeout", detail: `${file} timed out` });
        resolve({ ok: false, kind: "failed", detail: `${file} exited with ${e.signal ?? e.code}` });
      },
    );
  });

/** Il binario c'è nel PATH dei figli? (Con prlimit davanti, un ENOENT del comando non si distinguerebbe.) */
async function onPath(cmd: string): Promise<boolean> {
  const candidates = isAbsolute(cmd) ? [cmd] : CHILD_ENV.PATH.split(delimiter).map((d) => join(d, cmd));
  for (const c of candidates) {
    try {
      await access(c, constants.X_OK);
      return true;
    } catch {
      // il prossimo
    }
  }
  return false;
}

export function createExec(opts: {
  prlimit: boolean;
  memoryBytes?: number;
  spawn?: Spawn;
  which?: (cmd: string) => Promise<boolean>;
}): Exec {
  const spawn = opts.spawn ?? realSpawn;
  const which = opts.which ?? onPath;
  const memory = opts.memoryBytes ?? EXTRACT_LIMITS.childMemoryBytes;
  return async (cmd, args, run) => {
    if (run.timeoutMs <= 0) return { ok: false, kind: "timeout", detail: "no time left for the job" };
    if (!(await which(cmd))) return { ok: false, kind: "missing", detail: `${cmd} not found` };
    if (!opts.prlimit) return spawn(cmd, args, run);
    const cpuSeconds = Math.ceil(run.timeoutMs / 1000) + 5;
    return spawn("prlimit", [`--as=${memory}`, `--cpu=${cpuSeconds}`, "--", cmd, ...args], run);
  };
}
