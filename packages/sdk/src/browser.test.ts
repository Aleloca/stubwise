// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Breadcrumb, ErrorEvent as StubwiseErrorEvent, IngestEvent } from "@stubwise/shared";
import {
  __resetForTesting,
  addBreadcrumb,
  captureError,
  captureFeedback,
  createTicket,
  flush,
  init,
} from "./browser.js";

const DSN = "https://test-key@track.example.com/p/my-app";
const ENDPOINT = "https://track.example.com/ingest/my-app";

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

/** Breadcrumb allegati all'ultimo evento errore consegnato. */
async function breadcrumbsViaError(fetchMock: FetchMock): Promise<Breadcrumb[]> {
  window.dispatchEvent(new ErrorEvent("error", { error: new Error("sonda"), message: "sonda" }));
  await flush();
  const errors = deliveredErrors(fetchMock);
  const last = errors[errors.length - 1];
  if (!last) throw new Error("nessun evento errore consegnato");
  return last.breadcrumbs;
}

function dispatchWindowError(error: unknown, message = "boom"): void {
  window.dispatchEvent(new ErrorEvent("error", { error, message }));
}

/** happy-dom non implementa PromiseRejectionEvent: si simula con un Event + reason. */
function dispatchRejection(reason: unknown): void {
  const event = new Event("unhandledrejection") as Event & { reason?: unknown };
  event.reason = reason;
  window.dispatchEvent(event);
}

afterEach(() => {
  __resetForTesting();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("init — cattura errori globali", () => {
  it("un errore window arriva al transport con message, errorType, stack, url e userAgent", async () => {
    const fetchMock = okFetch();
    init({ dsn: DSN, release: "1.2.3", environment: "production", fetchImpl: fetchMock });

    dispatchWindowError(new TypeError("x is undefined"), "x is undefined");
    await flush();

    const [event] = deliveredErrors(fetchMock);
    expect(event).toMatchObject({
      kind: "error",
      message: "x is undefined",
      errorType: "TypeError",
      release: "1.2.3",
      environment: "production",
    });
    expect(event?.stack).toContain("TypeError");
    expect(event?.url).toBe(location.href);
    expect(event?.userAgent).toBe(navigator.userAgent);
  });

  it("un evento error senza oggetto Error usa il message dell'evento", async () => {
    const fetchMock = okFetch();
    init({ dsn: DSN, fetchImpl: fetchMock });

    dispatchWindowError(undefined, "Script error.");
    await flush();

    const [event] = deliveredErrors(fetchMock);
    expect(event?.message).toBe("Script error.");
  });

  it("una promise rifiutata arriva al transport con url e userAgent", async () => {
    const fetchMock = okFetch();
    init({ dsn: DSN, fetchImpl: fetchMock });

    dispatchRejection(new RangeError("fuori scala"));
    await flush();

    const [event] = deliveredErrors(fetchMock);
    expect(event).toMatchObject({
      kind: "error",
      message: "fuori scala",
      errorType: "RangeError",
    });
    expect(event?.url).toBe(location.href);
    expect(event?.userAgent).toBe(navigator.userAgent);
  });

  it("una rejection con reason non-Error viene normalizzata dal core", async () => {
    const fetchMock = okFetch();
    init({ dsn: DSN, fetchImpl: fetchMock });

    dispatchRejection("stringa di errore");
    await flush();

    const [event] = deliveredErrors(fetchMock);
    expect(event?.message).toBe("stringa di errore");
  });

  it("init chiamato due volte avvisa e non duplica i listener", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const fetchMock = okFetch();
    init({ dsn: DSN, fetchImpl: fetchMock });
    init({ dsn: DSN, fetchImpl: fetchMock });

    expect(warn).toHaveBeenCalledWith(expect.stringContaining("init"));

    dispatchWindowError(new Error("una volta sola"), "una volta sola");
    await flush();

    expect(deliveredErrors(fetchMock)).toHaveLength(1);
  });
});

describe("breadcrumb dai click", () => {
  it("i click su elementi con tag/id/classe finiscono nei breadcrumbs", async () => {
    const fetchMock = okFetch();
    init({ dsn: DSN, fetchImpl: fetchMock });

    const button = document.createElement("button");
    button.id = "buy";
    const card = document.createElement("div");
    card.className = "card big";
    const span = document.createElement("span");
    document.body.append(button, card, span);

    button.click();
    card.click();
    span.click();

    const crumbs = await breadcrumbsViaError(fetchMock);
    const clicks = crumbs.filter((c) => c.type === "click").map((c) => c.message);
    expect(clicks).toEqual(["button#buy", "div.card", "span"]);
  });

  it("click identici consecutivi entro 1s collassano in un solo breadcrumb", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const fetchMock = okFetch();
    init({ dsn: DSN, fetchImpl: fetchMock });

    const button = document.createElement("button");
    button.id = "buy";
    document.body.append(button);

    button.click();
    button.click();
    button.click();
    vi.setSystemTime(Date.now() + 1100);
    button.click();

    const crumbs = await breadcrumbsViaError(fetchMock);
    const clicks = crumbs.filter((c) => c.type === "click" && c.message === "button#buy");
    expect(clicks).toHaveLength(2);
  });
});

describe("breadcrumb di navigazione", () => {
  it("pushState e replaceState producono un breadcrumb from → to", async () => {
    const fetchMock = okFetch();
    init({ dsn: DSN, fetchImpl: fetchMock });

    const start = location.href;
    history.pushState({}, "", "/checkout");
    const afterPush = location.href;
    history.replaceState({}, "", "/checkout?step=2");
    const afterReplace = location.href;

    const crumbs = await breadcrumbsViaError(fetchMock);
    const navs = crumbs.filter((c) => c.type === "navigation").map((c) => c.message);
    expect(navs).toEqual([`${start} → ${afterPush}`, `${afterPush} → ${afterReplace}`]);
  });

  it("popstate (history.back) produce un breadcrumb di navigazione", async () => {
    const fetchMock = okFetch();
    init({ dsn: DSN, fetchImpl: fetchMock });

    history.pushState({}, "", "/a");
    const atA = location.href;
    history.pushState({}, "", "/b");
    const atB = location.href;
    history.back();
    await vi.waitFor(() => expect(location.href).toBe(atA));

    const crumbs = await breadcrumbsViaError(fetchMock);
    const navs = crumbs.filter((c) => c.type === "navigation").map((c) => c.message);
    expect(navs).toContain(`${atB} → ${atA}`);
  });

  it("hashchange produce un breadcrumb di navigazione from → to", async () => {
    const fetchMock = okFetch();
    init({ dsn: DSN, fetchImpl: fetchMock });

    const before = location.href;
    location.hash = "#dettagli";
    // happy-dom potrebbe non emettere hashchange da solo: il dispatch manuale
    // è idempotente perché recordNavigation deduplica gli URL identici
    window.dispatchEvent(new Event("hashchange"));
    const after = location.href;
    expect(after).not.toBe(before);

    const crumbs = await breadcrumbsViaError(fetchMock);
    const navs = crumbs.filter((c) => c.type === "navigation").map((c) => c.message);
    expect(navs).toContain(`${before} → ${after}`);
  });
});

describe("strumentazione di fetch", () => {
  it("una risposta ≥400 produce un breadcrumb fetch e la risposta passa intatta", async () => {
    const response = new Response("ko", { status: 500 });
    const inner = vi.fn<typeof fetch>().mockResolvedValue(response);
    window.fetch = inner;

    const fetchMock = okFetch();
    init({ dsn: DSN, fetchImpl: fetchMock });

    const result = await window.fetch("https://api.example.com/cart", { method: "POST" });
    expect(result).toBe(response);
    expect(inner).toHaveBeenCalledWith("https://api.example.com/cart", { method: "POST" });

    const crumbs = await breadcrumbsViaError(fetchMock);
    const fetches = crumbs.filter((c) => c.type === "fetch").map((c) => c.message);
    expect(fetches).toEqual(["POST https://api.example.com/cart → 500"]);
  });

  it("un errore di rete produce un breadcrumb e l'errore originale viene rilanciato", async () => {
    const failure = new TypeError("Failed to fetch");
    const inner = vi.fn<typeof fetch>().mockRejectedValue(failure);
    window.fetch = inner;

    const fetchMock = okFetch();
    init({ dsn: DSN, fetchImpl: fetchMock });

    await expect(window.fetch("https://api.example.com/cart")).rejects.toBe(failure);

    const crumbs = await breadcrumbsViaError(fetchMock);
    const fetches = crumbs.filter((c) => c.type === "fetch").map((c) => c.message);
    expect(fetches).toEqual(["GET https://api.example.com/cart → errore di rete"]);
  });

  it("una risposta ok non produce breadcrumb e passa intatta", async () => {
    const response = new Response("ok", { status: 200 });
    const inner = vi.fn<typeof fetch>().mockResolvedValue(response);
    window.fetch = inner;

    const fetchMock = okFetch();
    init({ dsn: DSN, fetchImpl: fetchMock });

    const result = await window.fetch("https://api.example.com/ok");
    expect(result).toBe(response);

    const crumbs = await breadcrumbsViaError(fetchMock);
    expect(crumbs.filter((c) => c.type === "fetch")).toHaveLength(0);
  });

  it("un input Request preserva metodo e url nel breadcrumb", async () => {
    const inner = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 404 }));
    window.fetch = inner;

    const fetchMock = okFetch();
    init({ dsn: DSN, fetchImpl: fetchMock });

    await window.fetch(new Request("https://api.example.com/items", { method: "PUT" }));

    const crumbs = await breadcrumbsViaError(fetchMock);
    const fetches = crumbs.filter((c) => c.type === "fetch").map((c) => c.message);
    expect(fetches).toEqual(["PUT https://api.example.com/items → 404"]);
  });

  it("le chiamate verso l'endpoint di ingestion non producono breadcrumb (niente feedback loop)", async () => {
    const inner = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 500 }));
    window.fetch = inner;

    const fetchMock = okFetch();
    init({ dsn: DSN, fetchImpl: fetchMock });

    await window.fetch(ENDPOINT, { method: "POST" });

    const crumbs = await breadcrumbsViaError(fetchMock);
    expect(crumbs.filter((c) => c.type === "fetch")).toHaveLength(0);
  });

  it("un URL lookalike dell'endpoint (slug con suffisso) produce il suo breadcrumb", async () => {
    const inner = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 500 }));
    window.fetch = inner;

    const fetchMock = okFetch();
    init({ dsn: DSN, fetchImpl: fetchMock });

    // /ingest/my-app-v2 NON è l'endpoint /ingest/my-app: niente skip
    await window.fetch(`${ENDPOINT}-v2`, { method: "POST" });

    const crumbs = await breadcrumbsViaError(fetchMock);
    const fetches = crumbs.filter((c) => c.type === "fetch").map((c) => c.message);
    expect(fetches).toEqual([`POST ${ENDPOINT}-v2 → 500`]);
  });

  it("l'endpoint con query string o hash resta escluso dai breadcrumb", async () => {
    const inner = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 500 }));
    window.fetch = inner;

    const fetchMock = okFetch();
    init({ dsn: DSN, fetchImpl: fetchMock });

    await window.fetch(`${ENDPOINT}?retry=1`, { method: "POST" });
    await window.fetch(`${ENDPOINT}#frag`, { method: "POST" });

    const crumbs = await breadcrumbsViaError(fetchMock);
    expect(crumbs.filter((c) => c.type === "fetch")).toHaveLength(0);
  });

  it("window.fetch non-funzione: init non installa il wrapper e nulla lancia", async () => {
    const original = window.fetch;
    // @ts-expect-error simulazione di un ambiente esotico senza fetch
    delete window.fetch;
    try {
      const fetchMock = okFetch();
      expect(() => init({ dsn: DSN, fetchImpl: fetchMock })).not.toThrow();
      // nessun wrapper installato: window.fetch resta com'era (assente)
      expect(window.fetch).toBeUndefined();

      // il resto dell'SDK continua a funzionare
      captureError(new Error("senza fetch"));
      await flush();
      expect(deliveredErrors(fetchMock).map((e) => e.message)).toEqual(["senza fetch"]);
    } finally {
      window.fetch = original;
    }
  });

  it("senza fetchImpl il transport usa la fetch pre-wrap: i POST di ingestion falliti non generano breadcrumb", async () => {
    // window.fetch fa da "server" che rifiuta con 500: se il transport
    // passasse dalla fetch strumentata, ogni flush fallito genererebbe un
    // breadcrumb fetch — il feedback loop che vogliamo escludere.
    const inner = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 500 }));
    window.fetch = inner;

    init({ dsn: DSN });
    captureFeedback({ message: "il carrello non si svuota" });
    await flush();

    expect(inner).toHaveBeenCalledTimes(1);
    expect(inner.mock.calls[0]?.[0]).toBe(ENDPOINT);

    dispatchWindowError(new Error("sonda"), "sonda");
    await flush();

    const lastCall = inner.mock.calls[inner.mock.calls.length - 1];
    const { events } = JSON.parse(lastCall?.[1]?.body as string) as { events: IngestEvent[] };
    const error = events.find((e): e is StubwiseErrorEvent => e.kind === "error");
    expect(error).toBeDefined();
    expect(error?.breadcrumbs.filter((c) => c.type === "fetch")).toHaveLength(0);
  });
});

describe("flush automatico a fine pagina", () => {
  it("pagehide svuota la coda con keepalive (il browser non aborta la fetch)", async () => {
    const fetchMock = okFetch();
    init({ dsn: DSN, fetchImpl: fetchMock });

    captureFeedback({ message: "feedback in coda" });
    expect(fetchMock).not.toHaveBeenCalled();

    window.dispatchEvent(new Event("pagehide"));
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchMock.mock.calls[0]?.[1]?.keepalive).toBe(true);
  });

  it("visibilitychange → hidden svuota la coda con keepalive", async () => {
    const fetchMock = okFetch();
    init({ dsn: DSN, fetchImpl: fetchMock });

    captureFeedback({ message: "feedback in coda" });
    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
    try {
      document.dispatchEvent(new Event("visibilitychange"));
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
      expect(fetchMock.mock.calls[0]?.[1]?.keepalive).toBe(true);
    } finally {
      delete (document as { visibilityState?: string }).visibilityState;
    }
  });

  it("flush() manuale non imposta keepalive", async () => {
    const fetchMock = okFetch();
    init({ dsn: DSN, fetchImpl: fetchMock });

    captureFeedback({ message: "feedback in coda" });
    await flush();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[1]?.keepalive).toBeUndefined();
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

describe("API manuale dopo init", () => {
  it("captureError manuale allega url e userAgent correnti", async () => {
    const fetchMock = okFetch();
    init({ dsn: DSN, fetchImpl: fetchMock });

    captureError(new Error("manuale"));
    await flush();

    const [event] = deliveredErrors(fetchMock);
    expect(event?.message).toBe("manuale");
    expect(event?.url).toBe(location.href);
    expect(event?.userAgent).toBe(navigator.userAgent);
  });

  it("captureFeedback e createTicket arrivano al transport", async () => {
    const fetchMock = okFetch();
    init({ dsn: DSN, fetchImpl: fetchMock });

    captureFeedback({ message: "non funziona", email: "user@example.com" });
    createTicket({ title: "Export CSV", type: "feature", priority: "high" });
    await flush();

    const events = deliveredEvents(fetchMock);
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ kind: "feedback", message: "non funziona" });
    expect(events[1]).toMatchObject({ kind: "ticket", title: "Export CSV" });
  });

  it("addBreadcrumb manuale finisce nei breadcrumbs degli errori", async () => {
    const fetchMock = okFetch();
    init({ dsn: DSN, fetchImpl: fetchMock });

    addBreadcrumb({ type: "log", message: "passo importante" });

    const crumbs = await breadcrumbsViaError(fetchMock);
    expect(crumbs.filter((c) => c.type === "log").map((c) => c.message)).toEqual([
      "passo importante",
    ]);
  });
});
