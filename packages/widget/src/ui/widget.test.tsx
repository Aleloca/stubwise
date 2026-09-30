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

  it("l'header contiene un bottone di chiusura che chiude il pannello", async () => {
    installFetch({ "GET /config": jsonResponse(200, activeConfig()) });
    await initWidget({ dsn: DSN, user: USER });
    await flush();
    shadow().querySelector<HTMLButtonElement>(".sw-bubble")!.click();
    await flush();

    const close = shadow().querySelector<HTMLButtonElement>(".sw-header-close");
    expect(close).not.toBeNull();
    expect(close!.getAttribute("aria-label")).toBe("Chiudi la chat");

    close!.click();
    await flush();
    expect(shadow().querySelector(".sw-panel")).toBeNull();
  });

  it("con pannello aperto la bolla flottante ha la classe che la nasconde su mobile", async () => {
    installFetch({ "GET /config": jsonResponse(200, activeConfig()) });
    await initWidget({ dsn: DSN, user: USER });
    await flush();
    shadow().querySelector<HTMLButtonElement>(".sw-bubble")!.click();
    await flush();

    expect(shadow().querySelector(".sw-bubble--hidden")).not.toBeNull();
  });
});

describe("chat streaming", () => {
  it("invio con delta+done → testo assistant; citazioni NON renderizzate; conversazione creata lazy e salvata", async () => {
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
    // Le citazioni arrivano nel `done` ma NON vengono mostrate nel widget.
    expect(shadow().textContent).not.toContain("Guida X");
    expect(shadow().textContent).not.toContain("fonte");
    expect(shadow().querySelector(".sw-citation")).toBeNull();
    // Conversazione creata lazy e id persistito.
    expect(calls.some((c) => c.method === "POST" && c.url.endsWith("/conversations"))).toBe(true);
    expect(localStorage.getItem("stubwise-widget:acme:conversation")).toBe("conv-99");
  });

  it("risposta assistant con **grassetto** → il DOM del messaggio contiene <strong>", async () => {
    installFetch({
      "GET /config": jsonResponse(200, activeConfig()),
      "POST /conversations": jsonResponse(200, { conversationId: "conv-md" }),
      "POST /conversations/conv-md/messages": sseResponse([
        'data: {"type":"delta","text":"ecco **grassetto** e "}\n\n',
        'data: {"type":"delta","text":"`codice`"}\n\n',
        'data: {"type":"done","conversationId":"conv-md","citations":[]}\n\n',
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

    const assistants = shadow().querySelectorAll(".sw-msg-assistant");
    const assistant = assistants[assistants.length - 1]!;
    expect(assistant.querySelector("strong")?.textContent).toBe("grassetto");
    expect(assistant.querySelector("code")?.textContent).toBe("codice");
    // Il testo grezzo dei marcatori non è visibile.
    expect(assistant.textContent).not.toContain("**");
    expect(assistant.textContent).not.toContain("`");
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
      // La query ?userId fa parte dell'URL reale: senza, la route non aggancia e
      // il welcome apparirebbe dal ramo d'errore, non da messages.length === 0.
      "GET /conversations/conv-empty/messages?userId=u1": jsonResponse(200, { messages: [] }),
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

describe("new conversation button", () => {
  /** Apre il pannello con una conversazione salvata e storico non vuoto. */
  async function openWithHistory(routes: Record<string, Response | (() => Response)> = {}) {
    localStorage.setItem("stubwise-widget:acme:conversation", "conv-old");
    const fx = installFetch({
      "GET /config": () => jsonResponse(200, activeConfig()),
      // NB: l'URL dei messaggi porta `?userId=…`, quindi la chiave del router
      // (matcha per endsWith) DEVE includere la query, altrimenti non aggancia.
      "GET /conversations/conv-old/messages?userId=u1": () =>
        jsonResponse(200, {
          messages: [
            { id: "m1", role: "user", content: "vecchia domanda", citations: null },
            { id: "m2", role: "assistant", content: "vecchia risposta", citations: [] },
          ],
        }),
      ...routes,
    });
    await initWidget({ dsn: DSN, user: USER });
    await flush();
    shadow().querySelector<HTMLButtonElement>(".sw-bubble")!.click();
    await flush(6);
    return fx;
  }

  it("il bottone è presente nell'header con aria-label i18n", async () => {
    await openWithHistory();
    const btn = shadow().querySelector<HTMLButtonElement>(".sw-header-newchat");
    expect(btn).not.toBeNull();
    expect(btn!.getAttribute("aria-label")).toBe("Nuova conversazione");
  });

  it("primo click → stato conferma; secondo click → storage pulito e timeline al welcome", async () => {
    await openWithHistory();
    expect(shadow().textContent).toContain("vecchia risposta");

    const btn = shadow().querySelector<HTMLButtonElement>(".sw-header-newchat")!;
    // Primo click: conferma armata (nessun reset ancora).
    btn.click();
    await flush();
    expect(
      shadow().querySelector<HTMLButtonElement>(".sw-header-newchat")!.getAttribute("aria-label"),
    ).toBe("Confermi? Ricomincia da capo");
    expect(shadow().querySelector(".sw-header-newchat--confirm")).not.toBeNull();
    expect(localStorage.getItem("stubwise-widget:acme:conversation")).toBe("conv-old");

    // Secondo click: reset.
    shadow().querySelector<HTMLButtonElement>(".sw-header-newchat")!.click();
    await flush(6);

    expect(localStorage.getItem("stubwise-widget:acme:conversation")).toBeNull();
    expect(shadow().textContent).not.toContain("vecchia risposta");
    expect(shadow().textContent).not.toContain("vecchia domanda");
    expect(shadow().textContent).toContain("Benvenuto!");
    // La conferma è rientrata.
    expect(shadow().querySelector(".sw-header-newchat--confirm")).toBeNull();
  });

  it("dopo il reset l'invio ricrea la conversazione (createConversation di nuovo chiamato)", async () => {
    const { calls } = await openWithHistory({
      "POST /conversations": () => jsonResponse(200, { conversationId: "conv-new" }),
      "POST /conversations/conv-new/messages": () =>
        sseResponse([
          'data: {"type":"delta","text":"nuova risposta"}\n\n',
          'data: {"type":"done","conversationId":"conv-new","citations":[]}\n\n',
        ]),
    });

    const btn = shadow().querySelector<HTMLButtonElement>(".sw-header-newchat")!;
    btn.click();
    await flush();
    shadow().querySelector<HTMLButtonElement>(".sw-header-newchat")!.click();
    await flush(6);

    // Invio dopo il reset: deve creare una NUOVA conversazione.
    const input = shadow().querySelector<HTMLTextAreaElement>(".sw-composer-input")!;
    input.value = "domanda nuova";
    input.dispatchEvent(new Event("input"));
    await flush();
    shadow().querySelector<HTMLButtonElement>(".sw-composer .sw-btn")!.click();
    await flush(6);

    expect(calls.filter((c) => c.method === "POST" && c.url.endsWith("/conversations")).length).toBe(
      1,
    );
    expect(localStorage.getItem("stubwise-widget:acme:conversation")).toBe("conv-new");
    expect(shadow().textContent).toContain("nuova risposta");
  });

  it("reset DURANTE lo stream → il fetch riceve l'abort e la timeline torna al welcome", async () => {
    let capturedSignal: AbortSignal | undefined;
    const pendingSse = new Response(
      new ReadableStream<Uint8Array>({
        start() {
          /* pende finché non arriva l'abort */
        },
      }),
      { status: 200 },
    );
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string, init: RequestInit = {}) => {
        if (input.endsWith("/config")) return Promise.resolve(jsonResponse(200, activeConfig()));
        if (input.endsWith("/conversations"))
          return Promise.resolve(jsonResponse(200, { conversationId: "conv-s" }));
        if (input.endsWith("/conversations/conv-s/messages")) {
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

    expect(capturedSignal).toBeInstanceOf(AbortSignal);
    expect(capturedSignal!.aborted).toBe(false);

    // Reset a stream attivo: due click sul bottone (conferma + azione).
    const btn = shadow().querySelector<HTMLButtonElement>(".sw-header-newchat")!;
    btn.click();
    await flush();
    shadow().querySelector<HTMLButtonElement>(".sw-header-newchat")!.click();
    await flush(6);

    // Lo stream è stato interrotto e la timeline è tornata pulita.
    expect(capturedSignal!.aborted).toBe(true);
    expect(shadow().textContent).toContain("Benvenuto!");
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

describe("drag", () => {
  /** Pointer event con coordinate client (tasto principale). */
  function pointer(target: EventTarget, type: string, x: number, y: number) {
    target.dispatchEvent(
      new PointerEvent(type, { clientX: x, clientY: y, button: 0, bubbles: true, composed: true }),
    );
  }
  /** La geometria arriva al CSS come variabili sul root. */
  function cssVar(name: string): string {
    return shadow().querySelector<HTMLElement>(".sw-root")!.style.getPropertyValue(name);
  }
  function bubble(): HTMLButtonElement {
    return shadow().querySelector<HTMLButtonElement>(".sw-bubble")!;
  }
  /** In happy-dom documentElement.clientWidth/Height valgono 0: il widget ripiega su inner*. */
  function setViewport(width: number, height: number) {
    Object.defineProperty(window, "innerWidth", { value: width, configurable: true, writable: true });
    Object.defineProperty(window, "innerHeight", { value: height, configurable: true, writable: true });
  }
  async function mount() {
    installFetch({ "GET /config": jsonResponse(200, activeConfig()) });
    await initWidget({ dsn: DSN, user: USER });
    await flush();
  }

  beforeEach(() => setViewport(1280, 800));
  afterEach(() => setViewport(1024, 768));

  it("senza posizione salvata la bolla sta in basso a destra, come prima", async () => {
    await mount();
    expect(cssVar("--sw-bubble-left")).toBe("1204px");
    expect(cssVar("--sw-bubble-top")).toBe("724px");
  });

  it("un movimento sotto soglia resta un click: apre, e non salva nulla", async () => {
    await mount();
    pointer(bubble(), "pointerdown", 1224, 752);
    pointer(window, "pointerup", 1226, 753);
    bubble().click();
    await flush();
    expect(shadow().querySelector(".sw-panel")).not.toBeNull();
    expect(localStorage.getItem("stubwise-widget:acme:position")).toBeNull();
  });

  it("un trascinamento non apre la chat, aggancia al bordo e salva; il click dopo funziona", async () => {
    await mount();
    pointer(bubble(), "pointerdown", 1224, 752);
    pointer(window, "pointermove", 200, 300);
    await flush();
    // Durante il trascinamento la bolla segue il puntatore.
    expect(shadow().querySelector(".sw-root--dragging")).not.toBeNull();
    expect(cssVar("--sw-bubble-left")).toBe("180px");
    pointer(window, "pointerup", 200, 300);
    bubble().click(); // il click che il browser emette a fine trascinamento
    await flush();

    expect(shadow().querySelector(".sw-panel")).toBeNull();
    expect(shadow().querySelector(".sw-root--dragging")).toBeNull();
    expect(JSON.parse(localStorage.getItem("stubwise-widget:acme:position")!)).toEqual({
      side: "left",
      y: 0.375,
    });
    expect(cssVar("--sw-bubble-left")).toBe("20px");
    expect(cssVar("--sw-bubble-top")).toBe("272px");

    // La soppressione vale un click solo.
    bubble().click();
    await flush();
    expect(shadow().querySelector(".sw-panel")).not.toBeNull();
  });

  it("riparte dalla posizione salvata e apre il pannello dove c'è spazio (sotto)", async () => {
    localStorage.setItem("stubwise-widget:acme:position", JSON.stringify({ side: "left", y: 0 }));
    await mount();
    expect(cssVar("--sw-bubble-left")).toBe("20px");
    expect(cssVar("--sw-bubble-top")).toBe("20px");
    bubble().click();
    await flush();
    expect(cssVar("--sw-panel-left")).toBe("20px");
    expect(cssVar("--sw-panel-top")).toBe("88px");
    expect(cssVar("--sw-panel-height")).toBe("600px");
  });

  it("finché non è mai stata spostata la bolla ha la maniglia, verso il centro della pagina", async () => {
    await mount();
    const grip = shadow().querySelector(".sw-bubble-grip");
    expect(grip).not.toBeNull();
    // Bolla a destra → maniglia sul suo lato sinistro.
    expect(grip!.classList.contains("sw-bubble-grip--right")).toBe(false);
    expect(bubble().getAttribute("title")).toBe("Trascina per spostare");
  });

  it("dopo il primo trascinamento la maniglia sparisce", async () => {
    await mount();
    pointer(bubble(), "pointerdown", 1224, 752);
    pointer(window, "pointermove", 200, 300);
    await flush();
    // Durante il trascinamento resta, e passa sul lato giusto.
    expect(shadow().querySelector(".sw-bubble-grip--right")).not.toBeNull();
    pointer(window, "pointerup", 200, 300);
    await flush();
    expect(shadow().querySelector(".sw-bubble-grip")).toBeNull();
    // Preact lascia title="" invece di rimuoverlo: per il browser è "nessun tooltip".
    expect(bubble().getAttribute("title") ?? "").toBe("");
  });

  it("la maniglia è un elemento a sé (sta DIETRO la bolla) e trascinarla sposta la bolla", async () => {
    await mount();
    const grip = shadow().querySelector<HTMLElement>(".sw-bubble-grip")!;
    expect(bubble().contains(grip)).toBe(false);
    pointer(grip, "pointerdown", 1210, 752);
    pointer(window, "pointermove", 200, 300);
    pointer(window, "pointerup", 200, 300);
    await flush();
    expect(JSON.parse(localStorage.getItem("stubwise-widget:acme:position")!).side).toBe("left");
  });

  it("con una posizione già salvata la maniglia non compare", async () => {
    localStorage.setItem("stubwise-widget:acme:position", JSON.stringify({ side: "right", y: 1 }));
    await mount();
    expect(shadow().querySelector(".sw-bubble-grip")).toBeNull();
  });

  it("a chat aperta la maniglia non c'è (la bolla è il tasto chiudi)", async () => {
    await mount();
    bubble().click();
    await flush();
    expect(shadow().querySelector(".sw-bubble-grip")).toBeNull();
  });

  it("al resize la posizione si ricalcola dalla frazione", async () => {
    await mount();
    setViewport(1280, 600);
    window.dispatchEvent(new Event("resize"));
    await flush();
    expect(cssVar("--sw-bubble-top")).toBe("524px");
  });
});
