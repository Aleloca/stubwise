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
  // Un worker che non nasce non spegne l'app: la cassaforte risulta non
  // disponibile (`worker_unavailable`), il resto gira.
  try {
    const w = primitives.newWorker(new URL(workerUrl, window.location.href).href, {
      type: "module",
      name: "stubwise-vault-worker",
    });
    if (w) attach(w);
  } catch {
    worker = null;
  }
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

/**
 * I-A: consegna l'uscita PRF al worker per TRANSFER, in modo sincrono e
 * senza promesse né mappe di mezzo; lo sblocco che segue la consuma. Senza
 * worker il buffer si azzera qui.
 */
export function stashPrf(prf: ArrayBuffer): void {
  if (!worker) {
    primitives.zero(prf);
    return;
  }
  primitives.postToWorker(worker, { id: 0, req: { t: "stash", prf } }, [prf]);
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
