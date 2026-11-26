import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { CHILD_ENV, prlimitArgs } from "./exec.js";
import { EXTRACT_LIMITS } from "./limits.js";
import type { OfficeResult } from "./office.js";

/**
 * L'estrazione Office/ODF in un PROCESSO FIGLIO `node`, come gli altri
 * estrattori: un archivio ostile non blocca il worker (la coda, i poller, il
 * ponte della chat) e non lo può far morire. I tetti: in produzione `prlimit`
 * con cpu e file scritti come gli altri figli, l'ambiente dei figli,
 * `--max-old-space-size` per l'heap e un timeout. Oltre un tetto il figlio
 * muore o si uccide e il risultato è `limits`; un altro errore è `unreadable`.
 *
 * Niente `prlimit --as` (la memoria VIRTUALE), deliberatamente: V8 riserva
 * spazio di indirizzi ben oltre l'heap, e col tetto degli altri figli (1 GB)
 * un docx legittimo da 40 MB, che con 256 MB di heap si legge, moriva
 * («young object promotion failed»; provato in `node:22-slim` il 26 nov
 * 2026, a 2 GB passava). La soglia dipenderebbe da come V8 riserva, non da
 * quanto il file pesa: il tetto vero è l'heap, e i buffer dello zip sono già
 * limitati da `office.ts` (peso e rapporto di compressione).
 *
 * Fino al 26 nov 2026 era un `worker_thread` con `resourceLimits` (da qui il
 * nome del file e della funzione, tenuti per non spostare i chiamanti). Su
 * Node 22 Linux — l'immagine del worker è `node:22-slim` — un thread oltre il
 * tetto dentro una replace globale abbatteva l'INTERO processo («Reached heap
 * limit»), non solo il thread: l'ha preso la CI della PR #125, ed è
 * riprodotto in un container `node:22-slim` (Node 24 e macOS invece
 * terminavano il thread). Un processo figlio non ha questa differenza.
 */
export const OFFICE_THREAD_LIMITS = { timeoutMs: 60_000, maxOldGenerationSizeMb: 256 } as const;

/**
 * Il testo che il figlio scrive: `textMaxChars` più UNO, così chi riceve sa
 * ancora che è troncato (`finish` di `extract.ts`). Il tetto di stdout regge
 * il caso peggiore di quel testo nel JSON — sei byte per carattere (`\u0001`)
 * — più un margine per l'involucro: oltre, è un figlio che non fa ciò che
 * deve, e il worker non parsa nulla.
 */
const CHILD_TEXT_MAX_CHARS = EXTRACT_LIMITS.textMaxChars + 1;
export const OFFICE_STDOUT_MAX_BYTES = CHILD_TEXT_MAX_CHARS * 6 + 64 * 1024;

/**
 * Le uscite di un figlio che è stato UCCISO o è morto per un tetto: il
 * segnale (SIGKILL del kernel all'OOM o di prlimit, SIGABRT/SIGTRAP di V8,
 * SIGXCPU/SIGXFSZ di prlimit) o, se un involucro lo riporta come codice,
 * 128 + segnale. Senza un nostro timeout sono comunque un tetto: `limits`.
 */
const LIMIT_SIGNALS: ReadonlySet<string> = new Set(["SIGKILL", "SIGABRT", "SIGTRAP", "SIGXCPU", "SIGXFSZ", "SIGSEGV"]);
const LIMIT_EXIT_CODES: ReadonlySet<number> = new Set([133, 134, 137, 139, 152, 153]);
/** Le varianti del messaggio di V8 quando la memoria finisce. */
const OOM_MESSAGE = /out of memory|heap limit|allocation failed|invalid array length|invalid string length/i;

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Il codice del figlio: carica `office.js` (in `dist`) o, nei test sui
 * sorgenti, `office.ts` con tsx registrato; legge il file della tmp a pezzi,
 * tronca il testo e scrive il risultato in JSON su stdout. Riceve solo
 * percorso, peso, MIME e il tetto del testo.
 */
const BOOTSTRAP = `
const input = JSON.parse(process.argv[1]);
const { createReadStream } = await import("node:fs");
try {
  if (input.tsxUrl) (await import(input.tsxUrl)).register();
  const { extractOffice } = await import(input.moduleUrl);
  const result = await extractOffice(createReadStream(input.path, { highWaterMark: 65536 }), input.size, input.mime);
  if (result.kind === "ok" && result.text.length > input.maxChars) result.text = result.text.slice(0, input.maxChars);
  process.stdout.write(JSON.stringify({ ok: true, result }));
} catch (error) {
  process.stdout.write(JSON.stringify({ ok: false, error: String(error) }));
}
`;

/**
 * In `dist` il `.js` compilato; nei test (sorgenti TypeScript) il `.ts`, con
 * tsx: lo specificatore si risolve dalla `cwd` del figlio, accanto al modulo,
 * cioè dal package del worker.
 */
function officeModule(): { moduleUrl: string; tsxUrl: string | null } {
  const js = join(here, "office.js");
  if (existsSync(js)) return { moduleUrl: pathToFileURL(js).href, tsxUrl: null };
  return { moduleUrl: pathToFileURL(join(here, "office.ts")).href, tsxUrl: "tsx/esm/api" };
}

/** Il comando del figlio: `node` coi suoi argomenti, dietro `prlimit` in produzione. */
export function officeChildCommand(opts: { prlimit: boolean; timeoutMs: number; heapMb: number; payload: string }): {
  file: string;
  args: string[];
  env: typeof CHILD_ENV;
} {
  const node = [`--max-old-space-size=${opts.heapMb}`, "--input-type=module", "-e", BOOTSTRAP, opts.payload];
  if (!opts.prlimit) return { file: process.execPath, args: node, env: CHILD_ENV };
  return { file: "prlimit", args: [...prlimitArgs(opts.timeoutMs, null), process.execPath, ...node], env: CHILD_ENV };
}

export function extractOfficeInThread(
  input: { path: string; size: number; mime: string },
  limits: { timeoutMs?: number; maxOldGenerationSizeMb?: number; prlimit?: boolean; onStart?: (pid: number) => void } = {},
): Promise<OfficeResult> {
  const timeoutMs = limits.timeoutMs ?? OFFICE_THREAD_LIMITS.timeoutMs;
  const heapMb = limits.maxOldGenerationSizeMb ?? OFFICE_THREAD_LIMITS.maxOldGenerationSizeMb;
  const payload = JSON.stringify({ ...input, ...officeModule(), maxChars: CHILD_TEXT_MAX_CHARS });
  const cmd = officeChildCommand({ prlimit: limits.prlimit === true, timeoutMs, heapMb, payload });
  return new Promise((resolve) => {
    let settled = false;
    /** Un nostro tetto (tempo, stdout) ha già deciso `limits`: si aspetta solo che il figlio sia via. */
    let overLimit = false;
    const out: Buffer[] = [];
    let outBytes = 0;
    let err = "";
    const child = spawn(cmd.file, cmd.args, { cwd: here, stdio: ["ignore", "pipe", "pipe"], env: cmd.env, windowsHide: true });
    const finish = (result: OfficeResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    /** Uccide il figlio per un nostro tetto; la promessa si risolve alla sua chiusura, a processo raccolto. */
    const stop = () => {
      overLimit = true;
      child.kill("SIGKILL");
    };
    const timer = setTimeout(stop, timeoutMs);
    if (child.pid !== undefined) limits.onStart?.(child.pid);
    child.stdout.on("data", (chunk: Buffer) => {
      if (overLimit) return;
      outBytes += chunk.length;
      if (outBytes > OFFICE_STDOUT_MAX_BYTES) return stop();
      out.push(chunk);
    });
    // Basta l'INIZIO di stderr per riconoscere l'OOM (poi viene la traccia nativa, lunga).
    child.stderr.on("data", (chunk: Buffer) => {
      if (err.length < 16_384) err += chunk.toString("utf8");
    });
    child.once("error", () => finish({ kind: "unreadable" }));
    child.once("close", (code, signal) => {
      if (overLimit) return finish({ kind: "limits" });
      if (code !== 0) {
        const killed = (signal !== null && LIMIT_SIGNALS.has(signal)) || (code !== null && LIMIT_EXIT_CODES.has(code)) || OOM_MESSAGE.test(err);
        return finish(killed ? { kind: "limits" } : { kind: "unreadable" });
      }
      try {
        const msg = JSON.parse(Buffer.concat(out).toString("utf8")) as { ok: boolean; result?: OfficeResult };
        finish(msg.ok && msg.result ? msg.result : { kind: "unreadable" });
      } catch {
        finish({ kind: "unreadable" });
      }
    });
  });
}
