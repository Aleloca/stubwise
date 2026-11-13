import { ApiError } from "@stubwise/api-client";

// I riferimenti delle Automations nella build app (area 7, F1): le pagine
// vanno per id, le rotte per codice (`/api/automations/:code`,
// `…/runs/:n`). L'adattatore ricorda dalle letture il codice e la revisione
// di un'automazione, e il codice, il numero e il passo in attesa di
// un'esecuzione. Le pagine arrivano a un id sempre da una lettura (il codice
// nell'URL si risolve sull'elenco), quindi un id mai letto è `not_found`.

export interface AutomationRefEntry {
  code: string;
  /** La revisione dell'ultima versione letta: `expectedRev` di pubblica, accendi, elimina. */
  rev: number | null;
}

export interface RunRefEntry {
  code: string;
  n: number;
  /** Il passo in attesa e il suo giro, visti nell'ultima lettura. */
  path: string | null;
  round: number;
  /** Lo stato visto (le voci di «Da decidere» non lo dicono: resta quello di prima). */
  status?: string;
}

export function createAutomationRefs() {
  const automations = new Map<string, AutomationRefEntry>();
  const runs = new Map<string, RunRefEntry>();
  return {
    rememberAutomation(a: { id: string; code: string; versions: { rev?: number | null }[] }) {
      automations.set(a.id, { code: a.code, rev: a.versions.at(-1)?.rev ?? null });
    },
    automation(id: string): AutomationRefEntry {
      const a = automations.get(id);
      if (!a) throw new Error("not_found");
      return a;
    },
    knowsAutomation: (id: string) => automations.has(id),
    rememberRun(r: {
      id: string;
      automationCode: string;
      n: number;
      cursor?: string | null;
      round?: number;
      status?: string;
    }) {
      runs.set(r.id, {
        code: r.automationCode,
        n: r.n,
        path: r.cursor ?? null,
        round: r.round ?? 0,
        status: r.status ?? runs.get(r.id)?.status,
      });
    },
    run(id: string): RunRefEntry {
      const r = runs.get(id);
      if (!r) throw new Error("not_found");
      return r;
    },
    knowsRun: (id: string) => runs.has(id),
    /** Il giro da mandare con `expectedPath`: quello visto, se il passo è lo stesso. */
    roundFor(id: string, expectedPath: string): number {
      const r = this.run(id);
      return r.path === expectedPath ? r.round : 0;
    },
    clear() {
      automations.clear();
      runs.clear();
    },
  };
}

export type AutomationRefs = ReturnType<typeof createAutomationRefs>;

/** Un errore del server come lo dicono le scritture del prototipo (`data/writer.ts`). */
export function asPrototypeError(error: unknown): unknown {
  if (!(error instanceof ApiError)) return error;
  if (error.status === 404) return new Error("not_found");
  if (error.status === 403) return new Error("forbidden");
  if (error.code) return new Error(`invalid: ${error.code}`);
  return error;
}

/** Una chiamata con gli errori nelle parole del prototipo. */
export async function inPrototypeWords<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    throw asPrototypeError(error);
  }
}

/** Una lettura: inesistente o invisibile (404) è `null`, come il prototipo. */
export async function orNull<T>(call: () => Promise<T>): Promise<T | null> {
  try {
    return await call();
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return null;
    throw asPrototypeError(error);
  }
}
