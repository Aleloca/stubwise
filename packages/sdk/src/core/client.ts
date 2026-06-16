import type { Breadcrumb, TicketPriority, TicketType } from "@stubwise/shared";
import { BreadcrumbBuffer } from "./breadcrumbs.js";
import { Transport, type FlushOptions } from "./transport.js";

export interface ClientOptions {
  /** DSN nel formato `https://KEY@host/p/slug`. */
  dsn: string;
  release?: string;
  environment?: string;
  flushIntervalMs?: number;
  /** Implementazione di fetch iniettabile (test, ambienti custom). */
  fetchImpl?: typeof fetch;
}

interface NormalizedError {
  message: string;
  errorType?: string;
  stack?: string;
}

const FALLBACK_MESSAGE = "Errore sconosciuto";

/**
 * Avvisa che un input vuoto è stato scartato. Gli input vuoti violerebbero
 * i vincoli min(1) del server: un 422 farebbe scartare l'intero batch,
 * quindi è meglio non accodarli affatto. Warn con la stessa guardia del
 * Transport: nemmeno un console.warn rotto deve propagare nell'app ospite.
 */
function warnEmptyInput(what: string): void {
  try {
    console.warn(`[stubwise] ${what} vuoto: chiamata ignorata`);
  } catch {
    // mai propagare nell'app ospite
  }
}

/**
 * Cattura uno screenshot della pagina come dataURL JPEG (qualità 0.7 per
 * contenere la dimensione del payload). html2canvas è caricato SOLO via import
 * dinamico, così non entra nel bundle base di chi non usa lo screenshot. Lancia
 * se non siamo in un browser (niente `document`), se html2canvas non è
 * installato o se la cattura fallisce: il chiamante tratta ogni errore come
 * "nessuno screenshot" e accoda comunque il feedback.
 */
type Html2Canvas = (element: HTMLElement) => Promise<HTMLCanvasElement>;

async function captureScreenshot(): Promise<string> {
  if (typeof document === "undefined" || !document.body) {
    throw new Error("captureScreenshot richiede un ambiente browser");
  }
  // html2canvas è un modulo CJS senza "exports": sotto NodeNext il default
  // sintetizzato può finire annidato (mod.default) o essere il modulo stesso.
  // Si risolve in modo difensivo a runtime; il chiamante tratta ogni anomalia
  // come "nessuno screenshot".
  const mod = (await import("html2canvas")) as unknown as {
    default?: Html2Canvas | { default?: Html2Canvas };
  } & Partial<{ default: Html2Canvas }>;
  const candidate = mod.default ?? (mod as unknown as Html2Canvas);
  const html2canvas: Html2Canvas =
    typeof candidate === "function"
      ? candidate
      : ((candidate as { default?: Html2Canvas }).default as Html2Canvas);
  if (typeof html2canvas !== "function") {
    throw new Error("html2canvas non disponibile");
  }
  const canvas = await html2canvas(document.body);
  return canvas.toDataURL("image/jpeg", 0.7);
}

/** Riduce un valore arbitrario (Error, stringa, oggetto, circolare...) a un messaggio sicuro. */
function normalizeError(value: unknown): NormalizedError {
  if (value instanceof Error) {
    return {
      message: value.message || value.name || FALLBACK_MESSAGE,
      errorType: value.name || undefined,
      stack: value.stack,
    };
  }
  if (typeof value === "string") {
    return { message: value || FALLBACK_MESSAGE };
  }
  try {
    const json = JSON.stringify(value);
    if (typeof json === "string" && json.length > 0) return { message: json };
  } catch {
    // valore non serializzabile (es. struttura circolare): si ripiega su String()
  }
  try {
    return { message: String(value) || FALLBACK_MESSAGE };
  } catch {
    return { message: FALLBACK_MESSAGE };
  }
}

/**
 * Client di alto livello dell'SDK. Stessa garanzia del Transport: a parte
 * il costruttore (DSN malformato = errore di configurazione, deve essere
 * rumoroso), nessun metodo lancia mai nell'app ospite.
 */
export class Client {
  private readonly transport: Transport;
  private readonly breadcrumbs = new BreadcrumbBuffer();
  private readonly release?: string;
  private readonly environment?: string;

  constructor(options: ClientOptions) {
    this.transport = new Transport({
      dsn: options.dsn,
      flushIntervalMs: options.flushIntervalMs,
      fetchImpl: options.fetchImpl,
    });
    this.release = options.release;
    this.environment = options.environment;
  }

  /** Cattura un errore qualsiasi, allegando lo snapshot corrente dei breadcrumb. */
  captureError(error: unknown, extra?: { url?: string; userAgent?: string }): void {
    try {
      const normalized = normalizeError(error);
      this.transport.enqueue({
        kind: "error",
        message: normalized.message,
        errorType: normalized.errorType,
        stack: normalized.stack,
        url: extra?.url,
        userAgent: extra?.userAgent,
        release: this.release,
        environment: this.environment,
        breadcrumbs: this.breadcrumbs.snapshot(),
        timestamp: new Date().toISOString(),
      });
    } catch {
      // mai propagare nell'app ospite
    }
  }

  /**
   * Cattura un feedback utente. Con `screenshot: true` allega uno screenshot
   * della pagina catturato con html2canvas (import dinamico, lazy: non entra nel
   * bundle base di chi non lo usa). La cattura è asincrona ma la firma resta
   * `void` (fire-and-forget): senza screenshot l'enqueue è sincrono e identico a
   * prima; con screenshot l'enqueue avviene dentro un'IIFE async. Qualunque
   * fallimento della cattura (html2canvas assente, errore, niente DOM) accoda
   * comunque il feedback SENZA screenshot e non propaga mai nell'app ospite.
   */
  captureFeedback(input: { message: string; email?: string; url?: string; screenshot?: boolean }): void {
    try {
      if (!input.message) {
        warnEmptyInput("message del feedback");
        return;
      }
      if (input.screenshot === true) {
        // async: non possiamo bloccare la firma void, quindi accodiamo
        // l'evento (con o senza screenshot) dentro un'IIFE che non rigetta mai.
        void this.enqueueFeedbackWithScreenshot(input);
        return;
      }
      this.enqueueFeedback(input);
    } catch {
      // mai propagare nell'app ospite
    }
  }

  private enqueueFeedback(
    input: { message: string; email?: string; url?: string },
    screenshot?: string,
  ): void {
    this.transport.enqueue({
      kind: "feedback",
      message: input.message,
      email: input.email,
      url: input.url,
      release: this.release,
      ...(screenshot !== undefined ? { screenshot } : {}),
    });
  }

  /**
   * Cattura lo screenshot e accoda il feedback. Tutto best-effort: se la
   * cattura fallisce per qualsiasi motivo si accoda il feedback senza
   * screenshot. Non rigetta mai (la chiamano con `void`).
   */
  private async enqueueFeedbackWithScreenshot(input: {
    message: string;
    email?: string;
    url?: string;
  }): Promise<void> {
    let screenshot: string | undefined;
    try {
      screenshot = await captureScreenshot();
    } catch {
      // html2canvas assente, errore di rendering o niente DOM: si prosegue
      // senza screenshot. Mai propagare nell'app ospite.
      screenshot = undefined;
    }
    try {
      this.enqueueFeedback(input, screenshot);
    } catch {
      // mai propagare nell'app ospite
    }
  }

  createTicket(input: {
    title: string;
    body?: string;
    type: TicketType;
    priority?: TicketPriority;
  }): void {
    try {
      if (!input.title) {
        warnEmptyInput("title del ticket");
        return;
      }
      this.transport.enqueue({
        kind: "ticket",
        title: input.title,
        body: input.body,
        type: input.type,
        priority: input.priority ?? "medium",
      });
    } catch {
      // mai propagare nell'app ospite
    }
  }

  /** Aggiunge un breadcrumb al ring buffer (timestamp di default: adesso). */
  addBreadcrumb(breadcrumb: Omit<Breadcrumb, "timestamp"> & { timestamp?: string }): void {
    try {
      if (!breadcrumb.message) {
        warnEmptyInput("message del breadcrumb");
        return;
      }
      this.breadcrumbs.add({
        ...breadcrumb,
        timestamp: breadcrumb.timestamp ?? new Date().toISOString(),
      });
    } catch {
      // mai propagare nell'app ospite
    }
  }

  /** Invia subito tutto ciò che è in coda. Si risolve sempre, non rigetta mai. */
  flush(options?: FlushOptions): Promise<void> {
    return this.transport.flush(options);
  }
}
