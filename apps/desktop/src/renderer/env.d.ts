/// <reference types="vite/client" />

interface Window {
  /** Esposto dal preload; assente quando il renderer gira in un browser normale. */
  stubwise?: {
    platform: string;
    /** Comunica al main il tema risolto (sfondo finestra, overlay su Windows). */
    setTheme?: (resolved: "light" | "dark") => void;
    /** Voci di menu dell'applicazione; restituisce la funzione per disiscriversi. */
    onMenu?: (cb: (channel: "menu:search" | "menu:preferences") => void) => () => void;
  };
}
