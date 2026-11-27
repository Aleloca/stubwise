/// <reference lib="webworker" />
import { VaultCore, type CoreRequest } from "./core";

// Il Dedicated Worker della cassaforte nel browser (revisione di sicurezza
// I-1): caricato al boot da un file del bundle (`client.ts`), è un reame a
// sé che gli script della pagina non raggiungono. Tiene la chiave e fa la
// crittografia e la rete della cassaforte (`core.ts`); alla pagina arrivano
// solo esiti, e per Show e Copy la sola password.

declare const self: DedicatedWorkerGlobalScope;

const core = new VaultCore({
  fetch: (path, init) => self.fetch(path, init),
  now: () => Date.now(),
  setTimer: (fn, ms) => self.setTimeout(fn, ms),
  clearTimer: (timer) => self.clearTimeout(timer as number),
  emit: (event) => self.postMessage({ event }),
});

self.addEventListener("message", (message: MessageEvent<{ id: number; req: CoreRequest }>) => {
  const { id, req } = message.data;
  void core.handle(req).then((res) => self.postMessage({ id, res }));
});
