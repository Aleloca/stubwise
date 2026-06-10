import { afterEach, describe, expect, it, vi } from "vitest";
import type { ErrorEvent as StubwiseErrorEvent, IngestEvent } from "@stubwise/shared";
import {
  __resetForTesting,
  addBreadcrumb,
  captureError,
  captureFeedback,
  createTicket,
  expressErrorHandler,
  fastifyErrorHandler,
  flush,
  init,
} from "./node.js";

const DSN = "https://test-key@track.example.com/p/my-app";

type FetchMock = ReturnType<typeof vi.fn<typeof fetch>>;

function okFetch(): FetchMock {
  return vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 202 }));
}

/** Tutti gli eventi consegnati al transport, su tutte le chiamate fetch. */
function deliveredEvents(fetchMock: FetchMock): IngestEvent[] {
  return fetchMock.mock.calls.flatMap(
    (call) => (JSON.parse(call[1]?.body as string) as { events: IngestEvent[] }).events,
  );
}

function deliveredErrors(fetchMock: FetchMock): StubwiseErrorEvent[] {
  return deliveredEvents(fetchMock).filter((e): e is StubwiseErrorEvent => e.kind === "error");
}

type AsyncErrorHandler = (error: unknown) => Promise<void>;

/** L'ultimo listener registrato su un evento di processo (cioè il nostro). */
function lastListener(event: "uncaughtException" | "unhandledRejection"): AsyncErrorHandler {
  // ramificato perché gli overload tipizzati di process.listeners non
  // accettano l'unione dei due nomi di evento
  const listeners =
    event === "uncaughtException"
      ? process.listeners("uncaughtException")
      : process.listeners("unhandledRejection");
  const listener = listeners.at(-1);
  if (!listener) throw new Error(`nessun listener registrato su ${event}`);
  return listener as unknown as AsyncErrorHandler;
}

/** Spia su process.exit che non termina davvero il processo di test. */
function spyExit() {
  return vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
}

/**
 * Esegue `run` senza NESSUN altro listener su uncaughtException (vitest ne
 * registra di suoi): è l'unico modo di osservare il ramo "siamo i soli →
 * exit(1)". I listener originali vengono sempre ripristinati.
 */
async function withBareUncaughtException(run: () => Promise<void>): Promise<void> {
  const saved = process.listeners("uncaughtException");
  process.removeAllListeners("uncaughtException");
  try {
    await run();
  } finally {
    process.removeAllListeners("uncaughtException");
    for (const listener of saved) process.on("uncaughtException", listener);
  }
}

/** Come sopra, ma per unhandledRejection (anche qui vitest ne registra di suoi). */
async function withBareUnhandledRejection(run: () => Promise<void>): Promise<void> {
  const saved = process.listeners("unhandledRejection");
  process.removeAllListeners("unhandledRejection");
  try {
    await run();
  } finally {
    process.removeAllListeners("unhandledRejection");
    for (const listener of saved) process.on("unhandledRejection", listener);
  }
}

afterEach(() => {
  __resetForTesting();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("init — handler di processo", () => {
  it("registra un listener su uncaughtException e uno su unhandledRejection", () => {
    const beforeUncaught = process.listenerCount("uncaughtException");
    const beforeRejection = process.listenerCount("unhandledRejection");

    init({ dsn: DSN, fetchImpl: okFetch() });

    expect(process.listenerCount("uncaughtException")).toBe(beforeUncaught + 1);
    expect(process.listenerCount("unhandledRejection")).toBe(beforeRejection + 1);
  });

  it("registerProcessHandlers: false non registra nulla", () => {
    const beforeUncaught = process.listenerCount("uncaughtException");
    const beforeRejection = process.listenerCount("unhandledRejection");

    init({ dsn: DSN, fetchImpl: okFetch(), registerProcessHandlers: false });

    expect(process.listenerCount("uncaughtException")).toBe(beforeUncaught);
    expect(process.listenerCount("unhandledRejection")).toBe(beforeRejection);
  });

  it("init chiamato due volte avvisa e non duplica i listener", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const before = process.listenerCount("uncaughtException");

    init({ dsn: DSN, fetchImpl: okFetch() });
    init({ dsn: DSN, fetchImpl: okFetch() });

    expect(warn).toHaveBeenCalledWith(expect.stringContaining("init"));
    expect(process.listenerCount("uncaughtException")).toBe(before + 1);
  });

  it("__resetForTesting rimuove i listener di processo", () => {
    const beforeUncaught = process.listenerCount("uncaughtException");
    const beforeRejection = process.listenerCount("unhandledRejection");

    init({ dsn: DSN, fetchImpl: okFetch() });
    __resetForTesting();

    expect(process.listenerCount("uncaughtException")).toBe(beforeUncaught);
    expect(process.listenerCount("unhandledRejection")).toBe(beforeRejection);
  });
});

describe("handler uncaughtException", () => {
  it("cattura, flusha e poi esce con codice 1 quando è l'unico listener", async () => {
    await withBareUncaughtException(async () => {
      vi.spyOn(console, "error").mockImplementation(() => undefined);
      const exit = spyExit();
      const fetchMock = okFetch();
      init({ dsn: DSN, release: "1.2.3", environment: "production", fetchImpl: fetchMock });

      const handler = lastListener("uncaughtException");
      await handler(new TypeError("x is undefined"));

      const [event] = deliveredErrors(fetchMock);
      expect(event).toMatchObject({
        kind: "error",
        message: "x is undefined",
        errorType: "TypeError",
        release: "1.2.3",
        environment: "production",
      });
      expect(event?.stack).toContain("TypeError");

      expect(exit).toHaveBeenCalledWith(1);
      // il flush (fetch) deve precedere l'uscita: prima si spedisce, poi si muore
      expect(exit.mock.invocationCallOrder[0]).toBeGreaterThan(
        fetchMock.mock.invocationCallOrder[0]!,
      );
    });
  });

  it("non esce se l'app ospite ha un proprio listener: il crash behavior è suo", async () => {
    const exit = spyExit();
    const fetchMock = okFetch();
    init({ dsn: DSN, fetchImpl: fetchMock });

    // vitest registra già i suoi listener su uncaughtException, quindi il
    // nostro handler NON è l'unico: deve catturare ma lasciare a loro l'esito
    const handler = lastListener("uncaughtException");
    await handler(new Error("gestito altrove"));

    expect(deliveredErrors(fetchMock).map((e) => e.message)).toEqual(["gestito altrove"]);
    expect(exit).not.toHaveBeenCalled();
  });

  it("un flush che non risponde non blocca la morte del processo oltre il timeout", async () => {
    await withBareUncaughtException(async () => {
      vi.useFakeTimers();
      vi.spyOn(console, "error").mockImplementation(() => undefined);
      const exit = spyExit();
      // fetch che non risolve mai: il flush resterebbe appeso per sempre
      const hangingFetch = vi.fn<typeof fetch>().mockReturnValue(new Promise<Response>(() => {}));
      init({ dsn: DSN, fetchImpl: hangingFetch });

      const handler = lastListener("uncaughtException");
      const pending = handler(new Error("flush appeso"));
      await vi.advanceTimersByTimeAsync(2000);
      await pending;

      expect(exit).toHaveBeenCalledWith(1);
    });
  });
});

describe("handler unhandledRejection", () => {
  it("cattura il reason ma non termina mai il processo", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const exit = spyExit();
    const fetchMock = okFetch();
    init({ dsn: DSN, fetchImpl: fetchMock });

    const handler = lastListener("unhandledRejection");
    await handler(new RangeError("fuori scala"));

    const [event] = deliveredErrors(fetchMock);
    expect(event).toMatchObject({ kind: "error", message: "fuori scala", errorType: "RangeError" });
    expect(exit).not.toHaveBeenCalled();
  });

  it("un reason non-Error viene normalizzato dal core", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const fetchMock = okFetch();
    init({ dsn: DSN, fetchImpl: fetchMock });

    const handler = lastListener("unhandledRejection");
    await handler("stringa di errore");

    expect(deliveredErrors(fetchMock).map((e) => e.message)).toEqual(["stringa di errore"]);
  });

  it("stampa il reason su stderr quando è l'unico listener", async () => {
    await withBareUnhandledRejection(async () => {
      const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
      init({ dsn: DSN, fetchImpl: okFetch() });

      const handler = lastListener("unhandledRejection");
      await handler(new Error("invisibile altrimenti"));

      expect(consoleError).toHaveBeenCalledWith(
        expect.stringContaining("unhandledRejection"),
        expect.objectContaining({ message: "invisibile altrimenti" }),
      );
    });
  });

  it("non stampa il reason se l'host ha i propri listener: la visibilità è sua", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const fetchMock = okFetch();
    init({ dsn: DSN, fetchImpl: fetchMock });

    // listener dell'app ospite: il nostro handler NON è l'unico, quindi
    // cattura sì, log su stderr no
    const handler = lastListener("unhandledRejection");
    const hostListener = (): void => undefined;
    process.on("unhandledRejection", hostListener);
    try {
      await handler(new Error("loggato dall'host"));
    } finally {
      process.removeListener("unhandledRejection", hostListener);
    }

    expect(deliveredErrors(fetchMock).map((e) => e.message)).toEqual(["loggato dall'host"]);
    expect(consoleError).not.toHaveBeenCalled();
  });
});

describe("expressErrorHandler", () => {
  it("cattura l'errore con l'url della richiesta e propaga con next(err)", async () => {
    const fetchMock = okFetch();
    init({ dsn: DSN, fetchImpl: fetchMock });

    const middleware = expressErrorHandler();
    const error = new Error("esplosione nel controller");
    const next = vi.fn();
    middleware(error, { originalUrl: "/checkout?step=2", url: "/checkout" }, {}, next);
    await flush();

    expect(next).toHaveBeenCalledWith(error);
    const [event] = deliveredErrors(fetchMock);
    expect(event).toMatchObject({ message: "esplosione nel controller", url: "/checkout?step=2" });
  });

  it("senza originalUrl ripiega su req.url; senza init propaga comunque", () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const middleware = expressErrorHandler();
    const error = new Error("prima di init");
    const next = vi.fn();

    expect(() => middleware(error, { url: "/solo-url" }, {}, next)).not.toThrow();
    expect(next).toHaveBeenCalledWith(error);
  });
});

describe("fastifyErrorHandler", () => {
  it("cattura l'errore con request.url e lo rilancia per il default handler di Fastify", async () => {
    const fetchMock = okFetch();
    init({ dsn: DSN, fetchImpl: fetchMock });

    const handler = fastifyErrorHandler();
    const error = new Error("esplosione nella route");

    expect(() => handler(error, { url: "/api/items" }, {})).toThrow(error);
    await flush();

    const [event] = deliveredErrors(fetchMock);
    expect(event).toMatchObject({ message: "esplosione nella route", url: "/api/items" });
  });

  it("senza init rilancia comunque l'errore (la cattura è best effort)", () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const handler = fastifyErrorHandler();
    const error = new Error("prima di init");

    expect(() => handler(error, { url: "/x" }, {})).toThrow(error);
  });
});

describe("API manuale dopo init", () => {
  it("captureError, captureFeedback e createTicket arrivano al transport", async () => {
    const fetchMock = okFetch();
    init({ dsn: DSN, fetchImpl: fetchMock });

    captureError(new Error("manuale"), { url: "https://api.example.com/job" });
    captureFeedback({ message: "non funziona", email: "user@example.com" });
    createTicket({ title: "Export CSV", type: "feature", priority: "high" });
    await flush();

    const events = deliveredEvents(fetchMock);
    expect(events).toHaveLength(3);
    expect(events[0]).toMatchObject({
      kind: "error",
      message: "manuale",
      url: "https://api.example.com/job",
    });
    expect(events[1]).toMatchObject({ kind: "feedback", message: "non funziona" });
    expect(events[2]).toMatchObject({
      kind: "ticket",
      title: "Export CSV",
      type: "feature",
      priority: "high",
    });
  });

  it("addBreadcrumb manuale finisce nei breadcrumbs degli errori", async () => {
    const fetchMock = okFetch();
    init({ dsn: DSN, fetchImpl: fetchMock });

    addBreadcrumb({ type: "log", message: "passo importante" });
    captureError(new Error("sonda"));
    await flush();

    const [event] = deliveredErrors(fetchMock);
    expect(event?.breadcrumbs.filter((c) => c.type === "log").map((c) => c.message)).toEqual([
      "passo importante",
    ]);
  });
});

describe("API senza init", () => {
  it("le funzioni sono no-op e avvisano una sola volta", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    expect(() => captureError(new Error("x"))).not.toThrow();
    expect(() => captureFeedback({ message: "x" })).not.toThrow();
    expect(() => createTicket({ title: "x", type: "bug" })).not.toThrow();
    expect(() => addBreadcrumb({ type: "log", message: "x" })).not.toThrow();
    await expect(flush()).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("init"));
  });
});
