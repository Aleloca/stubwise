import { afterAll, afterEach, beforeEach } from "vitest";

/**
 * Guardia di rete dei test del server (`setupFiles` in `vitest.config.ts`).
 *
 * Un `fetch` verso un host NON locale che nessun test ha doppiato è una
 * chiamata di rete reale: lenta, instabile e, verso un provider git, capace di
 * dipendere da credenziali vere. Qui la si rende impossibile.
 *
 * Due metà, e servono entrambe:
 *  - il wrapper LANCIA, così la chiamata non parte mai;
 *  - il wrapper REGISTRA la violazione, e `afterEach` fa fallire il test.
 *    È la metà che conta: il codice sotto test ha percorsi fail-open
 *    (`resolveProviderUserId` cattura ogni errore) che ingoierebbero
 *    l'eccezione, e il test resterebbe verde senza che nessuno se ne accorga.
 *
 * I doppi non sono toccati: `vi.stubGlobal("fetch", …)` e
 * `vi.spyOn(globalThis, "fetch").mockImplementation(…)` sostituiscono questo
 * wrapper per la durata del test, e al ripristino tornano a lui. Un
 * `fetchImpl` iniettato non passa da `globalThis.fetch` affatto.
 *
 * I testcontainers parlano col socket Docker via `http` di Node (dockerode),
 * non via `fetch`, e Postgres col suo protocollo TCP: nessuno dei due passa
 * da qui. Gli host locali restano ammessi per un eventuale server di prova.
 */

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]", "0.0.0.0"]);

function isLocalHost(hostname: string): boolean {
  return LOCAL_HOSTS.has(hostname) || hostname.endsWith(".localhost");
}

function describeRequest(input: unknown, init?: RequestInit): { method: string; url: string } {
  if (input instanceof Request) {
    return { method: (init?.method ?? input.method).toUpperCase(), url: input.url };
  }
  const url = input instanceof URL ? input.href : String(input);
  return { method: (init?.method ?? "GET").toUpperCase(), url };
}

const violations: string[] = [];
const realFetch = globalThis.fetch;

const guardedFetch: typeof fetch = (input, init) => {
  const { method, url } = describeRequest(input, init);
  let hostname: string | null = null;
  try {
    hostname = new URL(url).hostname;
  } catch {
    // URL non assoluto: lo lasciamo rifiutare al fetch vero, che non esce in rete.
  }
  if (hostname !== null && !isLocalHost(hostname)) {
    const message = `Chiamata di rete reale bloccata nei test: ${method} ${url} — doppia fetch o il provider`;
    violations.push(message);
    return Promise.reject(new Error(message));
  }
  return realFetch(input, init);
};

globalThis.fetch = guardedFetch;

function flush(): void {
  if (violations.length === 0) return;
  const found = violations.splice(0, violations.length);
  throw new Error(found.join("\n"));
}

// Una violazione nata fuori da un test (in un beforeAll, o a livello di
// modulo) non ha un afterEach suo: la fa fallire il primo test che parte dopo,
// col messaggio che dice quale URL, e altrimenti l'afterAll del file.
beforeEach(() => {
  flush();
});

afterEach(() => {
  flush();
});

afterAll(() => {
  flush();
});
