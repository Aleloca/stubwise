import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// I sotto-moduli di `data/queries/` importano DA `../queries` e sono
// ri-esportati con `export *`: mai il contrario. Un import con nome nel verso
// opposto (com'era `useAiBlock` per la riga di Claude) cambia l'ordine di
// inizializzazione il giorno in cui uno dei due lati esegue codice al
// caricamento (review finale 10b, 3).

const source = readFileSync(resolve(__dirname, "queries.ts"), "utf8");

describe("data/queries.ts non importa dai suoi sotto-moduli", () => {
  it('solo `export * from "./queries/…"`, nessun `import … from "./queries/…"`', () => {
    expect(source).not.toMatch(/^\s*import\b[^;]*from\s+["']\.\/queries\//m);
    expect(source).toMatch(/^export \* from "\.\/queries\/claude";$/m);
  });
});

// Il punto di scambio (integrazione area 2, fetta 1, Task 11): le query
// leggono l'api SOLO da `@backend/api`, che la build risolve sul finto
// (prototipo, test) o sul server vero (app). Un import diretto di `./api`
// porterebbe il finto nella build app.
const QUERY_SOURCES = import.meta.glob(["./queries.ts", "./queries/*.ts", "!**/*.test.ts"], {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

describe("queries importa l'api solo da @backend/api", () => {
  it("trova le query", () => {
    expect(Object.keys(QUERY_SOURCES).length).toBeGreaterThan(5);
  });

  it("nessun import di valori da ./api, ../api, ./api-mutations o ../api-mutations", () => {
    const offenders = Object.entries(QUERY_SOURCES)
      .filter(([, source]) => /^\s*import\s+(?!type\b)[^;]*from\s+["'](\.\.?\/)api(-mutations)?["']/m.test(source))
      .map(([path]) => path);
    expect(offenders).toEqual([]);
  });

  it("queries.ts importa @backend/api", () => {
    expect(QUERY_SOURCES["./queries.ts"]).toMatch(/import \* as api from "@backend\/api";/);
  });
});
