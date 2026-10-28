import { describe, expect, it } from "vitest";

// Le superfici leggono i dati solo dagli hook di `data/queries.ts` e dai tipi
// di `data/types.ts`: mai dal seed. I test delle superfici possono usarlo per
// calcolare i valori attesi, quindi sono esclusi.
const SOURCES = import.meta.glob(
  [
    "../pages/**/*.{ts,tsx}",
    "../tasks-ui/**/*.{ts,tsx}",
    "../layout/**/*.{ts,tsx}",
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
