import { Resolver } from "node:dns/promises";
import { Agent, request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { checkImageUrl, isBlockedAddress } from "./address.js";

// La richiesta del proxy delle immagini verso il mittente (design
// `docs/plans/2026-11-28-proxy-immagini-posta-design.md`, §3–§5). Non accetta
// opzioni dal chiamante oltre all'URL: niente header inoltrati, niente
// metodo, niente porte. Le dipendenze (DNS e connessione) si iniettano solo
// nei test.

/** Al più 3 redirect (4 richieste in tutto), ciascuno ricontrollato per intero. */
export const MAX_REDIRECTS = 3;
/** Il tetto della risposta: oltre, si interrompe. */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
/** Connessione (TCP + TLS) e risposta intera. */
export const CONNECT_TIMEOUT_MS = 3_000;
export const TOTAL_TIMEOUT_MS = 8_000;
/** Richieste verso l'esterno insieme, per tutta l'istanza: il server non è un amplificatore. */
export const MAX_CONCURRENT_FETCHES = 8;
/** Quante aspettano un posto, al più, e per quanto (revisione I2): oltre, `busy`. */
export const MAX_FETCH_QUEUE = 16;
export const QUEUE_WAIT_MS = 3_000;
/** Il DNS: un solo tentativo, entro questo (c-ares, fuori dal threadpool di libuv). */
export const DNS_TIMEOUT_MS = 2_000;
/** Generico e uguale per tutte le istanze: nessuna versione, nessun nome d'istanza (design §5, PI 6). */
export const IMAGE_PROXY_USER_AGENT = "Mozilla/5.0 (compatible; ImageProxy)";

export type ImageFetchFailure = "invalid" | "scheme" | "port" | "credentials" | "host" | "address" | "redirects" | "status" | "too_large" | "timeout" | "not_image" | "network" | "busy";

export type ImageFetchResult = { ok: true; contentType: RasterType; bytes: Buffer } | { ok: false; reason: ImageFetchFailure };

export type RasterType = "image/png" | "image/jpeg" | "image/gif" | "image/webp" | "image/avif";

export interface RemoteResponse {
  status: number;
  headers: Record<string, string | undefined>;
  body: AsyncIterable<Buffer>;
}

export interface ImageFetchDeps {
  /** Tutti gli indirizzi di un nome (A e AAAA). */
  resolve(host: string): Promise<string[]>;
  /** Una GET verso `address` (già controllato), con SNI, `Host` e certificato di `host`. */
  request(req: { url: URL; host: string; address: string; headers: Record<string, string>; signal: AbortSignal }): Promise<RemoteResponse>;
  totalMs: number;
  /** Solo test: l'attesa massima di un posto (di norma `QUEUE_WAIT_MS`). */
  queueWaitMs?: number;
}

/** Il tipo di un'immagine dai suoi primi byte; null se non è un raster ammesso (SVG compreso). */
export function sniffRaster(head: Buffer): RasterType | null {
  const at = (i: number, ...bytes: number[]) => bytes.every((b, k) => head[i + k] === b);
  const ascii = (i: number, text: string) => head.subarray(i, i + text.length).toString("latin1") === text;
  if (at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "image/png";
  if (at(0, 0xff, 0xd8, 0xff)) return "image/jpeg";
  if (ascii(0, "GIF87a") || ascii(0, "GIF89a")) return "image/gif";
  if (ascii(0, "RIFF") && ascii(8, "WEBP")) return "image/webp";
  if (ascii(4, "ftyp") && (ascii(8, "avif") || ascii(8, "avis"))) return "image/avif";
  return null;
}

/** Il `Content-Type` dichiarato, normalizzato (`image/jpg` è `image/jpeg`). */
function declaredType(value: string | undefined): string {
  const type = (value ?? "").split(";")[0]!.trim().toLowerCase();
  return type === "image/jpg" || type === "image/pjpeg" ? "image/jpeg" : type;
}

/**
 * Il trasporto di Node verso il mittente. Le opzioni servono SOLO ai test
 * d'integrazione (un server TLS locale): la porta, la CA che lo firma e
 * l'indirizzo a cui connettersi davvero al posto di quello controllato. In
 * produzione: 443, le CA di sistema, l'indirizzo controllato.
 */
export function createNodeRequest(opts: { port?: number; ca?: string | Buffer; connectAddress?: (checked: string) => string } = {}): ImageFetchDeps["request"] {
  // Un agent esplicito, senza keep-alive (revisione M2): niente proxy
  // d'ambiente (`HTTPS_PROXY`, `NODE_USE_ENV_PROXY`) e niente socket riusati
  // fra un mittente e l'altro.
  const agent = new Agent({ keepAlive: false, ...(opts.ca ? { ca: opts.ca } : {}) });
  return ({ host, address, headers, signal, url }) =>
    new Promise((resolve, reject) => {
      const target = opts.connectAddress ? opts.connectAddress(address) : address;
      const family = isIP(target);
      const literal = isIP(host) !== 0;
      const req = httpsRequest(
        {
          agent,
          host,
          // SNI e certificato del NOME (senza il punto finale, revisione M5); un IP letterale non ha SNI.
          ...(literal ? {} : { servername: host }),
          port: opts.port ?? 443,
          path: `${url.pathname}${url.search}`,
          method: "GET",
          headers,
          signal,
          // La connessione va all'indirizzo GIÀ controllato: il DNS non si
          // rilegge fra il controllo e la connessione (DNS rebinding). Da
          // Node 20 `autoSelectFamily` chiede `{ all: true }` e vuole un
          // elenco (revisione I1).
          lookup: (_host, lookupOpts, cb) => {
            if ((lookupOpts as { all?: boolean } | undefined)?.all) (cb as unknown as (e: null, a: { address: string; family: number }[]) => void)(null, [{ address: target, family }]);
            else cb(null, target, family);
          },
          timeout: CONNECT_TIMEOUT_MS,
        },
        (res) => {
          const out: Record<string, string | undefined> = {};
          for (const [k, v] of Object.entries(res.headers)) out[k] = Array.isArray(v) ? v[0] : v;
          resolve({ status: res.statusCode ?? 0, headers: out, body: res });
        },
      );
      req.on("timeout", () => req.destroy(new Error("connect timeout")));
      req.on("error", reject);
      req.end();
    });
}

/**
 * Il DNS con c-ares (`dns.Resolver`), un tentativo e un timeout: non usa il
 * threadpool di libuv (`getaddrinfo`), quindi un autoritativo muto non ferma
 * scrypt dei login né il resto del server (revisione I2). A e AAAA insieme.
 */
const resolver = new Resolver({ timeout: DNS_TIMEOUT_MS, tries: 1 });
async function resolveAll(host: string): Promise<string[]> {
  const [v4, v6] = await Promise.allSettled([resolver.resolve4(host), resolver.resolve6(host)]);
  return [...(v4.status === "fulfilled" ? v4.value : []), ...(v6.status === "fulfilled" ? v6.value : [])];
}

const defaultDeps: ImageFetchDeps = { resolve: resolveAll, request: createNodeRequest(), totalMs: TOTAL_TIMEOUT_MS };

/** Una promessa in corsa col segnale: annullato, si rifiuta subito (il lavoro sotto non tiene il chiamante). */
function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new Error("aborted"));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new Error("aborted"));
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(
      (v) => {
        signal.removeEventListener("abort", onAbort);
        resolve(v);
      },
      (e: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(e);
      },
    );
  });
}

let active = 0;
const waiting: { go: () => void }[] = [];
/**
 * Un posto fra le `MAX_CONCURRENT_FETCHES` richieste esterne, o null: coda
 * piena, o attesa oltre `waitMs` (revisione I2). Il rilascio passa il posto
 * al primo in coda.
 */
async function slot(waitMs: number): Promise<(() => void) | null> {
  const release = () => {
    const next = waiting.shift();
    if (next) next.go();
    else active--;
  };
  if (active < MAX_CONCURRENT_FETCHES) {
    active++;
    return release;
  }
  if (waiting.length >= MAX_FETCH_QUEUE) return null;
  return new Promise((resolve) => {
    const entry = {
      go: () => {
        clearTimeout(timer);
        resolve(release);
      },
    };
    const timer = setTimeout(() => {
      const at = waiting.indexOf(entry);
      if (at >= 0) waiting.splice(at, 1);
      resolve(null);
    }, waitMs);
    waiting.push(entry);
  });
}

/**
 * Scarica UN'immagine remota da un URL preso da un'email, coi controlli del
 * design: URL e host normalizzati (`checkImageUrl`), DNS risolto qui e
 * connessione all'IP controllato, redirect a mano ricontrollati, tetti di
 * tempo e dimensione, tipo deciso dai byte. Non lancia mai: ogni fallimento
 * è un motivo, che la rotta riduce a un 422 uguale per tutti.
 */
export async function fetchRemoteImage(rawUrl: string, deps: ImageFetchDeps = defaultDeps): Promise<ImageFetchResult> {
  const release = await slot(deps.queueWaitMs ?? QUEUE_WAIT_MS);
  if (!release) return { ok: false, reason: "busy" };
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, deps.totalMs);
  try {
    return await fetchWithin(rawUrl, deps, controller.signal);
  } catch {
    return { ok: false, reason: timedOut ? "timeout" : "network" };
  } finally {
    clearTimeout(timer);
    // La richiesta e il suo corpo si chiudono SEMPRE, anche sulle uscite
    // anticipate (tipo, tetto, redirect), revisione M1.
    controller.abort();
    release();
  }
}

async function fetchWithin(rawUrl: string, deps: ImageFetchDeps, signal: AbortSignal): Promise<ImageFetchResult> {
  let current = rawUrl;
  for (let hop = 0; ; hop++) {
    const check = checkImageUrl(current);
    if (!check.ok) return check;
    const addresses = check.literal ? [check.literal] : await untilAborted(deps.resolve(check.host), signal);
    if (addresses.length === 0 || addresses.some((a) => isBlockedAddress(a))) return { ok: false, reason: "address" };
    const res = await deps.request({
      url: check.url,
      host: check.host,
      address: addresses[0]!,
      headers: { "User-Agent": IMAGE_PROXY_USER_AGENT, Accept: "image/*" },
      signal,
    });
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers["location"];
      if (!location) return { ok: false, reason: "status" };
      if (hop >= MAX_REDIRECTS) return { ok: false, reason: "redirects" };
      current = new URL(location, check.url).href;
      continue;
    }
    if (res.status !== 200) return { ok: false, reason: "status" };
    const declared = declaredType(res.headers["content-type"]);
    if (!declared.startsWith("image/")) return { ok: false, reason: "not_image" };
    const length = Number(res.headers["content-length"]);
    if (Number.isFinite(length) && length > MAX_IMAGE_BYTES) return { ok: false, reason: "too_large" };
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of res.body) {
      size += chunk.length;
      if (size > MAX_IMAGE_BYTES) return { ok: false, reason: "too_large" };
      chunks.push(chunk);
    }
    const bytes = Buffer.concat(chunks);
    const sniffed = sniffRaster(bytes.subarray(0, 16));
    // I byte decidono, e devono dire la stessa cosa del mittente: mai un SVG.
    if (!sniffed || sniffed !== declared) return { ok: false, reason: "not_image" };
    return { ok: true, contentType: sniffed, bytes };
  }
}
