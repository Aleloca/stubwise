import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __resetWidgetForTests, initWidget, whenBodyReady } from "../index.js";

/**
 * Test della UI del widget in happy-dom. Il render avviene DENTRO uno shadow
 * root: le query di testing-library non lo attraversano, quindi interroghiamo
 * direttamente `host.shadowRoot`. Il DSN è valido; `fetch` è mockato per config
 * e lo stream è una Response con corpo SSE.
 */

const DSN = "https://pub_key@app.example.com/p/acme";
const USER = { id: "u1", email: "a@b.c" };

/**
 * Attende il flush di microtask + effetti Preact. Un ciclo effect→setState→
 * re-render richiede più giri di macrotask, quindi alterniamo microtask e
 * `setTimeout(0)` per `rounds` volte (default abbondante: i test sono veloci).
 */
async function flush(rounds = 6): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
  }
}

/** L'host del widget montato su body (o null). */
function host(): HTMLElement | null {
  return document.querySelector("[data-stubwise-widget]");
}

/** Lo shadow root dell'host (assunto presente). */
function shadow(): ShadowRoot {
  const h = host();
  if (!h?.shadowRoot) throw new Error("widget non montato");
  return h.shadowRoot;
}

/** Config attiva di default (override per test specifici). */
function activeConfig(over: Record<string, unknown> = {}) {
  return {
    enabled: true,
    title: "Assistenza Acme",
    welcomeMessage: "Benvenuto!",
    accentColor: "#3366ff",
    language: "it",
    chatEnabled: true,
    ...over,
  };
}

/** Response JSON di comodo. */
function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Response con corpo SSE dai chunk dati. */
function sseResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(encoder.encode(c));
      controller.close();
    },
  });
  return new Response(stream, { status: 200 });
}

/**
 * Router di fetch per i test: instrada per (method + path) e registra le chiamate.
 * `routes` mappa una chiave "METHOD path-suffix" → Response (o funzione).
 */
function installFetch(routes: Record<string, Response | (() => Response)>): {
  calls: { method: string; url: string; body: unknown }[];
} {
  const calls: { method: string; url: string; body: unknown }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((input: string, init: RequestInit = {}) => {
      const method = (init.method ?? "GET").toUpperCase();
      const body = init.body ? JSON.parse(init.body as string) : undefined;
      calls.push({ method, url: input, body });
      for (const [key, value] of Object.entries(routes)) {
        const [m, suffix] = key.split(" ");
        if (m === method && input.endsWith(suffix!)) {
          return Promise.resolve(typeof value === "function" ? value() : value);
        }
      }
      return Promise.reject(new Error(`no route for ${method} ${input}`));
    }),
  );
  return { calls };
}

beforeEach(() => {
  __resetWidgetForTests();
  localStorage.clear();
  document.body.innerHTML = "";
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("initWidget mounting", () => {
  it("con enabled:false non monta nulla e non lancia", async () => {
    installFetch({ "GET /config": jsonResponse(200, { enabled: false }) });
    await initWidget({ dsn: DSN, user: USER });
    await flush();
    expect(host()).toBeNull();
  });

  it("se il fetch della config LANCIA non monta nulla e non lancia", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new TypeError("network down"))));
    await expect(initWidget({ dsn: DSN, user: USER })).resolves.toBeUndefined();
    await flush();
    expect(host()).toBeNull();
  });

  it("doppia init monta un solo host", async () => {
    installFetch({ "GET /config": () => jsonResponse(200, activeConfig()) });
    await initWidget({ dsn: DSN, user: USER });
    await initWidget({ dsn: DSN, user: USER });
    await flush();
    expect(document.querySelectorAll("[data-stubwise-widget]").length).toBe(1);
  });

  it("due init CONCORRENTI (fetch lento) montano un solo host", async () => {
    // fetch della config che risolve dopo 10ms: senza la guardia settata PRIMA
    // del fetch, entrambe le init supererebbero il controllo mentre la config è
    // in volo e monterebbero due host (race verificata empiricamente).
    vi.stubGlobal(
      "fetch",
      vi.fn(
        () =>
          new Promise<Response>((resolve) =>
            setTimeout(() => resolve(jsonResponse(200, activeConfig())), 10),
          ),
      ),
    );
    await Promise.all([
      initWidget({ dsn: DSN, user: USER }),
      initWidget({ dsn: DSN, user: USER }),
    ]);
    await flush();
    expect(document.querySelectorAll("[data-stubwise-widget]").length).toBe(1);
  });
});

describe("whenBodyReady", () => {
  it("body già presente → chiama subito il callback", () => {
    const cb = vi.fn();
    whenBodyReady(cb);
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it("body assente → rimanda a DOMContentLoaded (once)", () => {
    // Simuliamo body null intercettando il getter (in happy-dom body è sempre
    // presente): la funzione deve registrare un listener DOMContentLoaded once.
    const bodyDesc = Object.getOwnPropertyDescriptor(Document.prototype, "body");
    Object.defineProperty(document, "body", { configurable: true, get: () => null });
    const addSpy = vi.spyOn(document, "addEventListener");
    const cb = vi.fn();
    try {
      whenBodyReady(cb);
      expect(cb).not.toHaveBeenCalled();
      expect(addSpy).toHaveBeenCalledWith("DOMContentLoaded", cb, { once: true });
    } finally {
      addSpy.mockRestore();
      if (bodyDesc) Object.defineProperty(document, "body", bodyDesc);
      else delete (document as unknown as { body?: unknown }).body;
    }
  });
});

describe("panel", () => {
  it("config ok → bolla nello shadow root; click → pannello con welcome e title", async () => {
    installFetch({ "GET /config": jsonResponse(200, activeConfig()) });
    await initWidget({ dsn: DSN, user: USER });
    await flush();

    const bubble = shadow().querySelector<HTMLButtonElement>(".sw-bubble");
    expect(bubble).not.toBeNull();
    expect(shadow().querySelector(".sw-panel")).toBeNull();

    bubble!.click();
    await flush();

    const panel = shadow().querySelector(".sw-panel");
    expect(panel).not.toBeNull();
    expect(shadow().querySelector(".sw-header-title")?.textContent).toBe("Assistenza Acme");
    expect(shadow().textContent).toContain("Benvenuto!");
    expect(shadow().textContent).toContain("Risponde l'assistente AI");
  });
});

describe("chat streaming", () => {
  it("invio con delta+done → testo assistant + citazione; conversazione creata lazy e salvata", async () => {
    const { calls } = installFetch({
      "GET /config": jsonResponse(200, activeConfig()),
      "POST /conversations": jsonResponse(200, { conversationId: "conv-99" }),
      "POST /conversations/conv-99/messages": sseResponse([
        'data: {"type":"delta","text":"Ciao "}\n\n',
        'data: {"type":"delta","text":"mondo"}\n\n',
        'data: {"type":"done","conversationId":"conv-99","citations":[{"title":"Guida X"}]}\n\n',
      ]),
    });
    await initWidget({ dsn: DSN, user: USER });
    await flush();
    shadow().querySelector<HTMLButtonElement>(".sw-bubble")!.click();
    await flush();

    const input = shadow().querySelector<HTMLTextAreaElement>(".sw-composer-input")!;
    input.value = "domanda";
    input.dispatchEvent(new Event("input"));
    await flush();
    shadow().querySelector<HTMLButtonElement>(".sw-composer .sw-btn")!.click();
    await flush(6);

    expect(shadow().textContent).toContain("Ciao mondo");
    expect(shadow().textContent).toContain("fonte: Guida X");
    // Conversazione creata lazy e id persistito.
    expect(calls.some((c) => c.method === "POST" && c.url.endsWith("/conversations"))).toBe(true);
    expect(localStorage.getItem("stubwise-widget:acme:conversation")).toBe("conv-99");
  });

  it("429 cap → messaggio dedicato", async () => {
    installFetch({
      "GET /config": jsonResponse(200, activeConfig()),
      "POST /conversations": jsonResponse(200, { conversationId: "conv-1" }),
      "POST /conversations/conv-1/messages": jsonResponse(429, {
        code: "widget_chat_cap_reached",
      }),
    });
    await initWidget({ dsn: DSN, user: USER });
    await flush();
    shadow().querySelector<HTMLButtonElement>(".sw-bubble")!.click();
    await flush();

    const input = shadow().querySelector<HTMLTextAreaElement>(".sw-composer-input")!;
    input.value = "ciao";
    input.dispatchEvent(new Event("input"));
    await flush();
    shadow().querySelector<HTMLButtonElement>(".sw-composer .sw-btn")!.click();
    await flush(6);

    expect(shadow().textContent).toContain("inviare una segnalazione");
  });
});

describe("ticket card", () => {
  it("ticket_proposal → card precompilata; edit title; conferma → confirmTicket col body editato e successo", async () => {
    const { calls } = installFetch({
      "GET /config": jsonResponse(200, activeConfig()),
      "POST /conversations": jsonResponse(200, { conversationId: "conv-7" }),
      "POST /conversations/conv-7/messages": sseResponse([
        'data: {"type":"delta","text":"Ok, apro una segnalazione."}\n\n',
        'data: {"type":"ticket_proposal","proposal":{"title":"Titolo AI","body":"Corpo AI","type":"bug"}}\n\n',
        'data: {"type":"done","conversationId":"conv-7","citations":[]}\n\n',
      ]),
      "POST /conversations/conv-7/tickets": jsonResponse(200, { ticketId: "t1", number: 128 }),
    });
    await initWidget({ dsn: DSN, user: USER });
    await flush();
    shadow().querySelector<HTMLButtonElement>(".sw-bubble")!.click();
    await flush();

    const input = shadow().querySelector<HTMLTextAreaElement>(".sw-composer-input")!;
    input.value = "ho un bug";
    input.dispatchEvent(new Event("input"));
    await flush();
    shadow().querySelector<HTMLButtonElement>(".sw-composer .sw-btn")!.click();
    await flush(6);

    // Card precompilata dalla proposta.
    const titleInput = shadow().querySelector<HTMLInputElement>(".sw-card .sw-input")!;
    const bodyArea = shadow().querySelector<HTMLTextAreaElement>(".sw-card .sw-textarea")!;
    expect(titleInput.value).toBe("Titolo AI");
    expect(bodyArea.value).toBe("Corpo AI");
    expect(shadow().querySelector(".sw-badge")?.textContent).toBe("bug");

    // Edit del titolo.
    titleInput.value = "Titolo editato";
    titleInput.dispatchEvent(new Event("input"));
    await flush();

    // Conferma.
    shadow().querySelector<HTMLButtonElement>(".sw-card .sw-btn")!.click();
    await flush(6);

    const ticketCall = calls.find((c) => c.url.endsWith("/tickets"));
    expect(ticketCall).toBeDefined();
    expect(ticketCall!.body).toMatchObject({
      title: "Titolo editato",
      body: "Corpo AI",
      type: "bug",
      userId: "u1",
    });
    expect(shadow().querySelector(".sw-card-confirmed")?.textContent).toContain("#128");
  });
});

describe("history", () => {
  it("storico con 0 messaggi → mostra il welcome fittizio", async () => {
    localStorage.setItem("stubwise-widget:acme:conversation", "conv-empty");
    installFetch({
      "GET /config": jsonResponse(200, activeConfig()),
      "GET /conversations/conv-empty/messages": jsonResponse(200, { messages: [] }),
    });
    await initWidget({ dsn: DSN, user: USER });
    await flush();
    shadow().querySelector<HTMLButtonElement>(".sw-bubble")!.click();
    await flush(6);

    expect(shadow().textContent).toContain("Benvenuto!");
  });
});

describe("stream abort on unmount", () => {
  it("chiusura pannello a stream attivo → il fetch riceve l'abort, nessun errore mostrato", async () => {
    let capturedSignal: AbortSignal | undefined;
    // Lo stream non si chiude da solo: resta appeso finché non arriva l'abort.
    const pendingSse = new Response(
      new ReadableStream<Uint8Array>({
        start() {
          /* nessun enqueue, nessun close: pende */
        },
      }),
      { status: 200 },
    );
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string, init: RequestInit = {}) => {
        if (input.endsWith("/config")) return Promise.resolve(jsonResponse(200, activeConfig()));
        if (input.endsWith("/conversations"))
          return Promise.resolve(jsonResponse(200, { conversationId: "conv-x" }));
        if (input.endsWith("/conversations/conv-x/messages")) {
          capturedSignal = init.signal ?? undefined;
          return Promise.resolve(pendingSse);
        }
        return Promise.reject(new Error(`no route for ${input}`));
      }),
    );

    await initWidget({ dsn: DSN, user: USER });
    await flush();
    shadow().querySelector<HTMLButtonElement>(".sw-bubble")!.click();
    await flush();

    const input = shadow().querySelector<HTMLTextAreaElement>(".sw-composer-input")!;
    input.value = "domanda";
    input.dispatchEvent(new Event("input"));
    await flush();
    shadow().querySelector<HTMLButtonElement>(".sw-composer .sw-btn")!.click();
    await flush();

    // Il signal è stato propagato ed è ancora attivo (stream in corso).
    expect(capturedSignal).toBeInstanceOf(AbortSignal);
    expect(capturedSignal!.aborted).toBe(false);

    // Chiudo il pannello (smonta Chat) → il cleanup aborta lo stream.
    shadow().querySelector<HTMLButtonElement>(".sw-bubble")!.click();
    await flush(6);

    expect(capturedSignal!.aborted).toBe(true);
    // Nessun messaggio d'errore lasciato in giro (l'abort è silenzioso).
    expect(shadow().textContent).not.toContain("Si è verificato un errore");
  });
});

describe("chat disabled", () => {
  it("chatEnabled:false → composer disabilitato con nota, widget montato", async () => {
    installFetch({
      "GET /config": jsonResponse(200, activeConfig({ chatEnabled: false })),
    });
    await initWidget({ dsn: DSN, user: USER });
    await flush();
    shadow().querySelector<HTMLButtonElement>(".sw-bubble")!.click();
    await flush();

    expect(shadow().querySelector(".sw-composer-input")).toBeNull();
    expect(shadow().querySelector(".sw-composer-note")).not.toBeNull();
  });
});
