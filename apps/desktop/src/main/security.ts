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
    if (data.byteLength < ZIP_MAGIC.length || data.byteLength > MAX_SAVE_BYTES || !isZip(data)) return null;
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
  return format === "pdf" ? { name: "PDF", extensions: ["pdf"] } : { name: "Word", extensions: ["docx"] };
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
