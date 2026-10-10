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
    expect(screen.getByText("not delivered")).toBeInTheDocument();
    expect(screen.getByText("The agent had just finished this step: send it again now")).toBeInTheDocument();
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

  it("fra un segmento e l'altro (canWrite falso, canIntervene vero) il campo resta lo stesso, col focus, in sola lettura", async () => {
    const api = baseApi({
      [`GET ${DETAIL_PATH}`]: () =>
        jsonResponse(200, { ...LIVE_DETAIL, canWrite: true, canIntervene: true }),
    });
    mockApi(api.handlers);
    renderSession();
    const field = await screen.findByRole("textbox", FIELD);
    await waitFor(() => expect(api.streams).toHaveLength(1));
    await userEvent.type(field, "Also check");
    expect(field).toHaveFocus();

    // Fine della ripresa del piano, prima dell'esecuzione: nessun segmento aperto.
    api.streams[0]!.stream.push({
      type: "session",
      detail: { ...LIVE_DETAIL, activeSegment: null, canWrite: false, canIntervene: true },
    });
    expect(await screen.findByText("The agent is moving on to the next step…")).toBeInTheDocument();
    // Lo STESSO nodo: niente smontaggio, quindi niente focus perso né testo perso.
    expect(screen.getByRole("textbox", FIELD)).toBe(field);
    expect(field).toHaveFocus();
    expect(field).toHaveAttribute("readonly");
    expect(field).not.toBeDisabled();
    expect(field).toHaveValue("Also check");
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();

    // Parte l'esecuzione: si torna a scrivere, sempre nello stesso campo.
    api.streams[0]!.stream.push({
      type: "session",
      detail: { ...LIVE_DETAIL, activeSegment: "execute", canWrite: true, canIntervene: true },
    });
    await waitFor(() => expect(field).not.toHaveAttribute("readonly"));
    expect(screen.getByRole("textbox", FIELD)).toBe(field);
    expect(field).toHaveFocus();
    expect(screen.queryByText("The agent is moving on to the next step…")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Send" })).toBeEnabled();
  });

  it("in sola lettura niente suggerimento sull'invio: la riga del perché descrive il campo, senza essere un annuncio", async () => {
    const HINT = "The message reaches the agent when the current action finishes.";
    const BETWEEN = "The agent is moving on to the next step…";
    const api = baseApi({
      [`GET ${DETAIL_PATH}`]: () =>
        jsonResponse(200, { ...LIVE_DETAIL, canWrite: true, canIntervene: true }),
    });
    mockApi(api.handlers);
    renderSession();
    const field = await screen.findByRole("textbox", FIELD);
    expect(screen.getByText(HINT)).toBeInTheDocument();
    await waitFor(() => expect(api.streams).toHaveLength(1));

    api.streams[0]!.stream.push({
      type: "session",
      detail: { ...LIVE_DETAIL, activeSegment: null, canWrite: false, canIntervene: true },
    });
    expect(await screen.findByText(BETWEEN)).toBeInTheDocument();
    // «Arriva all'agente quando…» sotto un invio spento sarebbe una promessa falsa.
    expect(screen.queryByText(HINT)).not.toBeInTheDocument();
    // Chi arriva sul campo sente perché non scrive; nessuna regione viva che
    // riannunci la riga a ogni passaggio di segmento. (La sola regione viva
    // accanto al campo è quella della pausa, sempre montata e qui vuota.)
    expect(field).toHaveAccessibleDescription(BETWEEN);
    for (const region of screen.queryAllByRole("status")) {
      expect(region).not.toHaveTextContent(BETWEEN);
      expect(region.textContent).toBe("");
    }

    api.streams[0]!.stream.push({
      type: "session",
      detail: { ...LIVE_DETAIL, activeSegment: "execute", canWrite: true, canIntervene: true },
    });
    expect(await screen.findByText(HINT)).toBeInTheDocument();
    expect(field).not.toHaveAccessibleDescription(BETWEEN);
  });

  it("due ruoli sugli stessi dati: la riga del maintainer segue canIntervene del server, non il ruolo", async () => {
    // Un passo interattivo vivo su cui chi guarda non può scrivere.
    const stepData = { ...LIVE_DETAIL, activeSegment: "execute", canWrite: false };

    // Admin, ma il server dice canIntervene: false → la riga, nessun campo.
    let api = baseApi({
      [`GET ${DETAIL_PATH}`]: () => jsonResponse(200, { ...stepData, canIntervene: false }),
    });
    mockApi(api.handlers);
    renderSession();
    expect(
      await screen.findByText("Only a maintainer can write to the agent."),
    ).toBeInTheDocument();
    expect(screen.queryByRole("textbox", FIELD)).not.toBeInTheDocument();

    cleanup();
    fetchMock.mockReset();

    // Member, ma il server dice canIntervene: true → il campo (in sola lettura), nessuna riga del maintainer.
    api = baseApi({
      "GET /api/auth/me": meHandler("member"),
      [`GET ${DETAIL_PATH}`]: () => jsonResponse(200, { ...stepData, canIntervene: true }),
    });
    mockApi(api.handlers);
    renderSession();
    expect(await screen.findByRole("textbox", FIELD)).toHaveAttribute("readonly");
    expect(screen.queryByText("Only a maintainer can write to the agent.")).not.toBeInTheDocument();
  });

  it("senza canIntervene (server più vecchio): fra due segmenti nessun campo e nessuna riga, come prima", async () => {
    // LIVE_DETAIL non ha `canIntervene`, di proposito: è la prova del `?? false`.
    const api = baseApi({
      [`GET ${DETAIL_PATH}`]: () => jsonResponse(200, { ...LIVE_DETAIL, activeSegment: null }),
    });
    mockApi(api.handlers);
    renderSession();
    await waitForPage();
    expect(screen.queryByRole("textbox", FIELD)).not.toBeInTheDocument();
    expect(screen.queryByText("The agent is moving on to the next step…")).not.toBeInTheDocument();
    expect(screen.queryByText("Only a maintainer can write to the agent.")).not.toBeInTheDocument();
  });

  it("review e Docs (canIntervene falso) restano in sola lettura: la riga di sempre, mai quella del maintainer", async () => {
    const api = baseApi({
      [`GET ${DETAIL_PATH}`]: () =>
        jsonResponse(200, {
          ...LIVE_DETAIL,
          kind: "pr_review",
          activeSegment: "review",
          canIntervene: false,
        }),
    });
    mockApi(api.handlers);
    renderSession();
    expect(await screen.findByText("This step can only be watched.")).toBeInTheDocument();
    expect(screen.queryByText("Only a maintainer can write to the agent.")).not.toBeInTheDocument();
    expect(screen.queryByRole("textbox", FIELD)).not.toBeInTheDocument();
  });

  it("a sessione finita il campo se ne va anche con canIntervene", async () => {
    const api = baseApi({
      [`GET ${DETAIL_PATH}`]: () =>
        jsonResponse(200, {
          ...LIVE_DETAIL,
          state: "ended",
          activeSegment: null,
          outcome: "completed",
          canIntervene: true,
        }),
    });
    mockApi(api.handlers);
    renderSession();
    await waitForPage();
    expect(screen.queryByRole("textbox", FIELD)).not.toBeInTheDocument();
    expect(screen.queryByText("The agent is moving on to the next step…")).not.toBeInTheDocument();
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
    expect(await screen.findByText("The agent had just finished this step: send it again now")).toBeInTheDocument();
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

  it("scrivere all'agente da risaliti riporta in fondo, senza «nuovi messaggi»", async () => {
    let inputs: unknown[] = [];
    const api = baseApi({
      [`GET ${DETAIL_PATH}`]: () => jsonResponse(200, { ...LIVE_DETAIL, canWrite: true, inputs }),
      [`POST ${MESSAGES_PATH}`]: () => {
        inputs = [pendingInput("pending", null)];
        return jsonResponse(202, { inputId: INPUT_ID, status: "pending" });
      },
    });
    const scroller = await openAtBottom(api);
    scroller.userScrollTo(1000);

    // La bolla del proprio messaggio allunga la trascrizione.
    scroller.state.height = 5600;
    const field = await screen.findByRole("textbox", FIELD);
    await userEvent.type(field, "Use the v2 API instead");
    await userEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(field).toHaveValue(""));
    await waitFor(() => expect(scroller.state.top).toBe(4800));
    expect(screen.queryByRole("button", NEW_MESSAGES)).not.toBeInTheDocument();
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

  it("il testo della domanda rende il markdown inline: `calc.js` diventa codice, niente backtick grezzi", async () => {
    const text = "Modifico `calc.js` o `index.js`?";
    for (const canAnswer of [true, false]) {
      mockApi(
        baseApi({
          [`GET ${DETAIL_PATH}`]: () =>
            jsonResponse(200, { ...LIVE_DETAIL, questions: [agentQuestion({ question: text, canAnswer })] }),
        }).handlers,
      );
      renderSession();
      const code = await screen.findByText("calc.js");
      expect(code.tagName).toBe("CODE");
      expect(document.body.textContent).not.toContain("`");
      cleanup();
      fetchMock.mockReset();
    }
  });

  it("un'immagine nel testo o nelle opzioni della domanda non si carica: resta l'alt", async () => {
    for (const canAnswer of [true, false]) {
      mockApi(
        baseApi({
          [`GET ${DETAIL_PATH}`]: () =>
            jsonResponse(200, {
              ...LIVE_DETAIL,
              questions: [
                agentQuestion({
                  question: "Is ![the chart](https://x.test/q.png) right?",
                  options: [{ label: "See ![pixel](https://x.test/l.png)" }],
                  canAnswer,
                }),
              ],
            }),
        }).handlers,
      );
      renderSession();
      expect(await screen.findByText(/the chart/)).toBeInTheDocument();
      expect(document.querySelector("img")).toBeNull();
      expect(document.body.innerHTML).not.toContain("x.test");
      cleanup();
      fetchMock.mockReset();
    }
  });

  it("etichette e conseguenze delle opzioni rendono il markdown inline nella sessione", async () => {
    mockApi(
      baseApi({
        [`GET ${DETAIL_PATH}`]: () =>
          jsonResponse(200, {
            ...LIVE_DETAIL,
            questions: [
              agentQuestion({ options: [{ label: "Use `format(3.14)`", consequence: "Reads back with `Number()`" }] }),
            ],
          }),
      }).handlers,
    );
    renderSession();
    expect((await screen.findByText("format(3.14)")).tagName).toBe("CODE");
    expect(screen.getByText("Number()").tagName).toBe("CODE");
    expect(screen.getByRole("radio", { name: "Use format(3.14)" })).toBeInTheDocument();
    expect(document.body.textContent).not.toContain("`");
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
    // La fixture NON ha `answer`/`dismissed` (server più vecchio, il web fa un
    // cast): nessuna riga di risposta, e niente si rompe.
    expect(screen.queryByTestId(`session-question-answer-${QUESTION_ID}`)).not.toBeInTheDocument();
  });

  it("domanda già risposta: si legge la scelta fatta (opzione o testo libero), «non ora» lo dice", async () => {
    const withAnswer = (overrides: Record<string, unknown>) =>
      baseApi({
        [`GET ${DETAIL_PATH}`]: () =>
          jsonResponse(200, {
            ...LIVE_DETAIL,
            questions: [agentQuestion({ answered: true, canAnswer: false, ...overrides })],
          }),
      });

    mockApi(withAnswer({ answer: { optionIndex: 1 } }).handlers);
    renderSession();
    const chosen = await screen.findByTestId(`session-question-answer-${QUESTION_ID}`);
    expect(chosen).toHaveTextContent("Move to v2");
    expect(chosen).not.toHaveTextContent("Keep the old API");
    expect(chosen).toHaveClass("text-signal");
    expect(screen.getByText(/Answered/)).toBeInTheDocument();

    cleanup();
    fetchMock.mockReset();
    mockApi(withAnswer({ allowFreeText: true, answer: { text: "Neither: postpone" } }).handlers);
    renderSession();
    expect(await screen.findByTestId(`session-question-answer-${QUESTION_ID}`)).toHaveTextContent(
      "Neither: postpone",
    );

    cleanup();
    fetchMock.mockReset();
    mockApi(withAnswer({ answer: null, dismissed: true }).handlers);
    renderSession();
    expect(await screen.findByText("Which API should the fix target?")).toBeInTheDocument();
    expect(screen.getByText(/Not now/)).toBeInTheDocument();
    expect(screen.queryByText(/Answered/)).not.toBeInTheDocument();
    expect(screen.queryByTestId(`session-question-answer-${QUESTION_ID}`)).not.toBeInTheDocument();
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

  it("#question vince sull'apertura in fondo: nessuno scroll al fondo, la vista va alla domanda", async () => {
    const scroll = vi.fn();
    const original = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = scroll;
    try {
      const api = baseApi({
        [`GET ${DETAIL_PATH}`]: () =>
          jsonResponse(200, { ...LIVE_DETAIL, questions: [agentQuestion()] }),
      });
      const release = delayEvents(api.handlers);
      mockApi(api.handlers);
      renderSession(`/agents/${SESSION_ID}#question`);
      const scroller = stubScroller(await findScroller());
      release();
      await screen.findByText(/Looking at the/);
      const anchor = document.getElementById("question");
      await waitFor(() => expect(scroll.mock.contexts).toContain(anchor));
      expect(scroller.writes).toEqual([]);
    } finally {
      Element.prototype.scrollIntoView = original;
    }
  });
});

/**
 * Lo scorrimento della chat. happy-dom non ha layout: la geometria del
 * contenitore (il `<main>` del layout) è finta, e `scrollHeight` cresce a mano
 * prima di spingere il contenuto nuovo, come farebbe il browser.
 */
interface FakeScroller {
  el: HTMLElement;
  state: { top: number; height: number; client: number };
  /** Ogni valore scritto in `scrollTop` (o via `scrollTo`), con o senza gli eventi nella vista. */
  writes: number[];
  /** Simula l'utente che scorre fino a `top`. */
  userScrollTo: (top: number) => void;
}

async function findScroller(): Promise<HTMLElement> {
  return waitFor(() => {
    const el = document.querySelector<HTMLElement>("[data-scroll-container]");
    if (el === null) throw new Error("contenitore di scorrimento non ancora montato");
    return el;
  });
}

function stubScroller(el: HTMLElement, height = 5000, client = 800): FakeScroller {
  const state = { top: 0, height, client };
  const writes: number[] = [];
  const write = (value: number) => {
    writes.push(value);
    state.top = Math.max(0, Math.min(value, state.height - state.client));
  };
  Object.defineProperty(el, "scrollHeight", { configurable: true, get: () => state.height });
  Object.defineProperty(el, "clientHeight", { configurable: true, get: () => state.client });
  Object.defineProperty(el, "scrollTop", { configurable: true, get: () => state.top, set: write });
  el.scrollTo = ((arg: ScrollToOptions | number, y?: number) => {
    write(typeof arg === "number" ? (y ?? 0) : (arg.top ?? state.top));
  }) as typeof el.scrollTo;
  return {
    el,
    state,
    writes,
    userScrollTo: (top) => {
      act(() => {
        state.top = top;
        el.dispatchEvent(new Event("scroll"));
      });
    },
  };
}

/** Trattiene la prima pagina di eventi finché il test non la rilascia. */
function delayEvents(handlers: Record<string, Handler>): () => void {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => (release = resolve));
  const original = handlers[`GET ${EVENTS_PATH}`]!;
  handlers[`GET ${EVENTS_PATH}`] = async (url, init) => {
    await gate;
    return original(url, init);
  };
  return () => release();
}

const NEW_MESSAGES = { name: "New messages" };

/**
 * Monta la sessione con la geometria finta già al suo posto PRIMA che arrivi
 * la prima pagina (altrimenti l'apertura in fondo scrive sul `<main>` vero), e
 * aspetta l'apertura in fondo.
 */
async function openAtBottom(api: ReturnType<typeof baseApi>): Promise<FakeScroller> {
  const release = delayEvents(api.handlers);
  mockApi(api.handlers);
  renderSession();
  const scroller = stubScroller(await findScroller());
  release();
  await waitFor(() => expect(scroller.state.top).toBe(4200));
  return scroller;
}

describe("/agents/$id — scorrimento della chat", () => {
  it("si apre in fondo, una volta sola, solo dopo la prima pagina di eventi", async () => {
    const api = baseApi();
    const release = delayEvents(api.handlers);
    mockApi(api.handlers);
    renderSession();
    const scroller = stubScroller(await findScroller());
    await screen.findByRole("heading", { name: "Fix the login bug" });
    await waitFor(() => expect(callsTo(EVENTS_PATH)).toHaveLength(1));
    // Dettaglio pronto, eventi no: scorrere ora finirebbe a vuoto.
    expect(scroller.writes).toEqual([]);

    release();
    await screen.findByText(/Looking at the/);
    await waitFor(() => expect(scroller.state.top).toBe(4200));
    expect(scroller.writes).toHaveLength(1);
  });

  it("in fondo, il testo nuovo (parziali ed eventi) tiene la vista in fondo, senza bottone", async () => {
    const api = baseApi();
    const scroller = await openAtBottom(api);
    await waitFor(() => expect(api.streams).toHaveLength(1));
    // Qualche pixel sopra il fondo conta ancora come «in fondo».
    scroller.userScrollTo(4180);

    scroller.state.height = 5600;
    api.streams[0]!.stream.push({ type: "partial", segmentId: "s1", text: "Now I am writing" });
    await screen.findByText("Now I am writing");
    await waitFor(() => expect(scroller.state.top).toBe(4800));

    scroller.state.height = 6000;
    api.streams[0]!.stream.push({
      type: "events",
      events: [
        {
          id: "105",
          type: "assistant_text",
          segmentId: "s1",
          at: at(1),
          data: { text: "Done writing" },
        },
      ],
    });
    await screen.findByText("Done writing");
    await waitFor(() => expect(scroller.state.top).toBe(5200));
    expect(screen.queryByRole("button", NEW_MESSAGES)).not.toBeInTheDocument();
  });

  it("risalito, il testo nuovo non sposta la vista e compare «nuovi messaggi», che riporta in fondo", async () => {
    const api = baseApi();
    const scroller = await openAtBottom(api);
    await waitFor(() => expect(api.streams).toHaveLength(1));
    scroller.userScrollTo(1000);
    const writes = scroller.writes.length;

    scroller.state.height = 5600;
    api.streams[0]!.stream.push({ type: "partial", segmentId: "s1", text: "Now I am writing" });
    await screen.findByText("Now I am writing");
    const button = await screen.findByRole("button", NEW_MESSAGES);
    expect(scroller.state.top).toBe(1000);
    expect(scroller.writes).toHaveLength(writes);

    await userEvent.click(button);
    expect(scroller.state.top).toBe(4800);
    await waitFor(() => expect(screen.queryByRole("button", NEW_MESSAGES)).not.toBeInTheDocument());
  });

  it("il bottone sparisce anche tornando in fondo a mano", async () => {
    const api = baseApi();
    const scroller = await openAtBottom(api);
    await waitFor(() => expect(api.streams).toHaveLength(1));
    scroller.userScrollTo(1000);

    scroller.state.height = 5600;
    api.streams[0]!.stream.push({ type: "partial", segmentId: "s1", text: "Now I am writing" });
    await screen.findByRole("button", NEW_MESSAGES);

    scroller.userScrollTo(4800);
    await waitFor(() => expect(screen.queryByRole("button", NEW_MESSAGES)).not.toBeInTheDocument());
  });

  it("a sessione finita il recupero che azzera i parziali, senza eventi nuovi, non è testo nuovo", async () => {
    const api = baseApi();
    const scroller = await openAtBottom(api);
    await waitFor(() => expect(api.streams).toHaveLength(1));
    const { stream } = api.streams[0]!;
    scroller.state.height = 5600;
    stream.push({ type: "partial", segmentId: "s1", text: "Now I am writing" });
    await screen.findByText("Now I am writing");
    await waitFor(() => expect(scroller.state.top).toBe(4800));
    scroller.userScrollTo(1000);
    const writes = scroller.writes.length;

    // Il recupero finale (`?after=104`) non trova niente e azzera i parziali:
    // la trascrizione si ACCORCIA, non arriva niente di nuovo.
    stream.push({
      type: "session",
      detail: { ...LIVE_DETAIL, state: "ended", activeSegment: null },
    });
    await waitFor(() =>
      expect(callsTo(EVENTS_PATH).some((c) => c.url.searchParams.get("after") === "104")).toBe(
        true,
      ),
    );
    await waitFor(() => expect(screen.queryByText("Now I am writing")).not.toBeInTheDocument());
    expect(screen.queryByRole("button", NEW_MESSAGES)).not.toBeInTheDocument();
    expect(scroller.writes).toHaveLength(writes);
    expect(scroller.state.top).toBe(1000);
  });

  it("«Load earlier» non sposta la vista e non fa comparire «nuovi messaggi»", async () => {
    // L'ancoraggio lo tiene il browser (overflow-anchor), verificato a mano: la
    // vista non deve metterci le mani, né leggere il passato come testo nuovo.
    const OLDER = {
      events: [
        {
          id: "50",
          type: "assistant_text",
          segmentId: "s0",
          at: at(600),
          data: { text: "Older words" },
        },
      ],
      before: null,
    };
    const api = baseApi({
      [`GET ${EVENTS_PATH}`]: (url) =>
        url.searchParams.get("before") === "101"
          ? jsonResponse(200, OLDER)
          : jsonResponse(200, { ...pageAfter(FIRST_PAGE.events, url), before: "101" }),
    });
    const scroller = await openAtBottom(api);
    scroller.userScrollTo(0);
    const writes = scroller.writes.length;

    scroller.state.height = 5600;
    await userEvent.click(await screen.findByRole("button", { name: "Load earlier" }));
    await screen.findByText("Older words");
    expect(scroller.writes).toHaveLength(writes);
    expect(scroller.state.top).toBe(0);
    expect(screen.queryByRole("button", NEW_MESSAGES)).not.toBeInTheDocument();
  });

  it("aperta in fondo e poi caricato il passato, il testo nuovo segue ancora se si è in fondo", async () => {
    const OLDER = {
      events: [
        {
          id: "50",
          type: "assistant_text",
          segmentId: "s0",
          at: at(600),
          data: { text: "Older words" },
        },
      ],
      before: null,
    };
    const api = baseApi({
      [`GET ${EVENTS_PATH}`]: (url) =>
        url.searchParams.get("before") === "101"
          ? jsonResponse(200, OLDER)
          : jsonResponse(200, { ...pageAfter(FIRST_PAGE.events, url), before: "101" }),
    });
    const scroller = await openAtBottom(api);
    await waitFor(() => expect(api.streams).toHaveLength(1));
    scroller.userScrollTo(0);
    scroller.state.height = 5600;
    await userEvent.click(await screen.findByRole("button", { name: "Load earlier" }));
    await screen.findByText("Older words");
    // Il browser ha tenuto la vista sul contenuto; l'utente torna giù.
    scroller.userScrollTo(4800);

    scroller.state.height = 6000;
    api.streams[0]!.stream.push({ type: "partial", segmentId: "s1", text: "Now I am writing" });
    await screen.findByText("Now I am writing");
    await waitFor(() => expect(scroller.state.top).toBe(5200));
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

/**
 * Il «non consegnato» leggibile e «Rimanda» (9 ott 2026, Task A2, parità con
 * l'app): il motivo in una frase, e «Rimanda» che rimette il testo nel campo
 * e ci mette il focus — senza inviarlo.
 */
describe("/agents/$id — non consegnato e «Rimanda»", () => {
  const FIELD = { name: "Write to the agent…" };
  const MESSAGES_PATH = `${DETAIL_PATH}/messages`;

  function undelivered(reason: string | null) {
    return {
      id: INPUT_ID,
      text: "Please also update the docs",
      status: "undelivered",
      reason,
      authorUserId: null,
      authorName: "ada@example.com",
      interrupt: false,
      createdAt: at(20),
    };
  }

  it.each([
    ["stdin_closed", "The agent had just finished this step: send it again now"],
    ["session_not_live", "The session was no longer active"],
    ["mystery_reason", "The message did not reach the agent"],
    [null, "The message did not reach the agent"],
  ])("motivo %s: una frase leggibile, mai la chiave", async (reason, text) => {
    const api = baseApi({
      [`GET ${DETAIL_PATH}`]: () => jsonResponse(200, { ...LIVE_DETAIL, canWrite: true, inputs: [undelivered(reason)] }),
    });
    mockApi(api.handlers);
    renderSession();
    expect(await screen.findByText(text)).toBeInTheDocument();
  });

  it("«Resend» rimette il testo nel campo e lo mette a fuoco, senza inviarlo", async () => {
    const api = baseApi({
      [`GET ${DETAIL_PATH}`]: () =>
        jsonResponse(200, { ...LIVE_DETAIL, canWrite: true, inputs: [undelivered("stdin_closed")] }),
    });
    mockApi(api.handlers);
    renderSession();
    const field = await screen.findByRole("textbox", FIELD);
    expect(field).toHaveValue("");
    await userEvent.click(await screen.findByRole("button", { name: /^Resend/ }));
    expect(field).toHaveValue("Please also update the docs");
    expect(field).toHaveFocus();
    expect(callsTo(MESSAGES_PATH)).toHaveLength(0);
  });

  it("senza campo (sessione conclusa) «Resend» non c'è", async () => {
    const api = baseApi({
      [`GET ${DETAIL_PATH}`]: () =>
        jsonResponse(200, {
          ...LIVE_DETAIL,
          state: "ended",
          activeSegment: null,
          outcome: "completed",
          inputs: [undelivered("session_not_live")],
        }),
    });
    mockApi(api.handlers);
    renderSession();
    expect(await screen.findByText("The session was no longer active")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Resend/ })).not.toBeInTheDocument();
  });
});

/** Fix round 1 della review di A2 (parità con l'app). */
describe("/agents/$id — «Rimanda», fix della review", () => {
  const FIELD = { name: "Write to the agent…" };
  const MESSAGES_PATH = `${DETAIL_PATH}/messages`;
  const TEXT = "Please also update the docs";

  function undelivered(text = TEXT, id = INPUT_ID) {
    return {
      id,
      text,
      status: "undelivered",
      reason: "stdin_closed",
      authorUserId: null,
      authorName: "ada@example.com",
      interrupt: false,
      createdAt: at(20),
    };
  }

  it("con del testo nel campo lo AGGIUNGE dopo una riga vuota, cursore in fondo", async () => {
    const api = baseApi({
      [`GET ${DETAIL_PATH}`]: () => jsonResponse(200, { ...LIVE_DETAIL, canWrite: true, inputs: [undelivered()] }),
    });
    mockApi(api.handlers);
    renderSession();
    const field = (await screen.findByRole("textbox", FIELD)) as HTMLTextAreaElement;
    await userEvent.type(field, "My note");
    // Lo spazio di prova riporterebbe da sé il cursore in fondo al cambio di
    // valore: si verifica che la vista lo CHIEDA, col campo e la lunghezza giusti.
    const setSelectionRange = vi.spyOn(field, "setSelectionRange");
    try {
      await userEvent.click(screen.getByRole("button", { name: /^Resend/ }));
      const expected = `My note\n\n${TEXT}`;
      expect(field).toHaveValue(expected);
      await waitFor(() => expect(setSelectionRange).toHaveBeenCalledWith(expected.length, expected.length));
      expect(field).toHaveFocus();
      expect(callsTo(MESSAGES_PATH)).toHaveLength(0);
    } finally {
      setSelectionRange.mockRestore();
    }
  });

  it("mentre un invio è in corso «Resend» è spento", async () => {
    let release: (() => void) | null = null;
    const api = baseApi({
      [`GET ${DETAIL_PATH}`]: () => jsonResponse(200, { ...LIVE_DETAIL, canWrite: true, inputs: [undelivered()] }),
      [`POST ${MESSAGES_PATH}`]: () =>
        new Promise<Response>((resolve) => {
          release = () => resolve(jsonResponse(202, { inputId: INPUT_ID, status: "pending" }));
        }),
    });
    mockApi(api.handlers);
    renderSession();
    const field = await screen.findByRole("textbox", FIELD);
    await userEvent.type(field, "Other");
    expect(screen.getByRole("button", { name: /^Resend/ })).toBeEnabled();
    await userEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(release).not.toBeNull());
    await waitFor(() => expect(screen.getByRole("button", { name: /^Resend/ })).toBeDisabled());
    release!();
    await waitFor(() => expect(screen.getByRole("button", { name: /^Resend/ })).toBeEnabled());
  });

  it("ogni «Resend» dice di quale messaggio è, tagliato a 40 caratteri", async () => {
    const OTHER = "77777777-7777-4777-8777-777777777777";
    const long = "This message is definitely far too long for an accessible name";
    const api = baseApi({
      [`GET ${DETAIL_PATH}`]: () =>
        jsonResponse(200, {
          ...LIVE_DETAIL,
          canWrite: true,
          inputs: [undelivered(), { ...undelivered(long, OTHER), createdAt: at(10) }],
        }),
    });
    mockApi(api.handlers);
    renderSession();
    expect(await screen.findByRole("button", { name: `Resend “${TEXT}”` })).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: `Resend “${long.slice(0, 40).trimEnd()}…”` }),
    ).toBeInTheDocument();
  });
});

/**
 * Coda e «Ferma» (Q3, 10 ott 2026), gemello del describe dell'app. La fixture
 * LIVE_DETAIL resta SENZA `paused` apposta: il web fa un cast, e la difesa
 * (`?? false`) va provata su una risposta di un server più vecchio.
 */
describe("/agents/$id — coda, «Ferma» e pausa", () => {
  const FIELD = { name: "Write to the agent…" };
  const MESSAGES_PATH = `${DETAIL_PATH}/messages`;
  const STOP_ID = "88888888-8888-4888-8888-888888888888";
  const PAUSED = "Paused: tell the agent what to do";

  function row(over: Record<string, unknown> = {}) {
    return {
      id: INPUT_ID,
      text: "Use the v2 API instead",
      status: "delivered",
      reason: null,
      authorUserId: null,
      authorName: "ada@example.com",
      interrupt: false,
      createdAt: at(1),
      ...over,
    };
  }
  const stopRow = (over: Record<string, unknown> = {}) =>
    row({ id: STOP_ID, text: "", interrupt: true, createdAt: at(20), ...over });

  it("«Stop» c'è sempre con canInterrupt (anche a campo vuoto) e manda interrupt senza testo; il campo non si svuota", async () => {
    const api = baseApi({
      [`GET ${DETAIL_PATH}`]: () => jsonResponse(200, { ...LIVE_DETAIL, canWrite: true, canInterrupt: true }),
      [`POST ${MESSAGES_PATH}`]: () => jsonResponse(202, { inputId: STOP_ID, status: "pending" }),
    });
    mockApi(api.handlers);
    renderSession();
    const field = await screen.findByRole("textbox", FIELD);
    const stop = screen.getByRole("button", { name: "Stop" });
    expect(stop).toBeEnabled();
    expect(screen.getByRole("button", { name: "Send" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Stop and send" })).toBeInTheDocument();
    await userEvent.type(field, "draft in progress");
    await userEvent.click(screen.getByRole("button", { name: "Stop" }));
    await waitFor(() => expect(callsTo(MESSAGES_PATH)).toHaveLength(1));
    expect(JSON.parse(String(callsTo(MESSAGES_PATH)[0]!.init?.body))).toEqual({ interrupt: true });
    // Il dettaglio riletto non svuota il campo: «Stop» non ha mandato il testo.
    await waitFor(() => expect(screen.getByRole("button", { name: "Stop" })).toBeEnabled());
    expect(screen.getByRole("textbox", FIELD)).toHaveValue("draft in progress");
  });

  it("senza canInterrupt nessun «Stop»", async () => {
    const api = baseApi({
      [`GET ${DETAIL_PATH}`]: () => jsonResponse(200, { ...LIVE_DETAIL, canWrite: true, canInterrupt: false }),
    });
    mockApi(api.handlers);
    renderSession();
    expect(await screen.findByRole("textbox", FIELD)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Stop" })).not.toBeInTheDocument();
  });

  it("«Stop» in corso: spento, occupato, dice che sta fermando", async () => {
    let release: (() => void) | null = null;
    const api = baseApi({
      [`GET ${DETAIL_PATH}`]: () => jsonResponse(200, { ...LIVE_DETAIL, canWrite: true, canInterrupt: true }),
      [`POST ${MESSAGES_PATH}`]: async () => {
        await new Promise<void>((resolve) => (release = resolve));
        return jsonResponse(202, { inputId: STOP_ID, status: "pending" });
      },
    });
    mockApi(api.handlers);
    renderSession();
    await userEvent.click(await screen.findByRole("button", { name: "Stop" }));
    await waitFor(() => expect(release).not.toBeNull());
    const stopping = await screen.findByRole("button", { name: "Stopping…" });
    expect(stopping).toBeDisabled();
    expect(stopping).toHaveAttribute("aria-busy", "true");
    release!();
    expect(await screen.findByRole("button", { name: "Stop" })).toBeInTheDocument();
  });

  it("in pausa: la riga lo dice, il campo si scrive, niente «Stop» (canInterrupt falso dal server); il messaggio parte normale", async () => {
    const api = baseApi({
      [`GET ${DETAIL_PATH}`]: () =>
        jsonResponse(200, { ...LIVE_DETAIL, canWrite: true, canInterrupt: false, paused: true, inputs: [stopRow()] }),
      [`POST ${MESSAGES_PATH}`]: () => jsonResponse(202, { inputId: INPUT_ID, status: "pending" }),
    });
    mockApi(api.handlers);
    renderSession();
    expect(await screen.findByText(PAUSED)).toBeInTheDocument();
    const field = screen.getByRole("textbox", FIELD);
    expect(field).not.toHaveAttribute("readonly");
    expect(screen.queryByRole("button", { name: "Stop" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Stop and send" })).not.toBeInTheDocument();
    await userEvent.type(field, "Now redo the test");
    await userEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(callsTo(MESSAGES_PATH)).toHaveLength(1));
    expect(JSON.parse(String(callsTo(MESSAGES_PATH)[0]!.init?.body))).toEqual({
      text: "Now redo the test",
      interrupt: false,
    });
  });

  it("la riga di pausa è una regione viva SEMPRE montata: entrando in pausa cambia solo il suo testo", async () => {
    let paused = false;
    const api = baseApi({
      [`GET ${DETAIL_PATH}`]: () =>
        jsonResponse(200, { ...LIVE_DETAIL, canWrite: true, canInterrupt: !paused, paused }),
    });
    mockApi(api.handlers);
    renderSession();
    await screen.findByRole("textbox", FIELD);
    await waitFor(() => expect(api.streams).toHaveLength(1));
    const region = screen.getAllByRole("status").find((el) => el.textContent === "");
    expect(region).toBeDefined();
    paused = true;
    api.streams[0]!.stream.push({
      type: "session",
      detail: { ...LIVE_DETAIL, canWrite: true, canInterrupt: false, paused: true, inputs: [stopRow()] },
    });
    await waitFor(() => expect(region).toHaveTextContent(PAUSED));
    expect(region).toBeInTheDocument();
  });

  it("un dettaglio senza paused (server più vecchio, fixture senza il campo) non è in pausa", async () => {
    const api = baseApi({
      [`GET ${DETAIL_PATH}`]: () => jsonResponse(200, { ...LIVE_DETAIL, canWrite: true, canInterrupt: true }),
    });
    mockApi(api.handlers);
    renderSession();
    expect(await screen.findByRole("textbox", FIELD)).toBeInTheDocument();
    expect(screen.queryByText(PAUSED)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Stop" })).toBeEnabled();
  });

  it("consegnato senza evento: «Queued» in FONDO, dopo il testo dal vivo; all'eco torna al suo punto", async () => {
    const api = baseApi({
      [`GET ${DETAIL_PATH}`]: () =>
        jsonResponse(200, { ...LIVE_DETAIL, canWrite: true, inputs: [row({ createdAt: at(35) })] }),
    });
    mockApi(api.handlers);
    renderSession();
    await waitFor(() => expect(api.streams).toHaveLength(1));
    const { stream } = api.streams[0]!;
    stream.push({ type: "partial", segmentId: "s1", text: "Writing now" });
    const queued = await screen.findByText("Queued");
    expect(screen.queryByText("delivered")).not.toBeInTheDocument();
    // In fondo: l'ultimo elemento della trascrizione, dopo il testo dal vivo.
    const rows = Array.from(queued.closest("ol")!.children);
    expect(rows[rows.length - 1]).toContainElement(queued);
    expect(rows[rows.length - 2]).toContainElement(screen.getByText("Writing now"));

    stream.push({
      type: "events",
      events: [
        {
          id: "105",
          type: "input",
          segmentId: "s1",
          at: at(1),
          data: { text: "Use the v2 API instead", interrupt: false, inputId: INPUT_ID, authorName: "ada@example.com" },
        },
      ],
    });
    expect(await screen.findByText("delivered")).toBeInTheDocument();
    expect(screen.queryByText("Queued")).not.toBeInTheDocument();
    expect(screen.getAllByText("Use the v2 API instead")).toHaveLength(1);
  });

  it("a sessione conclusa un consegnato senza evento non promette la coda", async () => {
    const api = baseApi({
      [`GET ${DETAIL_PATH}`]: () =>
        jsonResponse(200, { ...LIVE_DETAIL, state: "ended", activeSegment: null, outcome: "completed", inputs: [row()] }),
    });
    mockApi(api.handlers);
    renderSession();
    expect(await screen.findByText("delivered")).toBeInTheDocument();
    expect(screen.queryByText("Queued")).not.toBeInTheDocument();
  });

  it("«Ferma» senza testo: una riga «… stopped the agent», mai una bolla vuota né «Queued»", async () => {
    const api = baseApi({
      [`GET ${DETAIL_PATH}`]: () =>
        jsonResponse(200, { ...LIVE_DETAIL, canWrite: true, paused: true, inputs: [stopRow()] }),
    });
    mockApi(api.handlers);
    renderSession();
    expect(await screen.findByText("ada@example.com stopped the agent")).toBeInTheDocument();
    expect(screen.queryByText("Queued")).not.toBeInTheDocument();
    expect(screen.queryByText("delivered")).not.toBeInTheDocument();
  });

  it("il messaggio che riprende la pausa non lampeggia «Queued» prima dell'eco", async () => {
    const api = baseApi({
      [`GET ${DETAIL_PATH}`]: () =>
        jsonResponse(200, { ...LIVE_DETAIL, canWrite: true, inputs: [stopRow(), row({ text: "Now redo the test" })] }),
    });
    mockApi(api.handlers);
    renderSession();
    expect(await screen.findByText("Now redo the test")).toBeInTheDocument();
    expect(screen.getByText("delivered")).toBeInTheDocument();
    expect(screen.queryByText("Queued")).not.toBeInTheDocument();
  });
});
