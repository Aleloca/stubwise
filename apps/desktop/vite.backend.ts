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

/**
 * Cassaforte nel browser (design §4, I1): DOVE gira la build «app», fissato
 * al build e mai scelto a runtime su `window.stubwise` (che uno script può
 * falsare): `electron` (`build:app`, la chiave nel main) o `web` (`build:web`,
 * `/app`, la chiave nella scheda). Decide `@backend/vault`.
 */
export type BackendTarget = "electron" | "web";

const data = resolve(import.meta.dirname, "src/renderer/data");

/**
 * Gli alias `@backend/*` per il modo dato: l'api, l'orologio, il tempo e i
 * reset (`runtime`), i fatti sugli accessi (`access`), il `Viewer` del prototipo. Ogni modulo vero è tipato sul
 * finto (`tsconfig.json` → `paths`).
 */
export function backendAliases(mode: BackendMode, target: BackendTarget = "electron"): Alias[] {
  const app = mode === "app";
  return [
    {
      // Nel prototipo il namespace vero non si usa (lo importa solo
      // `backend/real/index.ts`): i test lo leggono sul modulo Electron.
      find: /^@backend\/vault$/,
      replacement: resolve(data, app && target === "web" ? "backend/real/vault/web.ts" : "backend/real/vault/electron.ts"),
    },
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
export function backendDefine(mode: BackendMode, target: BackendTarget = "electron"): Record<string, string> {
  return {
    "import.meta.env.VITE_STUBWISE_BUILD": JSON.stringify(mode),
    "import.meta.env.VITE_STUBWISE_TARGET": JSON.stringify(target),
  };
}
