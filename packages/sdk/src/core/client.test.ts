import { afterEach, describe, expect, it, vi } from "vitest";
import type { ErrorEvent, FeedbackEvent, IngestEvent, TicketCreateEvent } from "@stubwise/shared";
import { BreadcrumbBuffer } from "./breadcrumbs.js";
import { Client } from "./client.js";

const DSN = "https://test-key@track.example.com/p/my-app";

type FetchMock = ReturnType<typeof vi.fn<typeof fetch>>;

function okFetch(): FetchMock {
  return vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 202 }));
}

function sentEvents(fetchMock: FetchMock, callIndex = 0): IngestEvent[] {
  const init = fetchMock.mock.calls[callIndex]?.[1];
  return (JSON.parse(init?.body as string) as { events: IngestEvent[] }).events;
}

describe("BreadcrumbBuffer", () => {
  it("è un ring buffer: il 31° elemento scarta il 1°", () => {
    const buffer = new BreadcrumbBuffer();
    for (let i = 0; i < 31; i++) {
      buffer.add({ type: "log", message: `crumb-${i}`, timestamp: "2026-06-10T12:00:00.000Z" });
    }
    const snapshot = buffer.snapshot();
    expect(snapshot).toHaveLength(30);
    expect(snapshot[0]?.message).toBe("crumb-1");
    expect(snapshot[29]?.message).toBe("crumb-30");
  });

  it("snapshot restituisce una copia indipendente", () => {
    const buffer = new BreadcrumbBuffer();
    buffer.add({ type: "click", message: "a", timestamp: "2026-06-10T12:00:00.000Z" });
    const snapshot = buffer.snapshot();
    buffer.add({ type: "click", message: "b", timestamp: "2026-06-10T12:00:01.000Z" });
    expect(snapshot).toHaveLength(1);
  });
});

describe("Client", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("captureError normalizza un Error in un ErrorEvent completo", async () => {
    const fetchMock = okFetch();
    const client = new Client({
      dsn: DSN,
      release: "1.2.3",
      environment: "production",
      fetchImpl: fetchMock,
    });

    client.captureError(new TypeError("x is undefined"), { url: "https://app.example.com/checkout" });
    await client.flush();

    const [event] = sentEvents(fetchMock) as ErrorEvent[];
    expect(event).toMatchObject({
      kind: "error",
      message: "x is undefined",
      errorType: "TypeError",
      url: "https://app.example.com/checkout",
      release: "1.2.3",
      environment: "production",
      breadcrumbs: [],
    });
    expect(event?.stack).toContain("TypeError");
    expect(new Date(event!.timestamp).getTime()).not.toBeNaN();
  });

  it("captureError normalizza stringhe e oggetti generici", async () => {
    const fetchMock = okFetch();
    const client = new Client({ dsn: DSN, fetchImpl: fetchMock });

    client.captureError("qualcosa è andato storto");
    client.captureError({ code: 42 });
    await client.flush();

    const events = sentEvents(fetchMock) as ErrorEvent[];
    expect(events[0]).toMatchObject({ kind: "error", message: "qualcosa è andato storto" });
    expect(events[0]?.errorType).toBeUndefined();
    expect(events[0]?.stack).toBeUndefined();
    expect(events[1]?.message).toBe('{"code":42}');
  });

  it("captureError con un oggetto circolare non lancia e produce un messaggio non vuoto", async () => {
    const fetchMock = okFetch();
    const client = new Client({ dsn: DSN, fetchImpl: fetchMock });

    const circular: Record<string, unknown> = { a: 1 };
    circular.self = circular;

    expect(() => client.captureError(circular)).not.toThrow();
    await client.flush();

    const [event] = sentEvents(fetchMock) as ErrorEvent[];
    expect(typeof event?.message).toBe("string");
    expect(event!.message.length).toBeGreaterThan(0);
  });

  it("captureError allega uno snapshot dei breadcrumb (max 30, immutabile)", async () => {
    const fetchMock = okFetch();
    const client = new Client({ dsn: DSN, fetchImpl: fetchMock });

    for (let i = 0; i < 31; i++) {
      client.addBreadcrumb({ type: "log", message: `crumb-${i}` });
    }
    client.captureError(new Error("boom"));
    // mutare il buffer dopo la capture non deve toccare l'evento già catturato
    client.addBreadcrumb({ type: "navigation", message: "dopo-la-capture" });
    await client.flush();

    const [event] = sentEvents(fetchMock) as ErrorEvent[];
    expect(event?.breadcrumbs).toHaveLength(30);
    expect(event?.breadcrumbs[0]?.message).toBe("crumb-1");
    expect(event?.breadcrumbs[29]?.message).toBe("crumb-30");
    expect(event?.breadcrumbs.some((b) => b.message === "dopo-la-capture")).toBe(false);
  });

  it("captureFeedback produce un FeedbackEvent", async () => {
    const fetchMock = okFetch();
    const client = new Client({ dsn: DSN, release: "1.2.3", fetchImpl: fetchMock });

    client.captureFeedback({
      message: "il bottone non funziona",
      email: "user@example.com",
      url: "https://app.example.com/checkout",
    });
    await client.flush();

    const [event] = sentEvents(fetchMock) as FeedbackEvent[];
    expect(event).toMatchObject({
      kind: "feedback",
      message: "il bottone non funziona",
      email: "user@example.com",
      url: "https://app.example.com/checkout",
      release: "1.2.3",
    });
  });

  it("createTicket produce un TicketCreateEvent con priority di default", async () => {
    const fetchMock = okFetch();
    const client = new Client({ dsn: DSN, fetchImpl: fetchMock });

    client.createTicket({ title: "Aggiungere dark mode", type: "feature" });
    client.createTicket({ title: "Crash al checkout", body: "dettagli", type: "bug", priority: "urgent" });
    await client.flush();

    const events = sentEvents(fetchMock) as TicketCreateEvent[];
    expect(events[0]).toMatchObject({
      kind: "ticket",
      title: "Aggiungere dark mode",
      type: "feature",
      priority: "medium",
    });
    expect(events[1]).toMatchObject({
      kind: "ticket",
      title: "Crash al checkout",
      body: "dettagli",
      type: "bug",
      priority: "urgent",
    });
  });

  it("un DSN malformato fa fallire l'init in modo esplicito (unico punto che lancia)", () => {
    expect(() => new Client({ dsn: "not-a-dsn" })).toThrow();
  });
});
