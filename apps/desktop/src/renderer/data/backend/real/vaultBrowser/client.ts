import type { CoreEvent, CoreRequest } from "./core";
import { primitives } from "./primitives";
// Il worker costruito a sé da Vite (un file del bundle): `?worker&url` dà il
// suo indirizzo, che si apre col costruttore catturato.
import workerUrl from "./worker.ts?worker&url";

// Il canale della pagina verso il worker della cassaforte (revisione di
// sicurezza I-1): richieste con un id, risposte e eventi di stato. Il worker
// nasce al boot (`boot.ts`) da un file del bundle, col costruttore e il
// `postMessage` catturati.

let worker: Worker | null = null;
let nextId = 1;
const pending = new Map<number, (res: unknown) => void>();
const listeners = new Set<(event: CoreEvent) => void>();

function onMessage(event: Event): void {
  const data = (event as MessageEvent).data as { id?: number; res?: unknown; event?: CoreEvent };
  if (data.event) {
    for (const fn of [...listeners]) fn(data.event);
    return;
  }
  if (typeof data.id === "number") {
    pending.get(data.id)?.(data.res);
    pending.delete(data.id);
  }
}

function attach(next: Worker): void {
  worker = next;
  primitives.on(next, "message", onMessage);
}

/** Al boot: il worker dal file del bundle. Senza `Worker` (un browser senza) la cassaforte non si apre. */
export function startVaultWorker(): void {
  if (worker) return;
  const w = primitives.newWorker(new URL(workerUrl, window.location.href), { type: "module", name: "stubwise-vault-worker" });
  if (w) attach(w);
}

/** Una richiesta al worker; `transfer` passa la proprietà dei buffer (la PRF). */
export function request<T>(req: CoreRequest, transfer: Transferable[] = []): Promise<T> {
  if (!worker) return Promise.resolve({ ok: false, code: "worker_unavailable" } as T);
  const id = nextId++;
  return new Promise<T>((resolve) => {
    pending.set(id, resolve as (res: unknown) => void);
    primitives.postToWorker(worker!, { id, req }, transfer);
  });
}

/** Gli eventi di stato del worker (aperta, chiusa e perché). */
export function onCoreEvent(fn: (event: CoreEvent) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Solo per i test: un worker finto (un EventTarget con `postMessage`). */
export function __setWorkerForTests(next: Worker | null): void {
  pending.clear();
  listeners.clear();
  worker = null;
  if (next) attach(next);
}
