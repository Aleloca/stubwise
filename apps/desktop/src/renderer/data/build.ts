/**
 * Il modo della build (integrazione area 2, fetta 1): `prototype` (dati finti,
 * «vedi come») o `app` (server vero). Letto a ogni chiamata, non fissato al
 * caricamento: nei test è una variabile d'ambiente che `vi.stubEnv` cambia;
 * nelle build lo fissa il `define` di `vite.backend.ts`.
 */
export type BuildMode = "prototype" | "app";

export function buildMode(): BuildMode {
  return import.meta.env.VITE_STUBWISE_BUILD === "app" ? "app" : "prototype";
}

export function isAppBuild(): boolean {
  return buildMode() === "app";
}

/**
 * DOVE gira la build «app» (cassaforte nel browser, design §4): `electron` o
 * `web` (`/app`), fissato dal `define` di `vite.backend.ts` e mai dedotto dal
 * ponte a runtime. Letto a ogni chiamata, come `buildMode`: nei test lo cambia
 * `vi.stubEnv("VITE_STUBWISE_TARGET", "web")`.
 */
export type BuildTarget = "electron" | "web";

export function buildTarget(): BuildTarget {
  return import.meta.env.VITE_STUBWISE_TARGET === "web" ? "web" : "electron";
}

/**
 * L'app desktop (build app col ponte del preload): area 9, R4b. Lì le
 * passkey non ci sono (vivono sul dominio dell'istanza, cioè nel browser).
 * Letto a ogni chiamata, come `buildMode`.
 */
export function isDesktopApp(): boolean {
  return isAppBuild() && typeof window !== "undefined" && !!window.stubwise?.api;
}
