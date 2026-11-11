import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import type { OfficeResult } from "./office.js";

/**
 * L'estrazione Office/ODF in un `worker_thread` (review della F3), come gli
 * altri estrattori stanno in un processo figlio: un archivio ostile non blocca
 * il thread principale del worker (e con lui la coda, i poller, il ponte della
 * chat). Un tetto di memoria (`resourceLimits`) e un timeout: oltre, il thread
 * si termina e il risultato è `limits`. Un errore del thread è `unreadable`.
 */
export const OFFICE_THREAD_LIMITS = { timeoutMs: 60_000, maxOldGenerationSizeMb: 256 } as const;

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Il codice del thread: carica `office.js` (in `dist`) o, nei test sui
 * sorgenti, `office.ts` con tsx registrato; legge il file della tmp a pezzi e
 * risponde col risultato. Riceve solo percorso, peso e MIME.
 */
const BOOTSTRAP = `
(async () => {
  const { workerData, parentPort } = await import("node:worker_threads");
  const { createReadStream } = await import("node:fs");
  try {
    if (workerData.moduleUrl.endsWith(".ts")) (await import("tsx/esm/api")).register();
    const { extractOffice } = await import(workerData.moduleUrl);
    const result = await extractOffice(createReadStream(workerData.path, { highWaterMark: 65536 }), workerData.size, workerData.mime);
    parentPort.postMessage({ ok: true, result });
  } catch (error) {
    parentPort.postMessage({ ok: false, error: String(error) });
  }
})();
`;

/** In `dist` il `.js` compilato; nei test (sorgenti TypeScript) il `.ts`. */
function officeModuleUrl(): string {
  const js = join(here, "office.js");
  return pathToFileURL(existsSync(js) ? js : join(here, "office.ts")).href;
}

export function extractOfficeInThread(
  input: { path: string; size: number; mime: string },
  limits: { timeoutMs?: number; maxOldGenerationSizeMb?: number } = {},
): Promise<OfficeResult> {
  const timeoutMs = limits.timeoutMs ?? OFFICE_THREAD_LIMITS.timeoutMs;
  return new Promise((resolve) => {
    let settled = false;
    const done = (result: OfficeResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate();
      resolve(result);
    };
    const worker = new Worker(BOOTSTRAP, {
      eval: true,
      workerData: { ...input, moduleUrl: officeModuleUrl() },
      resourceLimits: { maxOldGenerationSizeMb: limits.maxOldGenerationSizeMb ?? OFFICE_THREAD_LIMITS.maxOldGenerationSizeMb },
    });
    const timer = setTimeout(() => done({ kind: "limits" }), timeoutMs);
    worker.once("message", (msg: { ok: boolean; result?: OfficeResult }) => done(msg.ok && msg.result ? msg.result : { kind: "unreadable" }));
    // Un thread oltre il tetto di memoria muore con ERR_WORKER_OUT_OF_MEMORY: è un tetto, `limits`.
    worker.once("error", (error: NodeJS.ErrnoException) => done(error.code === "ERR_WORKER_OUT_OF_MEMORY" ? { kind: "limits" } : { kind: "unreadable" }));
    worker.once("exit", () => done({ kind: "unreadable" }));
  });
}
