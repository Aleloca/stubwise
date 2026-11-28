import { describe, expect, it } from "vitest";

// Zod senza eval nella build web (`csp-init.ts`, con `zodWithoutEval` di
// `@stubwise/shared/csp`): la sua sonda `new Function` sarebbe una
// violazione della CSP e dei Trusted Types, e nel worker della cassaforte
// non vogliamo nessun `eval`. Vale solo se gira PRIMA che si valuti uno
// schema: è il primo import del boot della pagina e del worker, e il boot è
// il primo import di `main.tsx`.

const FIRST_IMPORT = /^\s*import\s+(?:[^"']*from\s+)?["']([^"']+)["']/m;
const SOURCES = import.meta.glob(["../data/backend/real/vaultBrowser/boot.ts", "../data/backend/real/vaultBrowser/worker.ts"], {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

describe("Zod senza eval, prima di ogni schema", () => {
  it("`csp-init` è il PRIMO import del boot della pagina e del worker", () => {
    const firsts = Object.entries(SOURCES).map(([path, src]) => [path, FIRST_IMPORT.exec(src.replace(/^\s*\/\/.*$/gm, ""))?.[1]]);
    expect(firsts).toEqual([
      ["../data/backend/real/vaultBrowser/boot.ts", "../../../../csp-init"],
      ["../data/backend/real/vaultBrowser/worker.ts", "../../../../csp-init"],
    ]);
  });
});
