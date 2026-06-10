// Entry point Node: singleton di modulo con cattura dei crash di processo
// (uncaughtException/unhandledRejection) e middleware d'errore per Express e
// Fastify. DX: `import { init, errorHandler } from "@stubwise/sdk/node"`.
//
// Invariante ereditato dal core: a parte init() con un DSN malformato
// (errore di configurazione, deve fallire forte), niente di ciò che viene
// installato qui può mai lanciare nell'app ospite — con un'eccezione voluta:
// i middleware d'errore PROPAGANO sempre l'errore originale dell'app
// (next(err) / rethrow), perché quello appartiene all'host, non all'SDK.
import type { Breadcrumb, TicketPriority, TicketType } from "@stubwise/shared";
import { Client, type ClientOptions } from "./core/client.js";

export { BreadcrumbBuffer } from "./core/breadcrumbs.js";
export { Client, type ClientOptions } from "./core/client.js";
export {
  parseDsn,
  Transport,
  type FlushOptions,
  type ParsedDsn,
  type TransportOptions,
} from "./core/transport.js";

export interface NodeOptions extends ClientOptions {
  /**
   * Registra i listener su `uncaughtException` e `unhandledRejection`.
   * Default true. Da disattivare se l'host vuole il pieno controllo del
   * ciclo di vita del processo (es. dentro una test suite).
   */
  registerProcessHandlers?: boolean;
}

/**
 * Tempo massimo concesso al flush durante la morte del processo: meglio
 * perdere un batch che tenere in vita per sempre un processo che deve
 * morire (es. server di ingestion irraggiungibile).
 */
const CRASH_FLUSH_TIMEOUT_MS = 2000;

let client: Client | null = null;
/** Avviso "init non chiamato" emesso una sola volta. */
let warnedBeforeInit = false;
/** Disinstallatori dei listener di processo correnti (solo per i test). */
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

/** flush() con un tetto massimo: si risolve comunque allo scadere del timeout. */
function flushWithTimeout(sdk: Client): Promise<void> {
  return Promise.race([
    sdk.flush(),
    new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, CRASH_FLUSH_TIMEOUT_MS);
      // il timer di sicurezza non deve tenere vivo il processo
      const maybeUnref = timer as unknown as { unref?: () => void };
      if (typeof maybeUnref.unref === "function") maybeUnref.unref();
    }),
  ]);
}

/**
 * Cattura dei crash di processo.
 *
 * uncaughtException: registrare un listener DISABILITA il comportamento di
 * default di Node (stampa dello stack + uscita con codice 1). Per
 * preservarlo: si cattura, si flusha (best effort, max
 * {@link CRASH_FLUSH_TIMEOUT_MS}) e poi — se il nostro listener è l'UNICO —
 * si stampa l'errore e si esce con `process.exit(1)`, esattamente come
 * avrebbe fatto Node. Se l'app ospite ha un proprio listener, l'esito del
 * processo è una sua decisione: noi catturiamo e basta. (Rilanciare
 * l'errore qui sarebbe sbagliato: produrrebbe una nuova uncaughtException
 * in loop.)
 *
 * unhandledRejection: si cattura e si flusha senza mai terminare il
 * processo. Nota dichiarata: da Node 15 il default senza listener è
 * lanciare il reason come uncaughtException; il nostro listener trasforma
 * quel default in "logga e continua" (lo stesso compromesso degli SDK di
 * error tracking più diffusi). Il reason viene stampato su stderr per non
 * perdere visibilità.
 */
function installProcessHandlers(sdk: Client): void {
  const onUncaughtException = async (error: Error): Promise<void> => {
    safely(() => sdk.captureError(error));
    try {
      await flushWithTimeout(sdk);
    } catch {
      // flush non rigetta mai, ma il percorso di crash dev'essere blindato
    }
    // Gli altri listener sono già stati invocati in modo sincrono da Node
    // prima di questo await: se esistono, il crash behavior è affar loro.
    const others = process
      .listeners("uncaughtException")
      .filter((listener) => listener !== onUncaughtException);
    if (others.length === 0) {
      try {
        console.error(error);
      } catch {
        // anche un console.error rotto non deve impedire l'uscita
      }
      process.exit(1);
    }
  };

  const onUnhandledRejection = async (reason: unknown): Promise<void> => {
    safely(() => sdk.captureError(reason));
    try {
      console.error("[stubwise] unhandledRejection catturata:", reason);
    } catch {
      // mai propagare nell'app ospite
    }
    try {
      await flushWithTimeout(sdk);
    } catch {
      // flush non rigetta mai; guardia difensiva
    }
  };

  process.on("uncaughtException", onUncaughtException);
  process.on("unhandledRejection", onUnhandledRejection);
  teardowns.push(() => {
    process.removeListener("uncaughtException", onUncaughtException);
    process.removeListener("unhandledRejection", onUnhandledRejection);
  });
}

/**
 * Inizializza l'SDK Node: crea il client singleton e (di default) registra
 * i listener di processo. Lancia solo per DSN malformato (errore di
 * configurazione). Una seconda chiamata avvisa e non fa nulla: i listener
 * non vengono mai duplicati.
 */
export function init(options: NodeOptions): void {
  if (client) {
    warn("init() già chiamato: la seconda chiamata viene ignorata");
    return;
  }

  const sdk = new Client(options);
  client = sdk;

  if (options.registerProcessHandlers !== false) {
    safely(() => installProcessHandlers(sdk));
  }
}

/** Richiesta minima da cui estrarre l'URL: copre Express e Fastify. */
interface RequestLike {
  /** Express: path originale prima di eventuali rewrite dei router. */
  originalUrl?: string;
  /** Fastify (e fallback Express). */
  url?: string;
}

function requestUrl(request: RequestLike | undefined): string | undefined {
  if (!request) return undefined;
  if (typeof request.originalUrl === "string" && request.originalUrl) return request.originalUrl;
  if (typeof request.url === "string" && request.url) return request.url;
  return undefined;
}

/**
 * Error middleware per Express (firma a 4 argomenti, obbligatoria perché
 * Express lo riconosca come error handler): cattura l'errore e lo propaga
 * con `next(err)`, così la catena di gestione dell'app resta intatta.
 *
 * Uso: `app.use(expressErrorHandler())` PRIMA dei propri error handler.
 */
export function expressErrorHandler(): (
  error: unknown,
  request: RequestLike,
  response: unknown,
  next: (error?: unknown) => void,
) => void {
  return (error, request, _response, next) => {
    safely(() => activeClient()?.captureError(error, { url: requestUrl(request) }));
    next(error);
  };
}

/**
 * Error handler per Fastify (`app.setErrorHandler(fastifyErrorHandler())`):
 * cattura l'errore e lo RILANCIA, così Fastify ripiega sul proprio default
 * error handler e la risposta HTTP resta quella di sempre.
 */
export function fastifyErrorHandler(): (
  error: unknown,
  request: RequestLike,
  reply: unknown,
) => never {
  // la firma esposta ha 3 parametri (quella di setErrorHandler); reply non
  // serve perché l'errore viene rilanciato al default handler di Fastify
  return (error, request) => {
    safely(() => activeClient()?.captureError(error, { url: requestUrl(request) }));
    throw error;
  };
}

/**
 * Cattura manuale di un errore. A differenza del browser non c'è un url o
 * uno user agent "corrente": extra è interamente a carico del chiamante.
 * No-op (con un solo avviso) se init() non è stato chiamato.
 */
export function captureError(error: unknown, extra?: { url?: string; userAgent?: string }): void {
  safely(() => activeClient()?.captureError(error, extra));
}

export function captureFeedback(input: { message: string; email?: string; url?: string }): void {
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
 * Solo per i test: rimuove i listener di processo e azzera lo stato del
 * singleton. Mai usarla in produzione.
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
