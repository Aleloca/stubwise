import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionHeader } from "../../components/agent-session/session-header";
import { Transcript } from "../../components/agent-session/transcript";
import { buildTranscript } from "@stubwise/shared";
import { agentSessionKeys, backlogKeys, inboxKeys, ticketKeys } from "../../lib/queries";
import { createAppRouter } from "../../router";
import { controlledSse } from "../../test/sse";

/** `/agents/$id` (piano B, Task 6): la vista di una sessione, in sola lettura. */

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  // Smonta PRIMA di togliere il doppio di fetch: uno stream aperto dopo
  // l'unstub userebbe il fetch vero di happy-dom.
  cleanup();
  vi.unstubAllGlobals();
  fetchMock.mockReset();
});

type Handler = (url: URL, init?: RequestInit) => Response | Promise<Response>;

function mockApi(handlers: Record<string, Handler>) {
  fetchMock.mockImplementation((input, init) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(raw, "http://test.local");
    const method = init?.method ?? "GET";
    const exact = handlers[`${method} ${url.pathname}`];
    if (exact) return Promise.resolve(exact(url, init));
    throw new Error(`fetch non mockata per ${method} ${raw}`);
  });
}

/** Le chiamate fatte a un path, con URL e init. */
function callsTo(pathname: string): { url: URL; init: RequestInit | undefined }[] {
  return fetchMock.mock.calls
    .map(([input, init]) => {
      const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      return { url: new URL(raw, "http://test.local"), init };
    })
    .filter((c) => c.url.pathname === pathname);
}

const SESSION_ID = "11111111-1111-4111-8111-111111111111";
const PROJECT_ID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const TICKET_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const INPUT_ID = "99999999-9999-4999-8999-999999999999";
const NOW = Date.now();
const at = (secondsAgo: number) => new Date(NOW - secondsAgo * 1000).toISOString();

const DETAIL_PATH = `/api/agent-sessions/${SESSION_ID}`;
const EVENTS_PATH = `${DETAIL_PATH}/events`;
const STREAM_PATH = `${DETAIL_PATH}/stream`;

const LIVE_DETAIL = {
  id: SESSION_ID,
  kind: "ai_job",
  title: "Fix the login bug",
  projectId: PROJECT_ID,
  projectName: "Apollo",
  ticketId: TICKET_ID,
  ticketNumber: 42,
  startedAt: at(75 * 60),
  lastEventAt: at(5),
  state: "working",
  activeSegment: "execute",
  lastActivity: { kind: "edit", target: "routes/tickets.ts" },
  aiJobId: "22222222-2222-4222-8222-222222222222",
  outcome: null,
  canWrite: false,
  canInterrupt: false,
  questions: [],
  inputs: [],
};

const FIRST_PAGE = {
  events: [
    { id: "101", type: "segment_start", segmentId: "s1", at: at(60), data: { label: "execute", interactive: true } },
    { id: "102", type: "assistant_text", segmentId: "s1", at: at(50), data: { text: "Looking at the **router** now" } },
    {
      id: "103",
      type: "tool_use",
      segmentId: "s1",
      at: at(40),
      data: { toolUseId: "tu1", name: "Edit", input: { file_path: "routes/tickets.ts", old_string: "a", new_string: "b" } },
    },
    {
      id: "104",
      type: "tool_result",
      segmentId: "s1",
      at: at(30),
      data: { toolUseId: "tu1", isError: false, content: "file updated", truncated: true },
    },
  ],
  before: null,
};

type FixtureEvent = { id: string };

/** `?after=` come il server: solo gli eventi successivi; senza cursore la pagina intera. */
function pageAfter(events: FixtureEvent[], url: URL): { events: FixtureEvent[]; before: string | null } {
  const after = url.searchParams.get("after");
  if (after === null) return { events, before: null };
  return { events: events.filter((e) => BigInt(e.id) > BigInt(after)), before: null };
}

function meHandler(role: "admin" | "member" = "admin"): Handler {
  return () => jsonResponse(200, { user: { id: "u1", email: "ada@example.com", role, language: "en" } });
}

interface StreamHandle {
  url: URL;
  signal: AbortSignal | undefined;
  stream: ReturnType<typeof controlledSse>;
}

function baseApi(overrides: Record<string, Handler> = {}): {
  handlers: Record<string, Handler>;
  streams: StreamHandle[];
} {
  const streams: StreamHandle[] = [];
  return {
    streams,
    handlers: {
      "GET /api/auth/me": meHandler(),
      "GET /api/inbox/unread-count": () => jsonResponse(200, { count: 0 }),
      [`GET ${DETAIL_PATH}`]: () => jsonResponse(200, LIVE_DETAIL),
      [`GET ${EVENTS_PATH}`]: (url) => jsonResponse(200, pageAfter(FIRST_PAGE.events, url)),
      [`GET ${STREAM_PATH}`]: (url, init) => {
        const stream = controlledSse();
        streams.push({ url, signal: init?.signal ?? undefined, stream });
        return stream.response;
      },
      ...overrides,
    },
  };
}

function renderSession(path = `/agents/${SESSION_ID}`) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, retryDelay: 0 } } });
  const router = createAppRouter(queryClient, createMemoryHistory({ initialEntries: [path] }));
  const view = render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { router, queryClient, view };
}

describe("/agents/$id", () => {
  it("mostra intestazione, testo, card del tool e divisore di segmento dalla prima pagina", async () => {
    const api = baseApi();
    mockApi(api.handlers);
    renderSession();

    expect(await screen.findByRole("heading", { name: "Fix the login bug" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "#42" })).toHaveAttribute("href", `/tickets/${TICKET_ID}`);
    expect(screen.getByText("Apollo")).toBeInTheDocument();
    expect(screen.getByText("working")).toBeInTheDocument();
    // L'intestazione (dal dettaglio del loader) può precedere la prima pagina di eventi.
    expect(await screen.findByText("Execution")).toBeInTheDocument();
    expect(screen.getByText("router")).toBeInTheDocument();

    // La card del tool è compatta: si apre su input e risultato.
    const card = screen.getByRole("button", { name: /Edit file routes\/tickets\.ts/ });
    expect(screen.queryByText("file updated")).not.toBeInTheDocument();
    await userEvent.click(card);
    expect(screen.getByText("file updated")).toBeInTheDocument();
    expect(screen.getByText(/"file_path": "routes\/tickets\.ts"/)).toBeInTheDocument();
    expect(screen.getByText("(truncated)")).toBeInTheDocument();
  });

  it("carica solo l'ultima pagina e apre lo stream dall'ultimo id caricato", async () => {
    const api = baseApi();
    mockApi(api.handlers);
    renderSession();

    await waitFor(() => expect(api.streams).toHaveLength(1));
    // Una sola pagina, senza cursori: gli ultimi 200 (sessione enorme = niente da capo).
    const pages = callsTo(EVENTS_PATH);
    expect(pages).toHaveLength(1);
    expect([...pages[0]!.url.searchParams.keys()]).toEqual([]);
    expect(api.streams[0]!.url.searchParams.get("after")).toBe("104");
  });

  it("un parziale compare dal vivo (delta accumulati) e sparisce all'assistant_text del segmento", async () => {
    const api = baseApi();
    mockApi(api.handlers);
    renderSession();
    await waitFor(() => expect(api.streams).toHaveLength(1));
    const { stream } = api.streams[0]!;

    stream.push({ type: "partial", segmentId: "s1", text: "Now I am " });
    stream.push({ type: "partial", segmentId: "s1", text: "fixing it" });
    const live = await screen.findByText("Now I am fixing it");
    expect(live.closest("[data-live='true']")).not.toBeNull();

    stream.push({
      type: "events",
      events: [
        { id: "105", type: "assistant_text", segmentId: "s1", at: at(1), data: { text: "Now I am fixing it for real" } },
      ],
    });
    expect(await screen.findByText("Now I am fixing it for real")).toBeInTheDocument();
    expect(screen.queryByText("Now I am fixing it")).not.toBeInTheDocument();
  });

  it("un messaggio session con state ended aggiorna l'intestazione e chiude lo stream", async () => {
    const api = baseApi();
    mockApi(api.handlers);
    renderSession();
    await waitFor(() => expect(api.streams).toHaveLength(1));
    expect(screen.getByText("working")).toBeInTheDocument();
    const detailReads = callsTo(DETAIL_PATH).length;

    api.streams[0]!.stream.push({
      type: "session",
      detail: { ...LIVE_DETAIL, state: "ended", activeSegment: null, outcome: "completed" },
    });
    expect(await screen.findByText("completed")).toBeInTheDocument();
    expect(screen.queryByText("working")).not.toBeInTheDocument();
    // Niente ricarica: il dettaglio arriva dallo stream, non da una nuova lettura.
    expect(callsTo(DETAIL_PATH)).toHaveLength(detailReads);
    await waitFor(() => expect(api.streams[0]!.signal?.aborted).toBe(true));
  });

  it("con before non nullo offre «Load earlier» e chiede ?before=<valore>", async () => {
    const OLDER = {
      events: [{ id: "50", type: "assistant_text", segmentId: "s0", at: at(600), data: { text: "Older words" } }],
      before: null,
    };
    const api = baseApi({
      [`GET ${EVENTS_PATH}`]: (url) =>
        url.searchParams.get("before") === "101"
          ? jsonResponse(200, OLDER)
          : jsonResponse(200, { ...FIRST_PAGE, before: "101" }),
    });
    mockApi(api.handlers);
    renderSession();

    await userEvent.click(await screen.findByRole("button", { name: "Load earlier" }));
    expect(await screen.findByText("Older words")).toBeInTheDocument();
    expect(callsTo(EVENTS_PATH).map((c) => c.url.searchParams.get("before"))).toEqual([null, "101"]);
    expect(screen.queryByRole("button", { name: "Load earlier" })).not.toBeInTheDocument();
    // Lo stream non riparte per caricare il passato.
    expect(api.streams).toHaveLength(1);
  });

  it("un dettaglio del solo piano A (senza questions, inputs, canWrite) non fa lanciare la pagina", async () => {
    const legacy: Record<string, unknown> = { ...LIVE_DETAIL };
    for (const field of ["questions", "inputs", "canWrite", "canInterrupt"]) delete legacy[field];
    const api = baseApi({ [`GET ${DETAIL_PATH}`]: () => jsonResponse(200, legacy) });
    mockApi(api.handlers);
    renderSession();
    expect(await screen.findByRole("heading", { name: "Fix the login bug" })).toBeInTheDocument();
    // Il testo viene dalla query degli eventi, che parte dopo il dettaglio:
    // sotto carico può arrivare dopo l'intestazione, quindi si aspetta.
    expect(await screen.findByText("router", {}, { timeout: 5000 })).toBeInTheDocument();
  });

  it("mostra interventi (anche non consegnati, col motivo), interruzioni e segmenti falliti", async () => {
    const api = baseApi({
      [`GET ${DETAIL_PATH}`]: () =>
        jsonResponse(200, {
          ...LIVE_DETAIL,
          inputs: [
            {
              id: INPUT_ID,
              text: "Please also update the docs",
              status: "undelivered",
              reason: "stdin_closed",
              authorUserId: null,
              authorName: "max@example.com",
              interrupt: false,
              createdAt: at(20),
            },
          ],
        }),
      [`GET ${EVENTS_PATH}`]: () =>
        jsonResponse(200, {
          events: [
            ...FIRST_PAGE.events,
            { id: "105", type: "turn_end", segmentId: "s1", at: at(25), data: { subtype: "error_during_execution" } },
            { id: "106", type: "segment_end", segmentId: "s1", at: at(10), data: { exitCode: 1, timedOut: false } },
            { id: "107", type: "mystery_event", segmentId: "s1", at: at(9), data: { text: "should not render" } },
          ],
          before: null,
        }),
    });
    mockApi(api.handlers);
    renderSession();

    // Il dettaglio (con l'intervento) può arrivare prima della pagina di eventi.
    expect(await screen.findByText("Stopped by a maintainer")).toBeInTheDocument();
    expect(screen.getByText("Please also update the docs")).toBeInTheDocument();
    expect(screen.getByText("max@example.com")).toBeInTheDocument();
    expect(screen.getByText(/not delivered/)).toBeInTheDocument();
    expect(screen.getByText(/the agent no longer accepted messages/)).toBeInTheDocument();
    expect(screen.getByText("The step ended with an error")).toBeInTheDocument();
    expect(screen.queryByText("should not render")).not.toBeInTheDocument();
  });

  it("una sessione conclusa non apre lo stream; un refetch che la riporta viva lo apre", async () => {
    let detail: Record<string, unknown> = { ...LIVE_DETAIL, state: "ended", outcome: "failed" };
    const api = baseApi({ [`GET ${DETAIL_PATH}`]: () => jsonResponse(200, detail) });
    mockApi(api.handlers);
    const { queryClient } = renderSession();

    expect(await screen.findByText("failed")).toBeInTheDocument();
    expect(await screen.findByText("router")).toBeInTheDocument();
    expect(callsTo(STREAM_PATH)).toHaveLength(0);

    detail = LIVE_DETAIL;
    await queryClient.invalidateQueries({ queryKey: agentSessionKeys.detail(SESSION_ID) });
    await waitFor(() => expect(api.streams).toHaveLength(1));
    expect(api.streams[0]!.url.searchParams.get("after")).toBe("104");
  });

  it("una sessione che torna viva dopo «ended» riapre lo stream da sola, senza focus (chat del backlog fra due turni)", async () => {
    // Fake timer che avanzano anche da soli: le promesse e i findBy restano
    // normali, e il polling del dettaglio si fa scattare a mano.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      let detail: Record<string, unknown> = LIVE_DETAIL;
      const api = baseApi({ [`GET ${DETAIL_PATH}`]: () => jsonResponse(200, detail) });
      mockApi(api.handlers);
      renderSession();
      await waitFor(() => expect(api.streams).toHaveLength(1));

      // Fine del turno: il frame `session` la dà conclusa, lo stream si chiude.
      detail = { ...LIVE_DETAIL, state: "ended", activeSegment: null, outcome: "completed" };
      api.streams[0]!.stream.push({ type: "session", detail });
      await waitFor(() => expect(api.streams[0]!.signal?.aborted).toBe(true));
      const readsWhileEnded = callsTo(DETAIL_PATH).length;

      // Il worker prende il turno successivo: nessun focus, nessuna invalidazione.
      detail = LIVE_DETAIL;
      await vi.advanceTimersByTimeAsync(10_000);
      await waitFor(() => expect(api.streams).toHaveLength(2));
      expect(callsTo(DETAIL_PATH).length).toBeGreaterThan(readsWhileEnded);
      expect(api.streams[1]!.url.searchParams.get("after")).toBe("104");
    } finally {
      vi.useRealTimers();
    }
  });

  it("chiude lo stream allo smontaggio", async () => {
    const api = baseApi();
    mockApi(api.handlers);
    const { view } = renderSession();
    await waitFor(() => expect(api.streams).toHaveLength(1));
    expect(api.streams[0]!.signal?.aborted).toBe(false);
    view.unmount();
    expect(api.streams[0]!.signal?.aborted).toBe(true);
  });

  it("server senza le rotte (404 senza code): «non disponibile», non «non trovata», e niente retry", async () => {
    const api = baseApi({ [`GET ${DETAIL_PATH}`]: () => jsonResponse(404, { message: "Route not found" }) });
    mockApi(api.handlers);
    renderSession();
    expect(
      await screen.findByText("Agent sessions are not available on this instance."),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Session not found/)).not.toBeInTheDocument();
    expect(callsTo(STREAM_PATH)).toHaveLength(0);
    expect(callsTo(DETAIL_PATH).length).toBeLessThanOrEqual(2);
  });

  it("404 not_found: «Sessione non trovata», senza riprovare", async () => {
    const api = baseApi({
      [`GET ${DETAIL_PATH}`]: () => jsonResponse(404, { code: "not_found", message: "not found" }),
    });
    mockApi(api.handlers);
    renderSession();
    expect(await screen.findByText("Session not found (or not visible to you).")).toBeInTheDocument();
    expect(screen.queryByText(/not available on this instance/)).not.toBeInTheDocument();
    // Al più il loader e il montaggio del componente: un 4xx non si riprova
    // (con i 3 retry di default sarebbero almeno 4 letture).
    expect(callsTo(DETAIL_PATH).length).toBeLessThanOrEqual(2);
  });

  it("alla fine della sessione recupera gli eventi finali che lo stream non ha consegnato e azzera i parziali", async () => {
    const FINAL = {
      id: "105",
      type: "assistant_text",
      segmentId: "s1",
      at: at(1),
      data: { text: "All done, PR opened" },
    };
    const api = baseApi({
      // Il server ha già scritto l'evento finale, ma lo stream non lo manderà mai.
      [`GET ${EVENTS_PATH}`]: (url) => jsonResponse(200, pageAfter([...FIRST_PAGE.events, FINAL], url)),
    });
    // La prima pagina REST è stata letta PRIMA dell'evento finale.
    let firstRead = true;
    const handler = api.handlers[`GET ${EVENTS_PATH}`]!;
    api.handlers[`GET ${EVENTS_PATH}`] = (url, init) => {
      if (firstRead) {
        firstRead = false;
        return jsonResponse(200, FIRST_PAGE);
      }
      return handler(url, init);
    };
    mockApi(api.handlers);
    renderSession();
    await waitFor(() => expect(api.streams).toHaveLength(1));
    const { stream } = api.streams[0]!;

    stream.push({ type: "partial", segmentId: "s1", text: "All do" });
    expect(await screen.findByText("All do")).toBeInTheDocument();
    stream.push({
      type: "session",
      detail: { ...LIVE_DETAIL, state: "ended", activeSegment: null, outcome: "completed" },
    });

    expect(await screen.findByText("All done, PR opened")).toBeInTheDocument();
    expect(screen.queryByText("All do")).not.toBeInTheDocument();
    expect(callsTo(EVENTS_PATH).map((c) => c.url.searchParams.get("after"))).toEqual([null, "104"]);
  });

  it("un recupero finale fallito non cancella l'ultimo testo dal vivo", async () => {
    const api = baseApi();
    let firstRead = true;
    api.handlers[`GET ${EVENTS_PATH}`] = () => {
      if (firstRead) {
        firstRead = false;
        return jsonResponse(200, FIRST_PAGE);
      }
      return jsonResponse(500, { message: "boom" });
    };
    mockApi(api.handlers);
    renderSession();
    await waitFor(() => expect(api.streams).toHaveLength(1));
    const { stream } = api.streams[0]!;

    stream.push({ type: "partial", segmentId: "s1", text: "All do" });
    expect(await screen.findByText("All do")).toBeInTheDocument();
    stream.push({
      type: "session",
      detail: { ...LIVE_DETAIL, state: "ended", activeSegment: null, outcome: "completed" },
    });

    await waitFor(() => expect(callsTo(EVENTS_PATH)).toHaveLength(2));
    // Lascia completare il recupero (risposta 500 → catch → eventuale finally).
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(screen.getByText("All do")).toBeInTheDocument();
  });

  it("una card di tool senza risultato non resta «in corso» in una sessione conclusa", async () => {
    const pending = FIRST_PAGE.events.slice(0, 3); // tool_use senza tool_result
    const api = baseApi({
      [`GET ${DETAIL_PATH}`]: () => jsonResponse(200, { ...LIVE_DETAIL, state: "ended", outcome: "failed" }),
      [`GET ${EVENTS_PATH}`]: (url) => jsonResponse(200, pageAfter(pending, url)),
    });
    mockApi(api.handlers);
    renderSession();
    const card = await screen.findByRole("button", { name: /Edit file routes\/tickets\.ts/ });
    expect(card.closest("section")).not.toHaveTextContent("…");
  });

  it("mentre lo stream si riconnette lo dice", async () => {
    const api = baseApi();
    mockApi(api.handlers);
    renderSession();
    await waitFor(() => expect(api.streams).toHaveLength(1));
    expect(screen.queryByText("Reconnecting…")).not.toBeInTheDocument();
    api.streams[0]!.stream.close();
    expect(await screen.findByText("Reconnecting…")).toBeInTheDocument();
  });

  it("uno stream che risponde 404 a metà rilegge il dettaglio e mostra «non trovata»", async () => {
    let gone = false;
    const api = baseApi({
      [`GET ${DETAIL_PATH}`]: () =>
        gone ? jsonResponse(404, { code: "not_found", message: "not found" }) : jsonResponse(200, LIVE_DETAIL),
    });
    const streamHandler = api.handlers[`GET ${STREAM_PATH}`]!;
    api.handlers[`GET ${STREAM_PATH}`] = (url, init) => {
      if (api.streams.length === 0) return streamHandler(url, init);
      return jsonResponse(404, { code: "not_found", message: "not found" });
    };
    mockApi(api.handlers);
    renderSession();
    await waitFor(() => expect(api.streams).toHaveLength(1));
    gone = true;
    api.streams[0]!.stream.close(); // caduta → riconnessione → 404
    expect(
      await screen.findByText("Session not found (or not visible to you).", undefined, { timeout: 3000 }),
    ).toBeInTheDocument();
  });
});

/** Task 7: scrivere all'agente e rispondere alle sue domande dalla sessione. */
describe("/agents/$id — scrivere e rispondere", () => {
  const QUESTION_ID = "44444444-4444-4444-8444-444444444444";
  const QUESTION_ID_2 = "55555555-5555-4555-8555-555555555555";
  const BACKLOG_ITEM_ID = "66666666-6666-4666-8666-666666666666";
  const MESSAGES_PATH = `${DETAIL_PATH}/messages`;
  const FIELD = { name: "Write to the agent…" };

  const OPTIONS = [
    { label: "Keep the old API", consequence: "Nothing changes for callers" },
    { label: "Move to v2" },
  ];

  function agentQuestion(overrides: Record<string, unknown> = {}) {
    return {
      id: QUESTION_ID,
      source: "agent",
      question: "Which API should the fix target?",
      askedAt: at(45),
      answered: false,
      round: 1,
      options: OPTIONS,
      allowFreeText: false,
      canAnswer: true,
      ticketId: TICKET_ID,
      backlogItemId: null,
      ...overrides,
    };
  }

  function pendingInput(status: string, reason: string | null) {
    return {
      id: INPUT_ID,
      text: "Use the v2 API instead",
      status,
      reason,
      authorUserId: null,
      authorName: "ada@example.com",
      interrupt: false,
      createdAt: at(1),
    };
  }

  async function waitForPage() {
    expect(await screen.findByRole("heading", { name: "Fix the login bug" })).toBeInTheDocument();
    // Il dettaglio è arrivato: da qui l'assenza del campo è una decisione, non un caricamento.
    await waitFor(() => expect(callsTo(EVENTS_PATH).length).toBeGreaterThan(0));
  }

  it("due ruoli sugli stessi dati: il campo segue canWrite del server, non il ruolo (in entrambi i versi)", async () => {
    // Admin, ma il server dice canWrite: false → niente campo.
    let api = baseApi({ [`GET ${DETAIL_PATH}`]: () => jsonResponse(200, { ...LIVE_DETAIL, canWrite: false }) });
    mockApi(api.handlers);
    renderSession();
    await waitForPage();
    expect(screen.queryByRole("textbox", FIELD)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Send" })).not.toBeInTheDocument();

    cleanup();
    fetchMock.mockReset();

    // Member, ma il server dice canWrite: true → il campo c'è (il client non fa canWrite && isAdmin).
    api = baseApi({
      "GET /api/auth/me": meHandler("member"),
      [`GET ${DETAIL_PATH}`]: () => jsonResponse(200, { ...LIVE_DETAIL, canWrite: true }),
    });
    mockApi(api.handlers);
    renderSession();
    expect(await screen.findByRole("textbox", FIELD)).toBeInTheDocument();
  });

  it("«Ferma e scrivi» c'è solo con canInterrupt, e manda interrupt: true", async () => {
    let api = baseApi({
      [`GET ${DETAIL_PATH}`]: () => jsonResponse(200, { ...LIVE_DETAIL, canWrite: true, canInterrupt: false }),
    });
    mockApi(api.handlers);
    renderSession();
    expect(await screen.findByRole("textbox", FIELD)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Send" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Stop and send" })).not.toBeInTheDocument();

    cleanup();
    fetchMock.mockReset();

    api = baseApi({
      [`GET ${DETAIL_PATH}`]: () => jsonResponse(200, { ...LIVE_DETAIL, canWrite: true, canInterrupt: true }),
      [`POST ${MESSAGES_PATH}`]: () => jsonResponse(202, { inputId: INPUT_ID, status: "pending" }),
    });
    mockApi(api.handlers);
    renderSession();
    await userEvent.type(await screen.findByRole("textbox", FIELD), "Stop, wrong file");
    await userEvent.click(screen.getByRole("button", { name: "Stop and send" }));
    await waitFor(() => expect(callsTo(MESSAGES_PATH)).toHaveLength(1));
    expect(JSON.parse(String(callsTo(MESSAGES_PATH)[0]!.init?.body))).toEqual({
      text: "Stop, wrong file",
      interrupt: true,
    });
  });

  it("testo vuoto o di soli spazi: bottoni spenti; tetto di 4000 caratteri", async () => {
    const api = baseApi({
      [`GET ${DETAIL_PATH}`]: () => jsonResponse(200, { ...LIVE_DETAIL, canWrite: true, canInterrupt: true }),
    });
    mockApi(api.handlers);
    renderSession();
    const field = await screen.findByRole("textbox", FIELD);
    expect(field).toHaveAttribute("maxLength", "4000");
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Stop and send" })).toBeDisabled();
    await userEvent.type(field, "   ");
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Stop and send" })).toBeDisabled();
    await userEvent.type(field, "ok");
    expect(screen.getByRole("button", { name: "Send" })).toBeEnabled();
  });

  it("piano: l'intervento compare in consegna, poi resta visibile «non consegnato» col motivo (stdin chiuso dopo il primo result)", async () => {
    let inputs: unknown[] = [];
    const planDetail = () => ({ ...LIVE_DETAIL, activeSegment: "plan", canWrite: true, inputs });
    const api = baseApi({
      [`GET ${DETAIL_PATH}`]: () => jsonResponse(200, planDetail()),
      [`POST ${MESSAGES_PATH}`]: () => {
        inputs = [pendingInput("pending", null)];
        return jsonResponse(202, { inputId: INPUT_ID, status: "pending" });
      },
    });
    mockApi(api.handlers);
    renderSession();
    await waitFor(() => expect(api.streams).toHaveLength(1));

    const field = await screen.findByRole("textbox", FIELD);
    await userEvent.type(field, "Use the v2 API instead");
    await userEvent.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => expect(callsTo(MESSAGES_PATH)).toHaveLength(1));
    expect(JSON.parse(String(callsTo(MESSAGES_PATH)[0]!.init?.body))).toEqual({
      text: "Use the v2 API instead",
      interrupt: false,
    });
    // Subito in consegna (dal dettaglio riletto), e il campo si svuota.
    expect(await screen.findByText("delivering…")).toBeInTheDocument();
    expect(screen.getByText("Use the v2 API instead")).toBeInTheDocument();
    expect(field).toHaveValue("");

    // Il relay lo rifiuta: il piano aveva già dato il primo result.
    inputs = [pendingInput("undelivered", "stdin_closed")];
    api.streams[0]!.stream.push({ type: "session", detail: planDetail() });
    expect(await screen.findByText(/not delivered — the agent no longer accepted messages/)).toBeInTheDocument();
    expect(screen.getByText("Use the v2 API instead")).toBeInTheDocument();
    expect(screen.queryByText("delivering…")).not.toBeInTheDocument();
  });

  it.each([
    [409, "session_ended", "The session is no longer active"],
    [409, "not_interactive", "This step does not accept messages"],
    [409, "interrupt_unsupported", "This agent cannot be interrupted"],
    [403, "forbidden", "Maintainers only"],
    [404, "not_found", "Not found"],
  ])("POST %i %s: messaggio tradotto, il testo resta nel campo", async (status, code, message) => {
    const api = baseApi({
      [`GET ${DETAIL_PATH}`]: () => jsonResponse(200, { ...LIVE_DETAIL, canWrite: true }),
      [`POST ${MESSAGES_PATH}`]: () => jsonResponse(status, { code, message: "server words" }),
    });
    mockApi(api.handlers);
    renderSession();
    const field = await screen.findByRole("textbox", FIELD);
    await userEvent.type(field, "Please also update the docs");
    await userEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(await screen.findByText(message)).toBeInTheDocument();
    expect(screen.queryByText("server words")).not.toBeInTheDocument();
    expect(field).toHaveValue("Please also update the docs");
  });

  it.each([
    ["session_ended", "The session is no longer active", { state: "ended", activeSegment: null, outcome: "completed" }],
    ["not_interactive", "This step does not accept messages", { activeSegment: "review" }],
  ])(
    "409 %s col server vero (canWrite diventa false): il campo sparisce ma messaggio e testo restano visibili",
    async (code, message, after) => {
      let detail: Record<string, unknown> = { ...LIVE_DETAIL, canWrite: true };
      const api = baseApi({
        [`GET ${DETAIL_PATH}`]: () => jsonResponse(200, detail),
        [`POST ${MESSAGES_PATH}`]: () => {
          detail = { ...LIVE_DETAIL, ...after, canWrite: false, canInterrupt: false };
          return jsonResponse(409, { code, message: "server words" });
        },
      });
      mockApi(api.handlers);
      renderSession();
      await userEvent.type(await screen.findByRole("textbox", FIELD), "Please also update the docs");
      await userEvent.click(screen.getByRole("button", { name: "Send" }));
      // Il dettaglio riletto toglie il campo...
      await waitFor(() => expect(screen.queryByRole("textbox", FIELD)).not.toBeInTheDocument());
      // ...ma non quello che si era scritto, né il perché non è partito.
      expect(screen.getByText(new RegExp(message))).toBeInTheDocument();
      expect(screen.getByText("Please also update the docs")).toBeInTheDocument();
    },
  );

  it("dopo l'invio il bottone resta occupato finché il dettaglio riletto non mostra la bolla; poi campo vuoto e focus", async () => {
    let inputs: unknown[] = [];
    let release: (() => void) | null = null;
    const api = baseApi({
      [`GET ${DETAIL_PATH}`]: async () => {
        if (inputs.length > 0) await new Promise<void>((resolve) => (release = resolve));
        return jsonResponse(200, { ...LIVE_DETAIL, canWrite: true, inputs });
      },
      [`POST ${MESSAGES_PATH}`]: () => {
        inputs = [pendingInput("pending", null)];
        return jsonResponse(202, { inputId: INPUT_ID, status: "pending" });
      },
    });
    mockApi(api.handlers);
    renderSession();
    const field = await screen.findByRole("textbox", FIELD);
    await userEvent.type(field, "Use the v2 API instead");
    await userEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(release).not.toBeNull());
    // Il messaggio non è mai «da nessuna parte»: è ancora nel campo, e non si rimanda.
    expect(field).toHaveValue("Use the v2 API instead");
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
    // In quella finestra il campo è in sola lettura: un testo scritto ora
    // verrebbe cancellato a rilettura finita.
    expect(field).toHaveAttribute("readonly");
    await userEvent.type(field, " and more");
    expect(field).toHaveValue("Use the v2 API instead");
    release!();
    expect(await screen.findByText("delivering…")).toBeInTheDocument();
    await waitFor(() => expect(field).toHaveValue(""));
    expect(field).toHaveFocus();
    expect(callsTo(MESSAGES_PATH)).toHaveLength(1);
  });

  it("«Ferma e scrivi» in corso: il bottone è spento e dice che sta fermando", async () => {
    let release: (() => void) | null = null;
    const api = baseApi({
      [`GET ${DETAIL_PATH}`]: () => jsonResponse(200, { ...LIVE_DETAIL, canWrite: true, canInterrupt: true }),
      [`POST ${MESSAGES_PATH}`]: async () => {
        await new Promise<void>((resolve) => (release = resolve));
        return jsonResponse(202, { inputId: INPUT_ID, status: "pending" });
      },
    });
    mockApi(api.handlers);
    renderSession();
    await userEvent.type(await screen.findByRole("textbox", FIELD), "Stop, wrong file");
    await userEvent.click(screen.getByRole("button", { name: "Stop and send" }));
    await waitFor(() => expect(release).not.toBeNull());
    const stopping = await screen.findByRole("button", { name: "Stopping…" });
    expect(stopping).toBeDisabled();
    expect(stopping).toHaveAttribute("aria-busy", "true");
    expect(screen.queryByRole("button", { name: "Stop and send" })).not.toBeInTheDocument();
    // «Send» resta com'è (spento): l'invio in corso è l'altro.
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
    release!();
    expect(await screen.findByRole("button", { name: "Stop and send" })).toBeInTheDocument();
  });

  it("il suggerimento su «Ferma e scrivi» c'è solo con canInterrupt", async () => {
    const hint = "The message reaches the agent when the current action finishes.";
    const interruptHint = "“Stop and send” interrupts first.";
    let api = baseApi({
      [`GET ${DETAIL_PATH}`]: () => jsonResponse(200, { ...LIVE_DETAIL, canWrite: true, canInterrupt: false }),
    });
    mockApi(api.handlers);
    renderSession();
    expect(await screen.findByText(hint)).toBeInTheDocument();
    expect(screen.queryByText(interruptHint)).not.toBeInTheDocument();
    cleanup();
    fetchMock.mockReset();
    api = baseApi({
      [`GET ${DETAIL_PATH}`]: () => jsonResponse(200, { ...LIVE_DETAIL, canWrite: true, canInterrupt: true }),
    });
    mockApi(api.handlers);
    renderSession();
    expect(await screen.findByText(interruptHint)).toBeInTheDocument();
  });

  it("riga di sola lettura: solo con un segmento vivo NON interattivo (INTERACTIVE_SEGMENTS)", async () => {
    const cases: [unknown, boolean][] = [
      ["review", true],
      ["mystery_segment", true],
      ["execute", false],
      [null, false],
    ];
    for (const [activeSegment, shown] of cases) {
      const api = baseApi({
        [`GET ${DETAIL_PATH}`]: () => jsonResponse(200, { ...LIVE_DETAIL, canWrite: false, activeSegment }),
      });
      mockApi(api.handlers);
      renderSession();
      await waitForPage();
      if (shown) {
        expect(await screen.findByText("This step can only be watched.")).toBeInTheDocument();
      } else {
        expect(screen.queryByText("This step can only be watched.")).not.toBeInTheDocument();
      }
      expect(screen.queryByRole("textbox", FIELD)).not.toBeInTheDocument();
      cleanup();
      fetchMock.mockReset();
    }
  });

  it("domanda dell'agente aperta con canAnswer: risponde con la rotta del ticket e rilegge il dettaglio", async () => {
    const api = baseApi({
      [`GET ${DETAIL_PATH}`]: () => jsonResponse(200, { ...LIVE_DETAIL, questions: [agentQuestion()] }),
      [`POST /api/tickets/${TICKET_ID}/questions/answer`]: () =>
        jsonResponse(200, { jobId: LIVE_DETAIL.aiJobId, questionId: QUESTION_ID }),
    });
    mockApi(api.handlers);
    const { queryClient } = renderSession();
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");

    expect(await screen.findByText("Which API should the fix target?")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("radio", { name: /Keep the old API/ }));
    const detailReads = callsTo(DETAIL_PATH).length;
    await userEvent.click(screen.getByRole("button", { name: "Send answer" }));

    await waitFor(() => expect(callsTo(`/api/tickets/${TICKET_ID}/questions/answer`)).toHaveLength(1));
    expect(JSON.parse(String(callsTo(`/api/tickets/${TICKET_ID}/questions/answer`)[0]!.init?.body))).toEqual({
      optionIndex: 0,
      questionId: QUESTION_ID,
    });
    await waitFor(() => expect(callsTo(DETAIL_PATH).length).toBeGreaterThan(detailReads));
    const keys = invalidate.mock.calls.map(([filters]) => filters?.queryKey);
    expect(keys).toContainEqual(agentSessionKeys.detail(SESSION_ID));
    expect(keys).toContainEqual(ticketKeys.questions(TICKET_ID));
    expect(keys).toContainEqual(inboxKeys.all);
  });

  it("domanda aperta senza canAnswer, domanda già risposta e domanda di un server del piano A: solo testo", async () => {
    const legacy: Record<string, unknown> = {
      id: QUESTION_ID_2,
      source: "agent",
      question: "Legacy question without options",
      askedAt: at(44),
      answered: false,
    };
    const api = baseApi({
      [`GET ${DETAIL_PATH}`]: () =>
        jsonResponse(200, {
          ...LIVE_DETAIL,
          questions: [agentQuestion({ canAnswer: false }), legacy],
        }),
    });
    mockApi(api.handlers);
    renderSession();
    expect(await screen.findByText("Which API should the fix target?")).toBeInTheDocument();
    expect(screen.getByText("Legacy question without options")).toBeInTheDocument();
    expect(screen.queryByRole("radio")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Send answer" })).not.toBeInTheDocument();

    cleanup();
    fetchMock.mockReset();

    const answered = baseApi({
      [`GET ${DETAIL_PATH}`]: () =>
        jsonResponse(200, { ...LIVE_DETAIL, questions: [agentQuestion({ answered: true })] }),
    });
    mockApi(answered.handlers);
    renderSession();
    expect(await screen.findByText("Which API should the fix target?")).toBeInTheDocument();
    expect(screen.getByText(/Answered/)).toBeInTheDocument();
    expect(screen.queryByRole("radio")).not.toBeInTheDocument();
  });

  it("domanda di backlog: risponde con la rotta della voce di backlog", async () => {
    const path = `/api/backlog/${BACKLOG_ITEM_ID}/questions/${QUESTION_ID}/answer`;
    const api = baseApi({
      [`GET ${DETAIL_PATH}`]: () =>
        jsonResponse(200, {
          ...LIVE_DETAIL,
          kind: "backlog_item",
          ticketId: null,
          ticketNumber: null,
          questions: [agentQuestion({ source: "backlog", ticketId: null, backlogItemId: BACKLOG_ITEM_ID })],
        }),
      [`POST ${path}`]: () => jsonResponse(200, { backlogItemId: BACKLOG_ITEM_ID }),
    });
    mockApi(api.handlers);
    const { queryClient } = renderSession();
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    await userEvent.click(await screen.findByRole("radio", { name: /Move to v2/ }));
    await userEvent.click(screen.getByRole("button", { name: "Send answer" }));
    await waitFor(() => expect(callsTo(path)).toHaveLength(1));
    expect(JSON.parse(String(callsTo(path)[0]!.init?.body))).toEqual({ optionIndex: 1 });
    await waitFor(() => {
      const keys = invalidate.mock.calls.map(([filters]) => filters?.queryKey);
      expect(keys).toContainEqual(backlogKeys.detail(BACKLOG_ITEM_ID));
      expect(keys).toContainEqual(agentSessionKeys.detail(SESSION_ID));
      expect(keys).toContainEqual(inboxKeys.all);
    });
  });

  it("#question: la prima domanda aperta porta id=question e la vista ci scorre", async () => {
    const scroll = vi.fn();
    const original = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = scroll;
    try {
      const api = baseApi({
        [`GET ${DETAIL_PATH}`]: () =>
          jsonResponse(200, {
            ...LIVE_DETAIL,
            questions: [
              agentQuestion({ id: QUESTION_ID_2, question: "Old one", answered: true, askedAt: at(55) }),
              agentQuestion(),
            ],
          }),
      });
      mockApi(api.handlers);
      renderSession(`/agents/${SESSION_ID}#question`);
      const text = await screen.findByText("Which API should the fix target?");
      const anchor = text.closest("#question");
      expect(anchor).not.toBeNull();
      expect(document.querySelectorAll("#question")).toHaveLength(1);
      await waitFor(() => expect(scroll.mock.contexts).toContain(anchor));
    } finally {
      Element.prototype.scrollIntoView = original;
    }
  });

  it("#question: con il dettaglio pronto PRIMA degli eventi, scorre solo dopo la prima pagina", async () => {
    // Visto nel browser: la domanda veniva disegnata da sola (gli eventi non
    // c'erano ancora), lo scroll scattava a vuoto e si segnava come fatto, poi
    // la prima pagina la spingeva migliaia di pixel più in basso.
    // Per ogni scroll si annota se la prima pagina era già nella vista: lo
    // scroll del router per l'hash scatta comunque alla risoluzione della
    // rotta, quello che conta è che la vista ne faccia uno DOPO gli eventi.
    const withEvents: boolean[] = [];
    const scroll = vi.fn(function (this: Element) {
      withEvents.push(document.body.textContent?.includes("Looking at the") ?? false);
    });
    const original = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = scroll;
    let release: () => void = () => {};
    try {
      const api = baseApi({
        [`GET ${DETAIL_PATH}`]: () =>
          jsonResponse(200, { ...LIVE_DETAIL, questions: [agentQuestion()] }),
      });
      const eventsHandler = api.handlers[`GET ${EVENTS_PATH}`]!;
      api.handlers[`GET ${EVENTS_PATH}`] = async (url, init) => {
        await new Promise<void>((resolve) => (release = resolve));
        return eventsHandler(url, init);
      };
      mockApi(api.handlers);
      renderSession(`/agents/${SESSION_ID}#question`);
      await screen.findByText("Which API should the fix target?");
      await waitFor(() => expect(callsTo(EVENTS_PATH)).toHaveLength(1));

      release();
      await screen.findByText(/Looking at the/);
      const anchor = document.getElementById("question");
      await waitFor(() => expect(withEvents).toContain(true));
      expect(scroll.mock.contexts.at(-1)).toBe(anchor);
      expect(withEvents.filter(Boolean)).toHaveLength(1);
    } finally {
      Element.prototype.scrollIntoView = original;
    }
  });

  it("#question: se la domanda arriva DOPO il caricamento (frame session), la vista ci scorre allora", async () => {
    // Lo scroll del router per l'hash scatta una volta sola, alla risoluzione
    // della rotta: una domanda che compare dopo la raggiunge solo la vista.
    const scroll = vi.fn();
    const original = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = scroll;
    try {
      const api = baseApi();
      mockApi(api.handlers);
      renderSession(`/agents/${SESSION_ID}#question`);
      await waitFor(() => expect(api.streams).toHaveLength(1));
      expect(document.getElementById("question")).toBeNull();
      expect(scroll).not.toHaveBeenCalled();

      api.streams[0]!.stream.push({ type: "session", detail: { ...LIVE_DETAIL, questions: [agentQuestion()] } });
      const text = await screen.findByText("Which API should the fix target?");
      const anchor = text.closest("#question");
      expect(anchor).not.toBeNull();
      await waitFor(() => expect(scroll.mock.contexts).toEqual([anchor]));
    } finally {
      Element.prototype.scrollIntoView = original;
    }
  });
});

/**
 * R3: dopo il parse del client i campi additivi ci sono sempre (i `.default`),
 * quindi la difesa `??` del web si prova SOLO dando ai componenti un oggetto
 * che non è passato da nessun parse.
 */
describe("componenti della sessione con un oggetto senza i campi additivi", () => {
  async function renderInRouter(node: React.ReactNode) {
    const rootRoute = createRootRoute({ component: () => <>{node}</> });
    const router = createRouter({
      routeTree: rootRoute,
      history: createMemoryHistory({ initialEntries: ["/"] }),
    });
    render(<RouterProvider router={router} />);
    await router.load();
  }

  it("intestazione e trascrizione non lanciano senza outcome, lastActivity, inputs, questions", async () => {
    const legacy = {
      id: SESSION_ID,
      kind: "pr_review",
      title: "Legacy review",
      projectId: null,
      projectName: null,
      ticketId: null,
      ticketNumber: null,
      startedAt: at(600),
      lastEventAt: null,
      state: "ended",
    };
    const items = buildTranscript({
      events: FIRST_PAGE.events as never,
      partials: {},
      inputs: undefined as never,
      questions: undefined as never,
    });
    await renderInRouter(
      <>
        <SessionHeader detail={legacy as never} now={NOW} />
        <Transcript items={items} />
      </>,
    );
    expect(await screen.findByRole("heading", { name: "Legacy review" })).toBeInTheDocument();
    expect(screen.getByText("ended")).toBeInTheDocument();
    expect(screen.getByText("router")).toBeInTheDocument();
  });
});
