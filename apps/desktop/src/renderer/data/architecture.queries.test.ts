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
