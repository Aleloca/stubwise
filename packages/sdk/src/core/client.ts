import type { Breadcrumb, TicketPriority, TicketType } from "@stubwise/shared";
import { BreadcrumbBuffer } from "./breadcrumbs.js";
import { Transport } from "./transport.js";

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

  captureFeedback(input: { message: string; email?: string; url?: string }): void {
    try {
      if (!input.message) {
        warnEmptyInput("message del feedback");
        return;
      }
      this.transport.enqueue({
        kind: "feedback",
        message: input.message,
        email: input.email,
        url: input.url,
        release: this.release,
      });
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
  flush(): Promise<void> {
    return this.transport.flush();
  }
}
