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

const LOCAL_HOSTS = new Set(["localhost", "::1", "[::1]", "0.0.0.0"]);

/** Tutto `127.0.0.0/8`, non solo `127.0.0.1`: è tutto loopback. */
const LOOPBACK_V4 = /^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/**
 * L'host di una variabile d'ambiente che punta al daemon Docker o ai
 * container (`DOCKER_HOST=tcp://10.0.0.5:2375`,
 * `TESTCONTAINERS_HOST_OVERRIDE=10.0.0.5`): in CI o su un Docker remoto i
 * container NON stanno su localhost, e un server di prova lì è locale quanto
 * uno sulla macchina. `unix://…` non ha un host: niente da ammettere.
 */
function hostOf(value: string | undefined): string | null {
  const raw = value?.trim();
  if (!raw) return null;
  try {
    const host = new URL(raw.includes("://") ? raw : `tcp://${raw}`).hostname;
    return host === "" ? null : host;
  } catch {
    return null;
  }
}

/**
 * Vero se una richiesta a `hostname` NON esce in rete: loopback (`localhost`,
 * `*.localhost`, `127.0.0.0/8`, `::1`), `0.0.0.0`, e gli host di
 * `DOCKER_HOST`/`TESTCONTAINERS_HOST_OVERRIDE` se impostati. Esportata per i
 * suoi test; `env` iniettabile.
 */
export function isLocalHost(hostname: string, env: NodeJS.ProcessEnv = process.env): boolean {
  if (LOCAL_HOSTS.has(hostname) || hostname.endsWith(".localhost")) return true;
  const v4 = LOOPBACK_V4.exec(hostname);
  if (v4 && v4.slice(1).every((octet) => Number(octet) <= 255)) return true;
  const allowed = [hostOf(env.DOCKER_HOST), hostOf(env.TESTCONTAINERS_HOST_OVERRIDE)];
  return allowed.some((host) => host !== null && host === hostname);
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
