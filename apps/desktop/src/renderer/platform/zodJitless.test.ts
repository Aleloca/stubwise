import { createRequire } from "node:module";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// Zod senza JIT nella build web: zod legge la configurazione da
// `globalThis.__zod_globalConfig` (se una versione nuova cambiasse chiave,
// qui si vede), il modulo ci scrive `jitless`, e il modulo è il PRIMO
// import della pagina e del worker della cassaforte.

/** Lo zod che usa `@stubwise/shared` (il renderer non lo importa da sé). */
const zodPath = createRequire(resolve(import.meta.dirname, "../../../../../packages/shared/package.json")).resolve("zod");

/** Quel poco di zod che serve qui (il renderer non ne ha i tipi). */
type Zod = {
  config: () => { jitless?: boolean };
  object: (shape: Record<string, unknown>) => { parse: (v: unknown) => unknown };
  string: () => unknown;
};

const FIRST_IMPORT = /^\s*import\s+(?:[^"']*from\s+)?["']([^"']+)["']/m;
const SOURCES = import.meta.glob(["../data/backend/real/vaultBrowser/boot.ts", "../data/backend/real/vaultBrowser/worker.ts"], {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

describe("zod senza JIT, impostato prima di zod", () => {
  it("zod legge la configurazione da `globalThis.__zod_globalConfig`, e il modulo ci scrive `jitless`", async () => {
    const { z } = (await import(zodPath)) as { z: Zod };
    const global = () => (globalThis as { __zod_globalConfig?: { jitless?: boolean } }).__zod_globalConfig;
    expect(z.config()).toBe(global());
    await import("./zodJitless");
    expect(global()?.jitless).toBe(true);
    expect(z.config().jitless).toBe(true);
    expect(z.object({ a: z.string() }).parse({ a: "x" })).toEqual({ a: "x" });
  });

  it("è il PRIMO import del boot della pagina e del worker", () => {
    const firsts = Object.entries(SOURCES).map(([path, src]) => [path, FIRST_IMPORT.exec(src.replace(/^\s*\/\/.*$/gm, ""))?.[1]]);
    expect(firsts).toEqual([
      ["../data/backend/real/vaultBrowser/boot.ts", "../../../../platform/zodJitless"],
      ["../data/backend/real/vaultBrowser/worker.ts", "../../../../platform/zodJitless"],
    ]);
  });
});
