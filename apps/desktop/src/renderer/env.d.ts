/// <reference types="vite/client" />

interface Window {
  /** Esposto dal preload; assente quando il renderer gira in un browser normale. */
  stubwise?: { platform: string };
}
