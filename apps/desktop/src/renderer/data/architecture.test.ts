import { describe, expect, it } from "vitest";

// Le superfici leggono i dati solo dagli hook di `data/queries.ts` e dai tipi
// di `data/types.ts`: mai dal seed. I test delle superfici possono usarlo per
// calcolare i valori attesi, quindi sono esclusi.
const SOURCES = import.meta.glob(
  [
    "../pages/**/*.{ts,tsx}",
    "../tasks-ui/**/*.{ts,tsx}",
    "../layout/**/*.{ts,tsx}",
    "../components/**/*.{ts,tsx}",
    "../palette/**/*.{ts,tsx}",
    "../notifications/**/*.{ts,tsx}",
    "!**/*.test.{ts,tsx}",
  ],
  { query: "?raw", import: "default", eager: true },
) as Record<string, string>;

const SEED_IMPORT = /from\s+["'][^"']*data\/seed(\/[^"']*)?["']/;

describe("architettura", () => {
  it("trova i sorgenti delle superfici", () => {
    expect(Object.keys(SOURCES).length).toBeGreaterThan(10);
  });

  it("nessuna superficie importa da data/seed", () => {
    const offenders = Object.entries(SOURCES)
      .filter(([, source]) => SEED_IMPORT.test(source))
      .map(([path]) => path);
    expect(offenders).toEqual([]);
  });

  // Integrazione area 2, fetta 1: la build app non contiene il finto. Le
  // superfici leggono chi guarda da `data/viewing` e il tempo da
  // `@backend/runtime`; `data/viewer` (il «vedi come») e `data/store` sono il
  // finto, e il «vedi come» si legge da `@backend/viewer`. La prova sul bundle
  // vero è `scripts/check-no-seed.mjs` (CI e immagine caddy).
  // Integrazione area 2, fetta 1 (Task 17): follower, ferma a mano, allegati
  // e collegamenti hanno scritture dedicate (`useInlineWrite`), che sul server
  // sono rotte loro. Passarli a `updateTask` (`change(task, {…})`) li
  // scriverebbe nel prototipo e fallirebbe nella build app.
  it("nessuna superficie passa followerIds, manualStall, attachments o links a updateTask", () => {
    const WHOLE_LIST =
      /\b(?:change|updateTask|apply)\(\s*[\w.]+,\s*\{\s*(?:followerIds|manualStall|attachments|links)\s*:/;
    const offenders = Object.entries(SOURCES)
      .filter(([, source]) => WHOLE_LIST.test(source))
      .map(([path]) => path);
    expect(offenders).toEqual([]);
  });

  it("nessuna superficie importa data/viewer o data/store", () => {
    const FAKE_IMPORT = /from\s+["'][^"']*data\/(viewer|store)["']/;
    const offenders = Object.entries(SOURCES)
      .filter(([, source]) => FAKE_IMPORT.test(source))
      .map(([path]) => path);
    expect(offenders).toEqual([]);
  });
});

// `insertRequest` scrive una richiesta senza controllare permessi: oltre al
// suo file la usa solo il triage simulato di Support (mai una scrittura di
// una persona, che passa da `createRequestAs`).
const DATA_SOURCES = import.meta.glob(["./**/*.{ts,tsx}", "!**/*.test.{ts,tsx}"], {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

describe("insertRequest", () => {
  it("fuori dal suo file la usa solo data/support/simulate.ts", () => {
    const users = Object.entries(DATA_SOURCES)
      .filter(
        ([path, source]) =>
          /\binsertRequest\b/.test(source) &&
          path !== "./api-mutations.ts" &&
          // Lo stub generato della build app (Task 11 dell'integrazione) la
          // nomina per coprire ogni esportazione del finto, non la usa.
          path !== "./backend/real/stubs.generated.ts",
      )
      .map(([path]) => path);
    expect(users).toEqual(["./support/simulate.ts"]);
  });
});

// Anti-obiettivo 3: le chiavi private stanno solo in `servers/secrets.ts`.
// Lo importa solo l'accesso (l'analisi ci arriva attraverso `access.ts`; la
// correzione passa dall'agente, area 8 F4b, e non lo raggiunge); nessuna lettura
// dei server lo raggiunge, nemmeno di riflesso attraverso un altro modulo.
// Limite: il risolutore segue solo gli import dentro `data/`; per `domain/`
// (regole pure, che non devono toccare dati né segreti) c'è un controllo a
// parte sugli import diretti.
const SECRETS = "./servers/secrets.ts";
const IMPORT_RE = /(?:from|import)\s*\(?\s*["'](\.{1,2}\/[^"']+)["']/g;

/** I moduli di `data/` che `path` importa direttamente (percorsi come le chiavi di `DATA_SOURCES`). */
function importsOf(path: string): string[] {
  const dir = path.split("/").slice(0, -1);
  return [...DATA_SOURCES[path]!.matchAll(IMPORT_RE)].flatMap(([, spec]) => {
    const parts = [...dir];
    for (const seg of spec!.split("/")) {
      if (seg === "..") parts.pop();
      else if (seg !== ".") parts.push(seg);
    }
    const base = parts.join("/");
    const hit = [`${base}.ts`, `${base}.tsx`, `${base}/index.ts`].find((p) => p in DATA_SOURCES);
    return hit ? [hit] : [];
  });
}

/** Tutto ciò che `start` raggiunge per import, se stesso compreso. */
function reachable(start: string): Set<string> {
  const seen = new Set<string>();
  const todo = [start];
  while (todo.length) {
    const p = todo.pop()!;
    if (seen.has(p)) continue;
    seen.add(p);
    todo.push(...importsOf(p));
  }
  return seen;
}

// Anti-obiettivo «dati finti davanti a un utente vero» (integrazione area 2):
// l'adattatore vero (`backend/real/`) non raggiunge MAI, nemmeno di riflesso,
// lo stato del prototipo (`store.ts`) né il seme. Successo il 24 nov 2026:
// `real/releases.ts` prendeva `releaseHref` da `releases/visibility.ts`, che
// importa `access.ts` e quindi `store.ts` e ogni seme: tutto il seme finiva
// nel bundle dell'app (lo ha visto `check-no-seed.mjs` al primo pacchetto).
describe("l'adattatore vero non tocca il prototipo", () => {
  it("nessun modulo di backend/real/ raggiunge store.ts o il seme", () => {
    const real = Object.keys(DATA_SOURCES).filter(
      (p) => p.startsWith("./backend/real/") && p !== "./backend/real/stubs.generated.ts",
    );
    expect(real.length).toBeGreaterThan(20);
    const offenders = real.flatMap((p) => {
      const path = valueReachable(p);
      const hit = [...path.keys()].find((r) => r === "./store.ts" || r.startsWith("./seed/"));
      if (!hit) return [];
      const chain = [hit];
      for (let at = path.get(hit); at; at = path.get(at)) chain.push(at);
      return [chain.reverse().join(" → ")];
    });
    expect(offenders).toEqual([]);
  });
});

/** Gli import di VALORE di `path` dentro `data/` (un `import type` sparisce nel build). */
function valueImportsOf(path: string): string[] {
  const source = DATA_SOURCES[path]!.replace(/^\s*(?:import|export)\s+type\b[^;]*;/gm, "").replace(
    /typeof import\(\s*["'][^"']+["']\s*\)/g,
    "",
  );
  const dir = path.split("/").slice(0, -1);
  return [...source.matchAll(IMPORT_RE)].flatMap(([, spec]) => {
    const parts = [...dir];
    for (const seg of spec!.split("/")) {
      if (seg === "..") parts.pop();
      else if (seg !== ".") parts.push(seg);
    }
    const base = parts.join("/");
    const hit = [`${base}.ts`, `${base}.tsx`, `${base}/index.ts`].find((p) => p in DATA_SOURCES);
    return hit ? [hit] : [];
  });
}

/** Ciò che `start` raggiunge per import di valore, con da dove (per dire la catena). */
function valueReachable(start: string): Map<string, string | null> {
  const from = new Map<string, string | null>([[start, null]]);
  const todo = [start];
  while (todo.length) {
    const p = todo.shift()!;
    for (const next of valueImportsOf(p)) {
      if (from.has(next)) continue;
      from.set(next, p);
      todo.push(next);
    }
  }
  return from;
}

describe("chiavi private dei server", () => {
  it("secrets.ts lo importa solo access.ts", () => {
    const importers = Object.keys(DATA_SOURCES).filter((p) => importsOf(p).includes(SECRETS));
    expect(importers).toEqual(["./servers/access.ts"]);
  });

  it("la correzione dei server non tocca chiavi né accessi SSH (F4b: passa dall'agente)", () => {
    expect(importsOf("./servers/fix.ts")).not.toContain("./servers/access.ts");
    expect(importsOf("./servers/fix.ts")).not.toContain(SECRETS);
    expect(importsOf("./servers/fixScripts.ts")).not.toContain("./servers/access.ts");
  });

  it("le letture dei server non raggiungono secrets.ts", () => {
    // Il risolutore funziona: da access.ts ci si arriva.
    expect(reachable("./servers/access.ts").has(SECRETS)).toBe(true);
    for (const read of ["./servers/reads.ts", "./servers/visibility.ts"])
      expect(reachable(read).has(SECRETS), read).toBe(false);
  });

  it("nessuna regola di domain/ importa i segreti", () => {
    const domain = import.meta.glob(["../domain/**/*.{ts,tsx}"], {
      query: "?raw",
      import: "default",
      eager: true,
    }) as Record<string, string>;
    expect(Object.keys(domain).length).toBeGreaterThan(10);
    const offenders = Object.entries(domain)
      .filter(([, s]) => /from\s+["'][^"']*servers\/secrets["']/.test(s))
      .map(([p]) => p);
    expect(offenders).toEqual([]);
  });

  it("l'aiuto dei test non lo usa il codice dell'app", () => {
    const users = Object.entries(DATA_SOURCES)
      .filter(([p, s]) => /__privateValuesForTest/.test(s) && p !== SECRETS)
      .map(([p]) => p);
    expect(users).toEqual([]);
  });
});
