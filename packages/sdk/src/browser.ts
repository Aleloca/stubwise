// Entry point browser: singleton di modulo con strumentazione automatica
// (errori globali, breadcrumb da click/navigazione/fetch, flush a fine
// pagina). DX: `import { init, captureFeedback } from "@stubwise/sdk/browser"`.
//
// Invariante ereditato dal core: a parte init() con un DSN malformato
// (errore di configurazione, deve fallire forte), niente di ciò che viene
// installato qui può mai lanciare nell'app ospite.
import type { Breadcrumb, TicketPriority, TicketType } from "@stubwise/shared";
import { Client, type ClientOptions } from "./core/client.js";
import { parseDsn } from "./core/transport.js";

export { BreadcrumbBuffer } from "./core/breadcrumbs.js";
export { Client, type ClientOptions } from "./core/client.js";
export {
  parseDsn,
  Transport,
  type FlushOptions,
  type ParsedDsn,
  type TransportOptions,
} from "./core/transport.js";

export type BrowserOptions = ClientOptions;

/** Finestra entro cui click identici consecutivi vengono collassati. */
const CLICK_THROTTLE_MS = 1000;

let client: Client | null = null;
/** Avviso "init non chiamato" emesso una sola volta. */
let warnedBeforeInit = false;
/** Disinstallatori della strumentazione corrente (solo per i test). */
let teardowns: Array<() => void> = [];

/** console.warn che non può mai propagare nell'app ospite. */
function warn(message: string): void {
  try {
    console.warn(`[stubwise] ${message}`);
  } catch {
    // mai propagare nell'app ospite
  }
}

/** Esegue un passo di strumentazione ignorando qualsiasi errore. */
function safely(step: () => void): void {
  try {
    step();
  } catch {
    // la strumentazione non deve mai rompere l'app ospite
  }
}

function activeClient(): Client | null {
  if (client) return client;
  if (!warnedBeforeInit) {
    warnedBeforeInit = true;
    warn("init() non ancora chiamato: chiamata ignorata");
  }
  return null;
}

/** Descrittore CSS-ish di un elemento cliccato: `tag#id`, `tag.classe` o `tag`. */
function describeClickTarget(target: unknown): string | null {
  const el = target as { tagName?: unknown; id?: unknown; classList?: { 0?: unknown } } | null;
  if (!el || typeof el.tagName !== "string") return null;
  const tag = el.tagName.toLowerCase();
  if (typeof el.id === "string" && el.id) return `${tag}#${el.id}`;
  const firstClass = el.classList?.[0];
  if (typeof firstClass === "string" && firstClass) return `${tag}.${firstClass}`;
  return tag;
}

/** Estrae metodo e URL da un input di fetch (stringa, URL o Request). */
function describeFetchRequest(
  input: RequestInfo | URL,
  init?: RequestInit,
): { method: string; url: string } {
  let url: string;
  let method = init?.method;
  if (typeof input === "string") {
    url = input;
  } else if (typeof (input as Request).url === "string" && typeof (input as Request).method === "string") {
    // Request (anche cross-realm: niente instanceof)
    url = (input as Request).url;
    method ??= (input as Request).method;
  } else {
    url = String(input); // URL e affini
  }
  return { method: (method ?? "GET").toUpperCase(), url };
}

function installErrorCapture(sdk: Client): void {
  const onError = (event: ErrorEvent): void => {
    safely(() => {
      sdk.captureError(event.error ?? event.message, {
        url: location.href,
        userAgent: navigator.userAgent,
      });
    });
  };
  const onRejection = (event: PromiseRejectionEvent): void => {
    safely(() => {
      sdk.captureError(event.reason, {
        url: location.href,
        userAgent: navigator.userAgent,
      });
    });
  };
  window.addEventListener("error", onError);
  window.addEventListener("unhandledrejection", onRejection);
  teardowns.push(() => {
    window.removeEventListener("error", onError);
    window.removeEventListener("unhandledrejection", onRejection);
  });
}

function installClickBreadcrumbs(sdk: Client): void {
  let lastDescriptor: string | null = null;
  let lastAt = 0;
  const onClick = (event: Event): void => {
    safely(() => {
      const descriptor = describeClickTarget(event.target);
      if (!descriptor) return;
      const now = Date.now();
      // throttle: 30 click identici di fila non devono inondare il ring buffer
      if (descriptor === lastDescriptor && now - lastAt < CLICK_THROTTLE_MS) return;
      lastDescriptor = descriptor;
      lastAt = now;
      sdk.addBreadcrumb({ type: "click", message: descriptor });
    });
  };
  // fase di capture: si vede il click anche se un handler ferma la propagazione
  document.addEventListener("click", onClick, true);
  teardowns.push(() => document.removeEventListener("click", onClick, true));
}

function installNavigationBreadcrumbs(sdk: Client): void {
  let currentUrl = location.href;
  const recordNavigation = (): void => {
    safely(() => {
      const to = location.href;
      if (to === currentUrl) return;
      sdk.addBreadcrumb({ type: "navigation", message: `${currentUrl} → ${to}` });
      currentUrl = to;
    });
  };

  const originalPushState = history.pushState;
  const originalReplaceState = history.replaceState;
  history.pushState = function (...args: Parameters<History["pushState"]>) {
    const result = originalPushState.apply(this, args);
    recordNavigation();
    return result;
  };
  history.replaceState = function (...args: Parameters<History["replaceState"]>) {
    const result = originalReplaceState.apply(this, args);
    recordNavigation();
    return result;
  };
  window.addEventListener("popstate", recordNavigation);
  window.addEventListener("hashchange", recordNavigation);
  teardowns.push(() => {
    history.pushState = originalPushState;
    history.replaceState = originalReplaceState;
    window.removeEventListener("popstate", recordNavigation);
    window.removeEventListener("hashchange", recordNavigation);
  });
}

/**
 * true solo per l'endpoint di ingestion ESATTO (eventualmente seguito da
 * query string o hash): `/ingest/my-app-v2` non deve combaciare con
 * l'endpoint `/ingest/my-app` di un altro progetto.
 */
function isIngestEndpointUrl(url: string, ingestEndpoint: string): boolean {
  if (!url.startsWith(ingestEndpoint)) return false;
  const next = url.charAt(ingestEndpoint.length);
  return next === "" || next === "?" || next === "#";
}

function installFetchBreadcrumbs(sdk: Client, ingestEndpoint: string): void {
  // ambienti esotici (fetch rimossa o sostituita con un non-callable): non
  // c'è niente da strumentare e soprattutto non si deve mai lanciare
  if (typeof window.fetch !== "function") return;
  const originalFetch = window.fetch;
  const wrappedFetch = function (
    this: unknown,
    ...args: Parameters<typeof fetch>
  ): Promise<Response> {
    // semantica preservata: stessi argomenti, stesso this (fallback window
    // per le chiamate "nude"), stessa promise restituita al chiamante
    const promise = Reflect.apply(originalFetch, this ?? window, args) as Promise<Response>;
    safely(() => {
      const { method, url } = describeFetchRequest(args[0], args[1]);
      // mai breadcrumb sui POST di ingestion dell'SDK stesso: un server che
      // risponde 5xx genererebbe breadcrumb → eventi → POST → feedback loop
      if (isIngestEndpointUrl(url, ingestEndpoint)) return;
      promise.then(
        (response) => {
          safely(() => {
            if (response.status >= 400) {
              sdk.addBreadcrumb({ type: "fetch", message: `${method} ${url} → ${response.status}` });
            }
          });
        },
        () => {
          safely(() => {
            sdk.addBreadcrumb({ type: "fetch", message: `${method} ${url} → errore di rete` });
          });
        },
      );
    });
    return promise;
  };
  window.fetch = wrappedFetch as typeof fetch;
  teardowns.push(() => {
    window.fetch = originalFetch;
  });
}

function installPageLifecycleFlush(sdk: Client): void {
  // keepalive: senza, il browser aborta le fetch avviate mentre la pagina
  // viene nascosta o scaricata e gli ultimi eventi andrebbero persi
  const onPageHide = (): void => {
    safely(() => void sdk.flush({ keepalive: true }));
  };
  const onVisibilityChange = (): void => {
    safely(() => {
      if (document.visibilityState === "hidden") void sdk.flush({ keepalive: true });
    });
  };
  window.addEventListener("pagehide", onPageHide);
  document.addEventListener("visibilitychange", onVisibilityChange);
  teardowns.push(() => {
    window.removeEventListener("pagehide", onPageHide);
    document.removeEventListener("visibilitychange", onVisibilityChange);
  });
}

/**
 * Inizializza l'SDK browser: crea il client singleton e installa la
 * strumentazione automatica. Lancia solo per DSN malformato (errore di
 * configurazione). Una seconda chiamata avvisa e non fa nulla: i listener
 * non vengono mai duplicati.
 */
export function init(options: BrowserOptions): void {
  if (client) {
    warn("init() già chiamato: la seconda chiamata viene ignorata");
    return;
  }

  // la fetch ORIGINALE va catturata prima del wrap: il transport deve
  // spedire con quella, mai con la versione strumentata (feedback loop)
  const preWrapFetch =
    typeof window.fetch === "function" ? window.fetch.bind(window) : undefined;

  const sdk = new Client({
    ...options,
    fetchImpl: options.fetchImpl ?? preWrapFetch,
  });
  client = sdk;

  const ingestEndpoint = parseDsn(options.dsn).endpoint;
  safely(() => installErrorCapture(sdk));
  safely(() => installClickBreadcrumbs(sdk));
  safely(() => installNavigationBreadcrumbs(sdk));
  safely(() => installFetchBreadcrumbs(sdk, ingestEndpoint));
  safely(() => installPageLifecycleFlush(sdk));
}

/**
 * Cattura manuale di un errore. url e userAgent correnti vengono allegati
 * di default. No-op (con un solo avviso) se init() non è stato chiamato.
 */
export function captureError(error: unknown, extra?: { url?: string; userAgent?: string }): void {
  safely(() => {
    activeClient()?.captureError(error, {
      url: extra?.url ?? location.href,
      userAgent: extra?.userAgent ?? navigator.userAgent,
    });
  });
}

export function captureFeedback(input: {
  message: string;
  email?: string;
  url?: string;
  screenshot?: boolean;
}): void {
  safely(() => activeClient()?.captureFeedback(input));
}

export function createTicket(input: {
  title: string;
  body?: string;
  type: TicketType;
  priority?: TicketPriority;
}): void {
  safely(() => activeClient()?.createTicket(input));
}

export function addBreadcrumb(
  breadcrumb: Omit<Breadcrumb, "timestamp"> & { timestamp?: string },
): void {
  safely(() => activeClient()?.addBreadcrumb(breadcrumb));
}

/** Invia subito tutto ciò che è in coda. Si risolve sempre, non rigetta mai. */
export function flush(): Promise<void> {
  return activeClient()?.flush() ?? Promise.resolve();
}

/**
 * Solo per i test: disinstalla tutta la strumentazione (listener, wrap di
 * fetch e history) e azzera lo stato del singleton. Mai usarla in produzione.
 */
export function __resetForTesting(): void {
  for (const teardown of teardowns) {
    try {
      teardown();
    } catch {
      // best effort
    }
  }
  teardowns = [];
  client = null;
  warnedBeforeInit = false;
}
