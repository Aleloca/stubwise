import { NavigationContext } from "@react-navigation/native";
import { ApiError, type StubwiseClient } from "@stubwise/api-client";
import type { AgentSessionDetail, AgentSessionEvent } from "@stubwise/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react-native";
import { AppState } from "react-native";
import { AuthContext } from "../../app/auth-context";
import type { AuthContextValue } from "../../app/providers";
import "../../i18n";
import { AgentSessionStreamContext } from "../../lib/agent-session-view";
import { FakeXhr, sseFrame } from "../../test-utils/fake-xhr";
import { AgentSessionScreen } from "./AgentSessionScreen";

/**
 * La sessione di un agente come chat (piano C, Task 6). Gemello di
 * `apps/web/src/routes/agents/$id.test.tsx`: stessi casi, trasporto diverso.
 * Lo stream usa l'XHR finto iniettato con `AgentSessionStreamContext`.
 */

const SESSION_ID = "11111111-1111-4111-8111-111111111111";
const TICKET_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const INPUT_ID = "99999999-9999-4999-8999-999999999999";
const NOW = Date.now();
const at = (secondsAgo: number) => new Date(NOW - secondsAgo * 1000).toISOString();

/** Un dettaglio COMPLETO (il client è un doppio: il parse non gira). */
function detail(overrides: Partial<AgentSessionDetail> = {}): AgentSessionDetail {
  return {
    id: SESSION_ID,
    kind: "ai_job",
    title: "Correggi il bug del login",
    projectId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
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
    ...overrides,
  };
}

const LIVE = detail();
const ENDED = detail({ state: "ended", activeSegment: null, outcome: "completed" });

const FIRST_EVENTS: AgentSessionEvent[] = [
  { id: "101", type: "segment_start", segmentId: "s1", at: at(60), data: { label: "execute", interactive: true } },
  { id: "102", type: "assistant_text", segmentId: "s1", at: at(50), data: { text: "Guardo il **router** adesso" } },
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
    data: { toolUseId: "tu1", isError: false, content: "file aggiornato", truncated: true },
  },
];

type EventsPage = { events: AgentSessionEvent[]; before: string | null };

/** `after` come il server: solo i successivi; senza cursori la pagina intera. */
function pageAfter(events: AgentSessionEvent[], page?: { after?: string }): EventsPage {
  if (!page?.after) return { events, before: null };
  return { events: events.filter((e) => BigInt(e.id) > BigInt(page.after!)), before: null };
}

function makeClient(overrides: { get?: jest.Mock; events?: jest.Mock } = {}): StubwiseClient {
  return {
    agentSessions: {
      list: jest.fn().mockResolvedValue({ live: [], recent: [] }),
      get: overrides.get ?? jest.fn().mockResolvedValue(LIVE),
      events:
        overrides.events ??
        jest.fn().mockImplementation(async (_id: string, page?: { after?: string }) => pageAfter(FIRST_EVENTS, page)),
      send: jest.fn(),
      streamPath: jest.fn(),
    },
  } as unknown as StubwiseClient;
}

/** Una navigazione finta che si può mettere fuori fuoco e rimettere a fuoco. */
function focusNavigation() {
  const listeners: Record<string, (() => void)[]> = {};
  let focused = true;
  return {
    navigate: jest.fn(),
    goBack: jest.fn(),
    isFocused: () => focused,
    addListener: (event: string, cb: () => void) => {
      (listeners[event] ??= []).push(cb);
      return () => {
        listeners[event] = (listeners[event] ?? []).filter((l) => l !== cb);
      };
    },
    setFocused(next: boolean) {
      focused = next;
      for (const cb of listeners[next ? "focus" : "blur"] ?? []) cb();
    },
  };
}

const mockAddEventListener = AppState.addEventListener as jest.Mock;

/** Manda uno stato dell'app a TUTTI gli ascoltatori `change` registrati nel test. */
function setAppState(status: string) {
  const listeners = mockAddEventListener.mock.calls.filter(([event]) => event === "change");
  if (listeners.length === 0) throw new Error("nessun ascoltatore AppState");
  for (const [, listener] of listeners) (listener as (s: string) => void)(status);
}

const clients: QueryClient[] = [];
beforeEach(() => {
  FakeXhr.reset();
  mockAddEventListener.mockClear();
  mockAddEventListener.mockReturnValue({ remove: jest.fn() });
});
afterEach(() => {
  clients.splice(0).forEach((c) => c.clear());
});

async function renderScreen(client: StubwiseClient, nav = focusNavigation(), backoffMs = 60_000) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, retryDelay: 0 } } });
  clients.push(queryClient);
  const authValue: AuthContextValue = {
    status: "authenticated",
    client,
    user: { id: "viewer-1", email: "op@example.com", role: "admin", language: "it", avatarUrl: null, slackUserId: null },
    justLoggedIn: false,
    login: jest.fn(),
    completeOnboarding: jest.fn(),
    openSettings: jest.fn(),
    loggedOut: jest.fn(),
  };
  const view = await render(
    <QueryClientProvider client={queryClient}>
      <AuthContext.Provider value={authValue}>
        <AgentSessionStreamContext.Provider
          value={{
            createXhr: FakeXhr.create,
            loadSession: async () => ({ baseUrl: "https://stubwise.example", token: "stw_pat_x" }),
            backoffMs: () => backoffMs,
          }}
        >
          <NavigationContext.Provider value={nav as never}>
            <AgentSessionScreen
              navigation={nav as never}
              route={{ key: "AgentSession", name: "AgentSession", params: { id: SESSION_ID } } as never}
            />
          </NavigationContext.Provider>
        </AgentSessionStreamContext.Provider>
      </AuthContext.Provider>
    </QueryClientProvider>,
  );
  return { nav, queryClient, view };
}

/** L'XHR della connessione N, aspettando che esista. */
async function connection(n: number): Promise<FakeXhr> {
  await waitFor(() => expect(FakeXhr.instances.length).toBeGreaterThan(n));
  return FakeXhr.instances[n]!;
}

async function push(xhr: FakeXhr, message: unknown) {
  await act(async () => {
    xhr.emit(sseFrame(message));
  });
}

describe("AgentSessionScreen", () => {
  test("prima pagina: intestazione, testo, card del tool e divisore di segmento", async () => {
    await renderScreen(makeClient());
    expect(await screen.findByText("Correggi il bug del login")).toBeTruthy();
    expect(await screen.findByText("Esecuzione")).toBeTruthy();
    expect(screen.getByText(/router/)).toBeTruthy();
    expect(screen.getByText("#42")).toBeTruthy();
    expect(screen.getByText("Apollo")).toBeTruthy();

    // La card del tool è compatta: si apre su input e risultato.
    const card = screen.getByTestId("tool-card-103");
    expect(within(card).getByText("Modifica il file routes/tickets.ts")).toBeTruthy();
    expect(screen.queryByText("file aggiornato")).toBeNull();
    await fireEvent.press(within(card).getByRole("button"));
    expect(screen.getByText("file aggiornato")).toBeTruthy();
    expect(screen.getByText(/"file_path": "routes\/tickets\.ts"/)).toBeTruthy();
    expect(screen.getByText("(troncato)")).toBeTruthy();
  });

  test("carica solo l'ultima pagina e apre lo stream dall'ultimo id caricato", async () => {
    const client = makeClient();
    await renderScreen(client);
    const xhr = await connection(0);
    expect(xhr.after).toBe("104");
    const events = client.agentSessions.events as jest.Mock;
    expect(events).toHaveBeenCalledTimes(1);
    expect(events.mock.calls[0]![1]).toBeUndefined();
  });

  test("due parziali (delta) dello stesso segmento si accodano e spariscono all'assistant_text", async () => {
    await renderScreen(makeClient());
    const xhr = await connection(0);
    await push(xhr, { type: "partial", segmentId: "s1", text: "Ora sto " });
    await push(xhr, { type: "partial", segmentId: "s1", text: "correggendo" });
    expect(await screen.findByText("Ora sto correggendo")).toBeTruthy();

    await push(xhr, {
      type: "events",
      events: [{ id: "105", type: "assistant_text", segmentId: "s1", at: at(1), data: { text: "Ora sto correggendo davvero" } }],
    });
    expect(await screen.findByText("Ora sto correggendo davvero")).toBeTruthy();
    expect(screen.queryByText("Ora sto correggendo")).toBeNull();
  });

  test("un messaggio session con state ended aggiorna l'intestazione e chiude lo stream", async () => {
    const client = makeClient();
    await renderScreen(client);
    const xhr = await connection(0);
    expect(screen.getByText(/al lavoro/)).toBeTruthy();
    await push(xhr, { type: "session", detail: ENDED });
    expect(await screen.findByText(/completata/)).toBeTruthy();
    expect(screen.queryByText(/al lavoro/)).toBeNull();
    expect(client.agentSessions.get).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(xhr.aborted).toBe(true));
  });

  test("alla fine della sessione recupera gli eventi finali e azzera i parziali", async () => {
    const FINAL: AgentSessionEvent = {
      id: "105",
      type: "assistant_text",
      segmentId: "s1",
      at: at(1),
      data: { text: "Fatto, PR aperta" },
    };
    let firstRead = true;
    const events = jest.fn().mockImplementation(async (_id: string, page?: { after?: string }) => {
      if (firstRead) {
        firstRead = false;
        return { events: FIRST_EVENTS, before: null };
      }
      return pageAfter([...FIRST_EVENTS, FINAL], page);
    });
    await renderScreen(makeClient({ events }));
    const xhr = await connection(0);
    await push(xhr, { type: "partial", segmentId: "s1", text: "Fatto, P" });
    expect(await screen.findByText("Fatto, P")).toBeTruthy();
    await push(xhr, { type: "session", detail: ENDED });

    expect(await screen.findByText("Fatto, PR aperta")).toBeTruthy();
    expect(screen.queryByText("Fatto, P")).toBeNull();
    expect(events.mock.calls.map((c) => (c[1] as { after?: string } | undefined)?.after ?? null)).toEqual([null, "104"]);
  });

  test("un recupero finale fallito non cancella l'ultimo testo dal vivo", async () => {
    let firstRead = true;
    const events = jest.fn().mockImplementation(async () => {
      if (firstRead) {
        firstRead = false;
        return { events: FIRST_EVENTS, before: null };
      }
      throw new ApiError(500, "boom");
    });
    await renderScreen(makeClient({ events }));
    const xhr = await connection(0);
    await push(xhr, { type: "partial", segmentId: "s1", text: "Ultime parole" });
    await push(xhr, { type: "session", detail: ENDED });
    await waitFor(() => expect(events).toHaveBeenCalledTimes(2));
    expect(screen.getByText("Ultime parole")).toBeTruthy();
  });

  test("fuori fuoco lo stream si chiude; di nuovo a fuoco si riapre dal cursore, senza i parziali vecchi", async () => {
    const { nav } = await renderScreen(makeClient());
    const first = await connection(0);
    await push(first, {
      type: "events",
      events: [{ id: "105", type: "assistant_text", segmentId: "s1", at: at(2), data: { text: "Un passo avanti" } }],
    });
    await push(first, { type: "partial", segmentId: "s1", text: "Mezza frase" });
    expect(await screen.findByText("Mezza frase")).toBeTruthy();

    await act(async () => nav.setFocused(false));
    expect(first.aborted).toBe(true);
    expect(FakeXhr.instances).toHaveLength(1);

    await act(async () => nav.setFocused(true));
    const second = await connection(1);
    expect(second.after).toBe("105");
    // M6: i delta arrivati a stream chiuso sono persi, quindi il testo dal vivo riparte da zero.
    await act(async () => second.respond(200));
    await waitFor(() => expect(screen.queryByText("Mezza frase")).toBeNull());
    expect(screen.getByText("Un passo avanti")).toBeTruthy();
  });

  test("app in background: lo stream si chiude; al ritorno si riapre dal cursore", async () => {
    await renderScreen(makeClient());
    const first = await connection(0);
    await act(async () => setAppState("background"));
    expect(first.aborted).toBe(true);
    await act(async () => setAppState("active"));
    const second = await connection(1);
    expect(second.after).toBe("104");
  });

  test("ogni connessione nuova (riconnessione) azzera i parziali", async () => {
    jest.useFakeTimers();
    try {
      await renderScreen(makeClient(), focusNavigation(), 1_000);
      const first = await connection(0);
      await push(first, { type: "partial", segmentId: "s1", text: "Prima della caduta" });
      expect(await screen.findByText("Prima della caduta")).toBeTruthy();
      await act(async () => first.fail());
      expect(await screen.findByText("Riconnessione…")).toBeTruthy();
      await act(async () => {
        await jest.advanceTimersByTimeAsync(1_000);
      });
      const second = await connection(1);
      await act(async () => second.respond(200));
      await waitFor(() => expect(screen.queryByText("Prima della caduta")).toBeNull());
      expect(screen.queryByText("Riconnessione…")).toBeNull();
    } finally {
      jest.useRealTimers();
    }
  });

  test("una sessione conclusa non apre lo stream; il dettaglio riletto a 10 s che la riporta viva lo apre", async () => {
    jest.useFakeTimers();
    try {
      const get = jest.fn().mockResolvedValueOnce(ENDED).mockResolvedValue(LIVE);
      await renderScreen(makeClient({ get }));
      expect(await screen.findByText(/completata/)).toBeTruthy();
      await waitFor(() => expect(screen.getByText(/router/)).toBeTruthy());
      expect(FakeXhr.instances).toHaveLength(0);
      await act(async () => {
        await jest.advanceTimersByTimeAsync(10_000);
      });
      const xhr = await connection(0);
      expect(xhr.after).toBe("104");
    } finally {
      jest.useRealTimers();
    }
  });

  test("fuori fuoco una sessione conclusa non si rilegge", async () => {
    jest.useFakeTimers();
    try {
      const get = jest.fn().mockResolvedValue(ENDED);
      const { nav } = await renderScreen(makeClient({ get }));
      expect(await screen.findByText(/completata/)).toBeTruthy();
      await act(async () => nav.setFocused(false));
      const reads = get.mock.calls.length;
      await act(async () => {
        await jest.advanceTimersByTimeAsync(30_000);
      });
      expect(get).toHaveBeenCalledTimes(reads);
    } finally {
      jest.useRealTimers();
    }
  });

  test("con before non nullo «Carica i precedenti» chiede ?before e antepone", async () => {
    const OLDER: EventsPage = {
      events: [{ id: "50", type: "assistant_text", segmentId: "s0", at: at(600), data: { text: "Parole più vecchie" } }],
      before: null,
    };
    const events = jest
      .fn()
      .mockImplementation(async (_id: string, page?: { before?: string }) =>
        page?.before === "101" ? OLDER : { events: FIRST_EVENTS, before: "101" },
      );
    await renderScreen(makeClient({ events }));
    await fireEvent.press(await screen.findByTestId("agent-session-load-older"));
    expect(await screen.findByText("Parole più vecchie")).toBeTruthy();
    expect(events.mock.calls.map((c) => (c[1] as { before?: string } | undefined)?.before ?? null)).toEqual([null, "101"]);
    expect(screen.queryByTestId("agent-session-load-older")).toBeNull();
    expect(FakeXhr.instances).toHaveLength(1);
  });

  test("un dettaglio SENZA questions, inputs, canWrite, canInterrupt non fa saltare la schermata", async () => {
    const legacy: Record<string, unknown> = { ...LIVE };
    for (const field of ["questions", "inputs", "canWrite", "canInterrupt"]) delete legacy[field];
    await renderScreen(makeClient({ get: jest.fn().mockResolvedValue(legacy) }));
    expect(await screen.findByText("Correggi il bug del login")).toBeTruthy();
    expect(await screen.findByText(/router/)).toBeTruthy();
  });

  test("interventi (anche non consegnati, col motivo), domande in sola lettura, interruzioni, passi falliti", async () => {
    const get = jest.fn().mockResolvedValue(
      detail({
        inputs: [
          {
            id: INPUT_ID,
            text: "Aggiorna anche la documentazione",
            status: "undelivered",
            reason: "stdin_closed",
            authorUserId: null,
            authorName: "max@example.com",
            interrupt: false,
            createdAt: at(20),
          },
        ],
        questions: [
          {
            id: "77777777-7777-4777-8777-777777777777",
            source: "agent",
            question: "Tengo la vecchia API?",
            askedAt: at(15),
            answered: false,
            options: [{ label: "Sì" }, { label: "No" }],
            allowFreeText: false,
            canAnswer: true,
            ticketId: TICKET_ID,
            backlogItemId: null,
          },
        ] as AgentSessionDetail["questions"],
      }),
    );
    const events = jest.fn().mockResolvedValue({
      events: [
        ...FIRST_EVENTS,
        { id: "105", type: "turn_end", segmentId: "s1", at: at(25), data: { subtype: "error_during_execution" } },
        { id: "106", type: "segment_end", segmentId: "s1", at: at(10), data: { exitCode: 1, timedOut: false } },
        { id: "107", type: "mystery_event", segmentId: "s1", at: at(9), data: { text: "non deve comparire" } },
      ],
      before: null,
    });
    await renderScreen(makeClient({ get, events }));
    expect(await screen.findByText("Fermato da un maintainer")).toBeTruthy();
    expect(screen.getByText("Aggiorna anche la documentazione")).toBeTruthy();
    expect(screen.getByText("max@example.com")).toBeTruthy();
    expect(screen.getByText(/non consegnato — l'agente non accettava più messaggi/)).toBeTruthy();
    expect(screen.getByText("Il passo è finito con un errore")).toBeTruthy();
    expect(screen.getByText("Tengo la vecchia API?")).toBeTruthy();
    expect(screen.getByText("L'agente chiede")).toBeTruthy();
    expect(screen.queryByText("non deve comparire")).toBeNull();
  });

  test("una card di tool senza risultato è «in corso» solo in una sessione viva", async () => {
    const pending = FIRST_EVENTS.slice(0, 3);
    await renderScreen(makeClient({ events: jest.fn().mockResolvedValue({ events: pending, before: null }) }));
    const card = await screen.findByTestId("tool-card-103");
    expect(within(card).getByText(/…/)).toBeTruthy();
  });

  test("…e non in una conclusa", async () => {
    await renderScreen(
      makeClient({
        get: jest.fn().mockResolvedValue(ENDED),
        events: jest.fn().mockResolvedValue({ events: FIRST_EVENTS.slice(0, 3), before: null }),
      }),
    );
    const card = await screen.findByTestId("tool-card-103");
    expect(within(card).queryByText(/…/)).toBeNull();
  });

  test("server senza le rotte (404 senza code): «non disponibile», niente retry, niente stream", async () => {
    const get = jest.fn().mockRejectedValue(new ApiError(404, "Route not found"));
    await renderScreen(makeClient({ get }));
    expect(await screen.findByText("Le sessioni degli agenti non sono disponibili su questa istanza.")).toBeTruthy();
    expect(screen.queryByText(/Sessione non trovata/)).toBeNull();
    expect(get).toHaveBeenCalledTimes(1);
    expect(FakeXhr.instances).toHaveLength(0);
  });

  test("404 not_found: «Sessione non trovata», senza riprovare", async () => {
    const get = jest.fn().mockRejectedValue(new ApiError(404, "not found", "not_found"));
    await renderScreen(makeClient({ get }));
    expect(await screen.findByText("Sessione non trovata (o non visibile per te).")).toBeTruthy();
    expect(screen.queryByText(/non sono disponibili/)).toBeNull();
    expect(get).toHaveBeenCalledTimes(1);
  });

  test("uno stream che risponde 404 a metà rilegge il dettaglio", async () => {
    const get = jest
      .fn()
      .mockResolvedValueOnce(LIVE)
      .mockRejectedValue(new ApiError(404, "not found", "not_found"));
    await renderScreen(makeClient({ get }));
    const xhr = await connection(0);
    await act(async () => {
      xhr.respond(404);
      xhr.emit(JSON.stringify({ code: "not_found", message: "not found" }));
      xhr.finish();
    });
    expect(await screen.findByText("Sessione non trovata (o non visibile per te).")).toBeTruthy();
    expect(get).toHaveBeenCalledTimes(2);
  });

  test("il link al ticket naviga a Ticket nello stesso stack; indietro torna", async () => {
    const { nav } = await renderScreen(makeClient());
    await fireEvent.press(await screen.findByTestId("agent-session-ticket"));
    expect(nav.navigate).toHaveBeenCalledWith("Ticket", { id: TICKET_ID, backLabel: "Sessione" });
    await fireEvent.press(screen.getByTestId("screen-header-back"));
    expect(nav.goBack).toHaveBeenCalled();
  });

  test("lo stream si chiude allo smontaggio", async () => {
    const { view } = await renderScreen(makeClient());
    const xhr = await connection(0);
    expect(xhr.aborted).toBe(false);
    await act(async () => view.unmount());
    expect(xhr.aborted).toBe(true);
  });
});
