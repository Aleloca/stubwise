/**
 * Navigazione e CSP del processo main: funzioni pure, nessun import di
 * `electron`, così si testano in node.
 */

/**
 * Politica di produzione. Si inietta come `<meta>` nell'index.html SOLO nel
 * build (vedi `electron.vite.config.ts`) e, dal protocollo dell'app, anche
 * come header delle risposte di `app://stubwise`. In dev non si applica
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
/**
 * L'indirizzo del dev server (C1, seconda revisione della cassaforte): solo in
 * sviluppo. Nel pacchetto `ELECTRON_RENDERER_URL` non conta mai, altrimenti
 * chi rilancia l'app con quella env le fa caricare una pagina sua, col bridge
 * intero (cassaforte aperta, `api:request` col PAT).
 */
export function rendererDevUrl(opts: {
  isPackaged: boolean;
  env: Record<string, string | undefined>;
}): string | undefined {
  if (opts.isPackaged) return undefined;
  return opts.env["ELECTRON_RENDERER_URL"] || undefined;
}

/** Gli switch del debug remoto di Chromium: nessun fuse li copre (C2). */
const DEBUG_SWITCHES = ["remote-debugging-port", "remote-debugging-pipe"] as const;

/**
 * C2 (seconda revisione della cassaforte): nel pacchetto l'app non parte col
 * debug remoto di Chromium, che darebbe a un altro processo la pagina con la
 * cassaforte aperta. Restituisce lo switch trovato (l'app esce), o `null`.
 */
export function refusedDebugSwitch(opts: {
  isPackaged: boolean;
  hasSwitch: (name: string) => boolean;
}): string | null {
  if (!opts.isPackaged) return null;
  return DEBUG_SWITCHES.find((name) => opts.hasSwitch(name)) ?? null;
}

/**
 * Le preferenze della finestra: isolamento del contesto, niente Node, sandbox;
 * e i DevTools solo in sviluppo (M6, seconda revisione della cassaforte: dal
 * pacchetto la console leggerebbe il bridge con la cassaforte aperta).
 */
export function webPreferencesFor(opts: {
  isPackaged: boolean;
  preload: string;
  /** In sviluppo: l'origine del dev server, che il preload ammette per il bridge. */
  devOrigin?: string;
}) {
  return {
    preload: opts.preload,
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
    devTools: !opts.isPackaged,
    additionalArguments: opts.devOrigin ? [`${DEV_ORIGIN_ARG}${opts.devOrigin}`] : [],
  };
}

/** L'argomento con cui il main dice al preload l'origine del dev server. */
export const DEV_ORIGIN_ARG = "--stubwise-dev-origin=";

// --- il protocollo dell'app ----------------------------------------------------
//
// Il renderer impacchettato si serve da `app://stubwise/` (seconda revisione
// della cassaforte, dopo M5), non da `file://`: così la fuse
// `grantFileProtocolExtraPrivileges` si spegne, e una pagina file:// non ha né
// privilegi in più né il bridge.

export const APP_SCHEME = "app";
export const APP_HOST = "stubwise";
/** La pagina dell'app impacchettata. */
export const APP_ENTRY = `${APP_SCHEME}://${APP_HOST}/index.html`;

/**
 * Il file del renderer per una richiesta `app://stubwise/…`, o `null`: solo
 * dentro `root` (niente `..`, nemmeno codificati, niente percorsi assoluti),
 * solo quell'host; la radice è `index.html`. Query e frammento non contano.
 */
export function appFilePath(requestUrl: string, root: string): string | null {
  let url: URL;
  try {
    url = new URL(requestUrl);
  } catch {
    return null;
  }
  if (url.protocol !== `${APP_SCHEME}:` || url.host !== APP_HOST) return null;
  // Un `..` già nella richiesta (che `URL` normalizzerebbe in silenzio) la rifiuta.
  const raw = requestUrl.slice(`${APP_SCHEME}://${APP_HOST}`.length).split(/[?#]/)[0] ?? "";
  try {
    if (decodeURIComponent(raw).split(/[\\/]/).includes("..")) return null;
  } catch {
    return null;
  }
  let path: string;
  try {
    path = decodeURIComponent(url.pathname);
  } catch {
    return null;
  }
  if (path === "/" || path === "") path = "/index.html";
  const parts = path.split("/").slice(1);
  if (
    parts.some((p) => p === "" || p === "." || p === ".." || p.includes("\\") || p.includes("\0"))
  )
    return null;
  return `${root.replace(/\/+$/, "")}/${parts.join("/")}`;
}

const CONTENT_TYPES: Record<string, string> = {
  html: "text/html; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  css: "text/css; charset=utf-8",
  json: "application/json",
  svg: "image/svg+xml",
  png: "image/png",
  ico: "image/x-icon",
  woff2: "font/woff2",
  woff: "font/woff",
  map: "application/json",
};

/** Il Content-Type di un file del renderer, dall'estensione (`nosniff` lo fa valere). */
export function appContentType(path: string): string {
  const ext = /\.([a-z0-9]+)$/i.exec(path)?.[1]?.toLowerCase() ?? "";
  return CONTENT_TYPES[ext] ?? "application/octet-stream";
}

/**
 * Il preload espone `window.stubwise` SOLO alla pagina dell'app: app://stubwise
 * nel pacchetto, l'origine del dev server in sviluppo. Una pagina file:// o
 * qualunque altra che finisse nella finestra non riceve il bridge.
 */
export function bridgeAllowed(href: string, devOrigin: string | undefined): boolean {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return false;
  }
  if (devOrigin) {
    try {
      return url.origin === new URL(devOrigin).origin;
    } catch {
      return false;
    }
  }
  return url.protocol === `${APP_SCHEME}:` && url.host === APP_HOST;
}

export function isNavigationAllowed(target: string, opts: { devUrl?: string }): boolean {
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
  // La pagina dell'app impacchettata, e solo lei (l'hash cambia); file:// mai.
  return (
    url.protocol === `${APP_SCHEME}:` && url.host === APP_HOST && url.pathname === "/index.html"
  );
}

// --- file:save (area 11a, decisione 8 della spec) -----------------------------
//
// L'unico canale nuovo: il renderer chiede di salvare un PDF (che stampa il
// processo principale) o un Word (i suoi byte). Ogni argomento si valida qui,
// in una funzione pura: formato, nome, byte. Il percorso lo sceglie la
// persona nella finestra di salvataggio, mai il renderer, e non torna mai
// indietro.

export type SaveFormat = "pdf" | "docx";
export type SaveFileRequest =
  | { format: "pdf"; name: string }
  | { format: "docx"; name: string; data: Uint8Array };
export type SaveFileResult =
  | { saved: true }
  | { saved: false; reason: "canceled" | "invalid" | "failed" };

export const MAX_SAVE_BYTES = 25 * 1024 * 1024;
const MAX_NAME = 120;
/** Un .docx è uno zip: comincia con «PK\x03\x04» (il tipo si controlla sui byte, non sul nome). */
const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04] as const;

const isZip = (data: Uint8Array): boolean => ZIP_MAGIC.every((b, i) => data[i] === b);

/** `null` = rifiutata: formato ignoto, nome vuoto o > 120, `data` assente/estraneo/troppo grande, campi in più. */
export function parseSaveFileRequest(v: unknown): SaveFileRequest | null {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const keys = Object.keys(o);
  const { format, name } = o;
  if (typeof name !== "string" || name.trim() === "" || name.length > MAX_NAME) return null;
  if (format === "pdf") {
    if (keys.length !== 2) return null;
    return { format, name };
  }
  if (format === "docx") {
    if (keys.length !== 3 || !("data" in o)) return null;
    const { data } = o;
    if (!(data instanceof Uint8Array)) return null;
    if (data.byteLength < ZIP_MAGIC.length || data.byteLength > MAX_SAVE_BYTES || !isZip(data))
      return null;
    return { format, name, data };
  }
  return null;
}

const hasExtension = (name: string, format: SaveFormat): boolean =>
  name.toLowerCase().endsWith(`.${format}`);

/** Un nome di file, mai un percorso: via separatori, caratteri di controllo, «..», `<>:"|?*`; spazi compressi; l'estensione giusta in coda. */
export function safeFileName(name: string, format: SaveFormat): string {
  const cleaned = name
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/[/\\<>:"|?*]/g, "-")
    .replace(/\.{2,}/g, ".")
    .replace(/\s+/g, " ")
    // Niente punti né spazi in testa (file nascosti) o in coda (Windows li toglie).
    .replace(/^[.\s]+|[.\s]+$/g, "");
  const base = cleaned === "" ? "Stubwise export" : cleaned;
  return hasExtension(base, format) ? base : `${base}.${format}`;
}

/** Il filtro della finestra di salvataggio: solo l'estensione del formato. */
export function saveFilterFor(format: SaveFormat): { name: string; extensions: string[] } {
  return format === "pdf"
    ? { name: "PDF", extensions: ["pdf"] }
    : { name: "Word", extensions: ["docx"] };
}

/** Il percorso scelto con l'estensione del formato (aggiunta se manca). */
export function withExtension(path: string, format: SaveFormat): string {
  return hasExtension(path, format) ? path : `${path}.${format}`;
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
