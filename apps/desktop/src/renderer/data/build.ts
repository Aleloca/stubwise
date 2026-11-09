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
