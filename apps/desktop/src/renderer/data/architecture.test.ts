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
      .filter(([path, source]) => /\binsertRequest\b/.test(source) && path !== "./api-mutations.ts")
      .map(([path]) => path);
    expect(users).toEqual(["./support/simulate.ts"]);
  });
});

// Anti-obiettivo 3: le chiavi private stanno solo in `servers/secrets.ts`.
// Lo importano solo gli accessi, l'analisi e la correzione; nessuna lettura
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

describe("chiavi private dei server", () => {
  it("secrets.ts lo importano solo access.ts, analysis.ts e fix.ts", () => {
    const importers = Object.keys(DATA_SOURCES).filter((p) => importsOf(p).includes(SECRETS));
    expect(importers).toContain("./servers/access.ts");
    expect(
      importers.filter(
        (p) => !["./servers/access.ts", "./servers/analysis.ts", "./servers/fix.ts"].includes(p),
      ),
    ).toEqual([]);
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
