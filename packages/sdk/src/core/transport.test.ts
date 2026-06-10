import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ErrorEvent, IngestEvent } from "@stubwise/shared";
import { parseDsn, Transport } from "./transport.js";

const DSN = "https://test-key@track.example.com/p/my-app";
const FLUSH_MS = 3000;

function errorEvent(message: string): IngestEvent {
  return {
    kind: "error",
    message,
    breadcrumbs: [],
    timestamp: "2026-06-10T12:00:00.000Z",
  };
}

function okResponse(): Response {
  return new Response(null, { status: 202 });
}

function failResponse(status: number): Response {
  return new Response(null, { status });
}

type FetchMock = ReturnType<typeof vi.fn<typeof fetch>>;

// in questi test si accodano solo ErrorEvent: il cast restringe l'union
function sentEvents(fetchMock: FetchMock, callIndex = 0): ErrorEvent[] {
  const init = fetchMock.mock.calls[callIndex]?.[1];
  return (JSON.parse(init?.body as string) as { events: ErrorEvent[] }).events;
}

function makeTransport(fetchMock: FetchMock, overrides: Record<string, unknown> = {}) {
  return new Transport({ dsn: DSN, flushIntervalMs: FLUSH_MS, fetchImpl: fetchMock, ...overrides });
}

describe("parseDsn", () => {
  it("estrae endpoint e chiave da un DSN valido", () => {
    expect(parseDsn("https://abc123@track.example.com/p/my-app")).toEqual({
      endpoint: "https://track.example.com/ingest/my-app",
      key: "abc123",
    });
  });

  it("preserva la porta", () => {
    expect(parseDsn("https://k@track.example.com:8443/p/slug")).toEqual({
      endpoint: "https://track.example.com:8443/ingest/slug",
      key: "k",
    });
  });

  it("preserva un eventuale prefisso di path prima di /p/", () => {
    expect(parseDsn("https://k@example.com/stubwise/p/slug")).toEqual({
      endpoint: "https://example.com/stubwise/ingest/slug",
      key: "k",
    });
  });

  it("lancia su DSN malformato", () => {
    expect(() => parseDsn("not-a-url")).toThrow();
    expect(() => parseDsn("https://track.example.com/p/my-app")).toThrow(); // chiave mancante
    expect(() => parseDsn("https://k@track.example.com/my-app")).toThrow(); // manca /p/
    expect(() => parseDsn("ftp://k@track.example.com/p/my-app")).toThrow(); // protocollo non http(s)
  });
});

describe("Transport", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("accumula eventi e li invia in un singolo batch dopo flushInterval", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(okResponse());
    const transport = makeTransport(fetchMock);

    transport.enqueue(errorEvent("uno"));
    transport.enqueue(errorEvent("due"));
    transport.enqueue(errorEvent("tre"));
    expect(fetchMock).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(FLUSH_MS);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://track.example.com/ingest/my-app");
    expect(init?.method).toBe("POST");
    expect(init?.headers).toMatchObject({
      "content-type": "application/json",
      "X-Stubwise-Key": "test-key",
    });
    expect(sentEvents(fetchMock).map((e) => e.message)).toEqual(["uno", "due", "tre"]);
  });

  it("flush() manuale invia subito senza aspettare il timer", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(okResponse());
    const transport = makeTransport(fetchMock);

    transport.enqueue(errorEvent("subito"));
    await transport.flush();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sentEvents(fetchMock).map((e) => e.message)).toEqual(["subito"]);

    // il timer schedulato dall'enqueue non deve produrre un secondo invio
    await vi.advanceTimersByTimeAsync(FLUSH_MS * 10);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("su 5xx ritenta con backoff esponenziale, max 3 tentativi, poi scarta", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async () => failResponse(500));
    const transport = makeTransport(fetchMock);

    transport.enqueue(errorEvent("boom"));

    // tentativo 1 a t = 3000
    await vi.advanceTimersByTimeAsync(FLUSH_MS);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // backoff: il retry è a +2^1*3000 = 6000, non prima
    await vi.advanceTimersByTimeAsync(FLUSH_MS);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(FLUSH_MS);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // retry successivo a +2^2*3000 = 12000
    await vi.advanceTimersByTimeAsync(4 * FLUSH_MS);
    expect(fetchMock).toHaveBeenCalledTimes(3);

    // dopo il terzo fallimento il batch è scartato: niente altri invii
    await vi.advanceTimersByTimeAsync(100 * FLUSH_MS);
    expect(fetchMock).toHaveBeenCalledTimes(3);

    // l'evento viene ritrasmesso identico a ogni tentativo
    expect(sentEvents(fetchMock, 2).map((e) => e.message)).toEqual(["boom"]);
  });

  it("su errore di rete ritenta e poi riparte pulito dopo lo scarto", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockRejectedValue(new TypeError("network down"));
    const transport = makeTransport(fetchMock);

    transport.enqueue(errorEvent("offline"));
    await vi.advanceTimersByTimeAsync(FLUSH_MS); // tentativo 1
    await vi.advanceTimersByTimeAsync(2 * FLUSH_MS); // tentativo 2
    await vi.advanceTimersByTimeAsync(4 * FLUSH_MS); // tentativo 3 → scarto
    expect(fetchMock).toHaveBeenCalledTimes(3);

    // dopo lo scarto i contatori sono azzerati: un nuovo evento parte al primo intervallo
    fetchMock.mockResolvedValue(okResponse());
    transport.enqueue(errorEvent("di nuovo online"));
    await vi.advanceTimersByTimeAsync(FLUSH_MS);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(sentEvents(fetchMock, 3).map((e) => e.message)).toEqual(["di nuovo online"]);
  });

  it("su 429 ritenta come per i 5xx", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(failResponse(429))
      .mockResolvedValue(okResponse());
    const transport = makeTransport(fetchMock);

    transport.enqueue(errorEvent("rate limited"));
    await vi.advanceTimersByTimeAsync(FLUSH_MS);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2 * FLUSH_MS);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sentEvents(fetchMock, 1).map((e) => e.message)).toEqual(["rate limited"]);
  });

  it("su 4xx scarta subito senza retry e logga console.warn una sola volta", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(failResponse(401));
    const transport = makeTransport(fetchMock);

    transport.enqueue(errorEvent("uno"));
    transport.enqueue(errorEvent("due"));
    transport.enqueue(errorEvent("tre"));
    await vi.advanceTimersByTimeAsync(FLUSH_MS);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);

    // nessun retry del batch scartato
    await vi.advanceTimersByTimeAsync(100 * FLUSH_MS);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("la coda è cap a 100 eventi: i più vecchi vengono scartati e il batch parte in una singola POST", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(okResponse());
    const transport = makeTransport(fetchMock);

    for (let i = 0; i < 105; i++) {
      transport.enqueue(errorEvent(`evt-${i}`));
    }
    await vi.advanceTimersByTimeAsync(FLUSH_MS);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const events = sentEvents(fetchMock);
    expect(events).toHaveLength(100);
    expect(events[0]?.message).toBe("evt-5"); // i primi 5 sono stati scartati
    expect(events[99]?.message).toBe("evt-104");
  });

  it("non propaga mai eccezioni, nemmeno se fetchImpl lancia in modo sincrono", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(() => {
      throw new Error("sync boom");
    });
    const transport = makeTransport(fetchMock);

    expect(() => transport.enqueue(errorEvent("x"))).not.toThrow();
    await expect(transport.flush()).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // anche il flush schedulato dal retry non deve far esplodere nulla
    await expect(
      vi.advanceTimersByTimeAsync(100 * FLUSH_MS).then(() => "ok"),
    ).resolves.toBe("ok");
  });

  it("flush() su coda vuota non chiama fetch e si risolve", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(okResponse());
    const transport = makeTransport(fetchMock);

    await expect(transport.flush()).resolves.toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
