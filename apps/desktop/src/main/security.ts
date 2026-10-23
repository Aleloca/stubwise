/**
 * Navigazione e CSP del processo main: funzioni pure, nessun import di
 * `electron`, così si testano in node.
 */

/**
 * Politica di produzione. Si inietta come `<meta>` nell'index.html SOLO nel
 * build (vedi `electron.vite.config.ts`): il renderer impacchettato si carica
 * da `file://`, dove `onHeadersReceived` non scatta. In dev non si applica
 * (Vite/HMR vuole script inline e websocket). `frame-ancestors` manca apposta:
 * in un meta il browser lo ignora e lo segnala come errore in console;
 * l'anti-framing lo fanno il window-open handler e il will-navigate.
 */
export const PRODUCTION_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
].join("; ");

/**
 * Una navigazione della finestra è ammessa solo verso l'origine del dev
 * server (se c'è) o verso il file `index.html` impacchettato (cambia l'hash,
 * non il file). Tutto il resto — http(s) esterni, altri file — è negato.
 */
export function isNavigationAllowed(
  target: string,
  opts: { devUrl?: string; packagedUrl: string },
): boolean {
  let url: URL;
  try {
    url = new URL(target);
  } catch {
    return false;
  }
  if (opts.devUrl) {
    try {
      return url.origin === new URL(opts.devUrl).origin;
    } catch {
      return false;
    }
  }
  if (url.protocol !== "file:") return false;
  return url.pathname === new URL(opts.packagedUrl).pathname;
}

/** Solo http(s) esce verso il browser di sistema; ogni altro schema è scartato. */
export function isExternalOpenAllowed(target: string): boolean {
  try {
    const { protocol } = new URL(target);
    return protocol === "https:" || protocol === "http:";
  } catch {
    return false;
  }
}
