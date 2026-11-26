import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { OfficeResult } from "./office.js";

/**
 * L'estrazione Office/ODF in un PROCESSO FIGLIO `node`, come gli altri
 * estrattori: un archivio ostile non blocca il worker (la coda, i poller, il
 * ponte della chat) e non lo può far morire. Un tetto di memoria
 * (`--max-old-space-size`) e un timeout: oltre, il figlio muore o si uccide e
 * il risultato è `limits`. Un altro errore del figlio è `unreadable`.
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

/** Il tetto dell'output del figlio: il testo estratto è già limitato da `extractOffice`. */
const MAX_STDOUT_BYTES = 64 * 1024 * 1024;

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Il codice del figlio: carica `office.js` (in `dist`) o, nei test sui
 * sorgenti, `office.ts` con tsx registrato; legge il file della tmp a pezzi e
 * scrive il risultato in JSON su stdout. Riceve solo percorso, peso e MIME.
 */
const BOOTSTRAP = `
const input = JSON.parse(process.argv[1]);
const { createReadStream } = await import("node:fs");
try {
  if (input.moduleUrl.endsWith(".ts")) (await import("tsx/esm/api")).register();
  const { extractOffice } = await import(input.moduleUrl);
  const result = await extractOffice(createReadStream(input.path, { highWaterMark: 65536 }), input.size, input.mime);
  process.stdout.write(JSON.stringify({ ok: true, result }));
} catch (error) {
  process.stdout.write(JSON.stringify({ ok: false, error: String(error) }));
}
`;

/** In `dist` il `.js` compilato; nei test (sorgenti TypeScript) il `.ts`. */
function officeModuleUrl(): string {
  const js = join(here, "office.js");
  return pathToFileURL(existsSync(js) ? js : join(here, "office.ts")).href;
}

export function extractOfficeInThread(
  input: { path: string; size: number; mime: string },
  limits: { timeoutMs?: number; maxOldGenerationSizeMb?: number; onStart?: (pid: number) => void } = {},
): Promise<OfficeResult> {
  const timeoutMs = limits.timeoutMs ?? OFFICE_THREAD_LIMITS.timeoutMs;
  const heapMb = limits.maxOldGenerationSizeMb ?? OFFICE_THREAD_LIMITS.maxOldGenerationSizeMb;
  return new Promise((resolve) => {
    let settled = false;
    let timedOut = false;
    const out: Buffer[] = [];
    let outBytes = 0;
    let err = "";
    // `cwd` accanto al modulo: `tsx` (solo nei test) si risolve dal package del worker.
    const child = spawn(
      process.execPath,
      [`--max-old-space-size=${heapMb}`, "--input-type=module", "-e", BOOTSTRAP, JSON.stringify({ ...input, moduleUrl: officeModuleUrl() })],
      { cwd: here, stdio: ["ignore", "pipe", "pipe"], env: { PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin", LANG: "C.UTF-8" }, windowsHide: true },
    );
    const done = (result: OfficeResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      resolve(result);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      done({ kind: "limits" });
    }, timeoutMs);
    if (child.pid !== undefined) limits.onStart?.(child.pid);
    child.stdout.on("data", (chunk: Buffer) => {
      outBytes += chunk.length;
      if (outBytes > MAX_STDOUT_BYTES) return done({ kind: "limits" });
      out.push(chunk);
    });
    // Basta l'INIZIO di stderr per riconoscere l'OOM (poi viene la traccia nativa, lunga).
    child.stderr.on("data", (chunk: Buffer) => {
      if (err.length < 16_384) err += chunk.toString("utf8");
    });
    child.once("error", () => done({ kind: "unreadable" }));
    child.once("close", (code) => {
      if (timedOut) return done({ kind: "limits" });
      // Oltre il tetto il figlio muore da sé («JavaScript heap out of memory»): è un tetto, `limits`.
      if (code !== 0) return done(/heap out of memory|Reached heap limit/i.test(err) ? { kind: "limits" } : { kind: "unreadable" });
      try {
        const msg = JSON.parse(Buffer.concat(out).toString("utf8")) as { ok: boolean; result?: OfficeResult };
        done(msg.ok && msg.result ? msg.result : { kind: "unreadable" });
      } catch {
        done({ kind: "unreadable" });
      }
    });
  });
}
