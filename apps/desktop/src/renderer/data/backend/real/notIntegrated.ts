/**
 * Una lettura o scrittura che la build «app» non ha ancora sul server vero
 * (integrazione a fette: `docs/plans/2026-11-09-integrazione-area2-task-design.md`).
 * Le destinazioni non integrate mostrano «in arrivo» e non la chiamano; se
 * succede, l'errore dice quale nome manca invece di un `undefined is not a
 * function`.
 */
export class NotIntegratedError extends Error {
  readonly fn: string;
  constructor(fn: string) {
    super(`${fn} is not integrated in this build`);
    this.name = "NotIntegratedError";
    this.fn = fn;
  }
}

/** Una funzione asincrona non integrata: rifiuta con `NotIntegratedError`. */
export function notIntegrated(fn: string): (...args: unknown[]) => Promise<never> {
  return () => Promise.reject(new NotIntegratedError(fn));
}

/** Una funzione sincrona non integrata: lancia subito. */
export function notIntegratedSync(fn: string): (...args: unknown[]) => never {
  return () => {
    throw new NotIntegratedError(fn);
  };
}

/**
 * Un valore non integrato (né funzione né costante letterale): leggerne una
 * proprietà lancia. Il valore in sé si può importare senza errori.
 */
export function notIntegratedValue(name: string): object {
  return new Proxy(
    {},
    {
      get(_target, key) {
        if (typeof key === "symbol" || key === "then") return undefined;
        throw new NotIntegratedError(`${name}.${key}`);
      },
    },
  );
}

/**
 * Un namespace dell'api (`api.chat`, `api.docs`…): ogni chiave è una funzione
 * che rifiuta. `then` e i simboli restano `undefined`, così `await` e gli
 * strumenti di debug non lo scambiano per una promessa.
 */
export function notIntegratedNamespace(ns: string): object {
  return new Proxy(
    {},
    {
      get(_target, key) {
        if (typeof key === "symbol" || key === "then") return undefined;
        return notIntegrated(`${ns}.${key}`);
      },
    },
  );
}

/**
 * Un namespace dell'api integrato solo in parte (`api.auth`, `api.admin`):
 * le chiavi di `impl` sono vere, ogni altra rifiuta come
 * `notIntegratedNamespace`.
 */
export function partialNamespace<T extends object>(ns: string, impl: Partial<T>): T {
  return new Proxy(impl as T, {
    get(target, key) {
      if (typeof key === "symbol" || key === "then") return undefined;
      if (key in target) return (target as Record<string, unknown>)[key];
      return notIntegrated(`${ns}.${key}`);
    },
  });
}
