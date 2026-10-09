import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionHeader } from "../../components/agent-session/session-header";
import { Transcript } from "../../components/agent-session/transcript";
import { buildTranscript } from "../../lib/agent-transcript";
import { agentSessionKeys } from "../../lib/queries";
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

function meHandler(): Handler {
  return () => jsonResponse(200, { user: { id: "u1", email: "ada@example.com", role: "admin", language: "en" } });
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

function renderSession() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, retryDelay: 0 } } });
  const router = createAppRouter(
    queryClient,
    createMemoryHistory({ initialEntries: [`/agents/${SESSION_ID}`] }),
  );
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
    expect(screen.getByText("Execution")).toBeInTheDocument();
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
    expect(screen.getByText("router")).toBeInTheDocument();
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
