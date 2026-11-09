import { resolve } from "node:path";
import type { Alias } from "vite";

/**
 * Il punto di scambio del livello dati (integrazione area 2, fetta 1): lo
 * stesso renderer si costruisce sul finto (`prototype`: il prototipo, i
 * test, `preview:web`) o sul server vero (`app`: desktop e `/app`).
 */
export type BackendMode = "prototype" | "app";

/** Il modo della build, da `STUBWISE_BUILD` (default `prototype`). */
export function backendMode(env: NodeJS.ProcessEnv = process.env): BackendMode {
  return env.STUBWISE_BUILD === "app" ? "app" : "prototype";
}

const data = resolve(import.meta.dirname, "src/renderer/data");

/**
 * Gli alias `@backend/*` per il modo dato: l'api, l'orologio, il tempo e i
 * reset (`runtime`), i fatti sugli accessi (`access`), il `Viewer` del prototipo. Ogni modulo vero è tipato sul
 * finto (`tsconfig.json` → `paths`).
 */
export function backendAliases(mode: BackendMode): Alias[] {
  const app = mode === "app";
  return [
    {
      find: /^@backend\/api$/,
      replacement: resolve(data, app ? "backend/real/index.ts" : "api.ts"),
    },
    {
      find: /^@backend\/clock$/,
      replacement: resolve(data, app ? "backend/real/clock.ts" : "seed/dates.ts"),
    },
    {
      find: /^@backend\/runtime$/,
      replacement: resolve(data, app ? "backend/real/runtime.ts" : "runtime.ts"),
    },
    {
      find: /^@backend\/access$/,
      replacement: resolve(data, app ? "backend/real/accessFacts.ts" : "accessFacts.ts"),
    },
    {
      find: /^@backend\/viewer$/,
      replacement: resolve(data, app ? "backend/real/viewer.ts" : "viewer.ts"),
    },
  ];
}

/** `import.meta.env.VITE_STUBWISE_BUILD` fissato nel bundle. */
export function backendDefine(mode: BackendMode): Record<string, string> {
  return { "import.meta.env.VITE_STUBWISE_BUILD": JSON.stringify(mode) };
}
