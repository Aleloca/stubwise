import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  confirmTicket,
  createConversation,
  fetchConfig,
  fetchMessages,
  sendMessage,
  WidgetApiError,
  type WidgetApiBase,
} from "./api.js";

/** Base con un prefisso di path, per verificare che l'URL lo preservi. */
const base: WidgetApiBase = {
  origin: "https://app.example.com/backend",
  slug: "acme",
  key: "pub_key_123",
};

/** Ultima chiamata registrata dal mock di fetch (url + init). */
let lastCall: { input: string; init: RequestInit } | undefined;

/**
 * Sostituisce `fetch` con un mock che registra l'ultima chiamata e restituisce
 * una Response con lo status/body dati. Se `body` è una stringa la usiamo grezza
 * (per il caso non-JSON), altrimenti la serializziamo in JSON.
 */
function mockFetch(status: number, body: unknown, rawText?: string): void {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: string, init: RequestInit) => {
      lastCall = { input, init };
      const payload = rawText ?? JSON.stringify(body);
      return Promise.resolve(
        new Response(payload, {
          status,
          headers: { "content-type": rawText ? "text/plain" : "application/json" },
        }),
      );
    }),
  );
}

/** Legge il valore di un header dall'init registrato (case-insensitive-ish). */
function header(name: string): string | undefined {
  const h = lastCall?.init.headers as Record<string, string> | undefined;
  if (!h) return undefined;
  return h[name] ?? h[name.toLowerCase()];
}

beforeEach(() => {
  lastCall = undefined;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("url construction", () => {
  it("compone origin (con prefisso) + /widget/<slug> + path", async () => {
    mockFetch(200, { enabled: false });
    await fetchConfig(base);
    expect(lastCall?.input).toBe("https://app.example.com/backend/widget/acme/config");
  });

  it("appende la query userId ai messaggi", async () => {
    mockFetch(200, { messages: [] });
    await fetchMessages(base, "conv-1", "user-9");
    expect(lastCall?.input).toBe(
      "https://app.example.com/backend/widget/acme/conversations/conv-1/messages?userId=user-9",
    );
  });
});

describe("headers", () => {
  it("invia sempre X-Stubwise-Key", async () => {
    mockFetch(200, { enabled: false });
    await fetchConfig(base);
    expect(header("X-Stubwise-Key")).toBe("pub_key_123");
  });

  it("aggiunge content-type JSON sui POST con body", async () => {
    mockFetch(200, { conversationId: "c1" });
    await createConversation(base, { id: "u1" });
    expect(header("content-type")).toBe("application/json");
    expect(lastCall?.init.body).toBe(JSON.stringify({ user: { id: "u1" } }));
  });

  it("NON aggiunge content-type sui GET", async () => {
    mockFetch(200, { enabled: false });
    await fetchConfig(base);
    expect(header("content-type")).toBeUndefined();
  });
});

describe("throwApiError", () => {
  it("estrae code e message dal body JSON d'errore", async () => {
    mockFetch(429, { code: "widget_chat_cap_reached", message: "Cap raggiunto" });
    const err = await fetchConfig(base).catch((e) => e);
    expect(err).toBeInstanceOf(WidgetApiError);
    expect((err as WidgetApiError).status).toBe(429);
    expect((err as WidgetApiError).code).toBe("widget_chat_cap_reached");
    expect((err as WidgetApiError).message).toBe("Cap raggiunto");
  });

  it("lancia comunque su body non-JSON (senza code)", async () => {
    mockFetch(502, undefined, "Bad Gateway");
    const err = await fetchConfig(base).catch((e) => e);
    expect(err).toBeInstanceOf(WidgetApiError);
    expect((err as WidgetApiError).status).toBe(502);
    expect((err as WidgetApiError).code).toBeUndefined();
  });
});

describe("sendMessage", () => {
  it("ritorna la Response grezza (per lo stream) su ok", async () => {
    mockFetch(200, {});
    const res = await sendMessage(base, "c1", { content: "hi", userId: "u1" });
    expect(res).toBeInstanceOf(Response);
    expect(res.ok).toBe(true);
    expect(lastCall?.input).toBe(
      "https://app.example.com/backend/widget/acme/conversations/c1/messages",
    );
    expect(lastCall?.init.body).toBe(JSON.stringify({ content: "hi", userId: "u1" }));
  });

  it("lancia WidgetApiError PRIMA dello stream su errore HTTP", async () => {
    mockFetch(429, { code: "widget_chat_cap_reached" });
    const err = await sendMessage(base, "c1", { content: "hi", userId: "u1" }).catch((e) => e);
    expect(err).toBeInstanceOf(WidgetApiError);
    expect((err as WidgetApiError).status).toBe(429);
  });

  it("propaga l'AbortSignal al fetch (per l'abort dello stream)", async () => {
    mockFetch(200, {});
    const controller = new AbortController();
    await sendMessage(base, "c1", { content: "hi", userId: "u1" }, controller.signal);
    expect(lastCall?.init.signal).toBe(controller.signal);
  });
});

describe("confirmTicket", () => {
  it("POSTa la proposta con userId e ritorna ticketId + number", async () => {
    mockFetch(200, { ticketId: "t1", number: 42 });
    const out = await confirmTicket(base, "c1", {
      title: "Bug",
      body: "Descrizione",
      type: "bug",
      userId: "u1",
    });
    expect(out).toEqual({ ticketId: "t1", number: 42 });
    expect(lastCall?.input).toBe(
      "https://app.example.com/backend/widget/acme/conversations/c1/tickets",
    );
  });
});
