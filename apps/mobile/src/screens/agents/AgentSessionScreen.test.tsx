import NetInfo from "@react-native-community/netinfo";
import { NavigationContext } from "@react-navigation/native";
import { ApiError, type StubwiseClient } from "@stubwise/api-client";
import type { AgentSessionDetail, AgentSessionEvent } from "@stubwise/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react-native";
import { AppState, FlatList } from "react-native";
import { AuthContext } from "../../app/auth-context";
import type { AuthContextValue } from "../../app/providers";
import "../../i18n";
import { AgentSessionStreamContext } from "../../lib/agent-session-view";
import { agentSessionKeys, backlogKeys, inboxKeys, workKeys } from "../../lib/query-keys";
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

/**
 * Il doppio del client: TUTTI i metodi che la schermata chiama (Task 7:
 * `send`, e le due rotte delle risposte), prima dei test che li usano — un
 * metodo mancante dietro il cast non fallisce, lascia la query in errore.
 */
function makeClient(
  overrides: {
    get?: jest.Mock;
    events?: jest.Mock;
    send?: jest.Mock;
    answerTicketQuestion?: jest.Mock;
    answerBacklogQuestion?: jest.Mock;
  } = {},
): StubwiseClient {
  return {
    agentSessions: {
      list: jest.fn().mockResolvedValue({ live: [], recent: [] }),
      get: overrides.get ?? jest.fn().mockResolvedValue(LIVE),
      events:
        overrides.events ??
        jest.fn().mockImplementation(async (_id: string, page?: { after?: string }) => pageAfter(FIRST_EVENTS, page)),
      send: overrides.send ?? jest.fn().mockResolvedValue({ inputId: INPUT_ID, status: "pending" }),
      streamPath: jest.fn(),
    },
    tickets: {
      answerQuestion: overrides.answerTicketQuestion ?? jest.fn().mockResolvedValue({ jobId: "j", questionId: "q" }),
    },
    backlog: {
      answerQuestion: overrides.answerBacklogQuestion ?? jest.fn().mockResolvedValue({ backlogItemId: "b" }),
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

async function renderScreen(
  client: StubwiseClient,
  nav = focusNavigation(),
  backoffMs = 60_000,
  options: { role?: "admin" | "member"; focus?: "question" } = {},
) {
  // `gcTime: Infinity` sulle mutazioni: una mutazione conclusa programma la sua
  // rimozione a 5 minuti, e `clear()` non annulla quel timer — Jest resterebbe
  // aperto dopo i test che inviano o rispondono.
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, retryDelay: 0 }, mutations: { gcTime: Infinity } },
  });
  clients.push(queryClient);
  const authValue: AuthContextValue = {
    status: "authenticated",
    client,
    user: { id: "viewer-1", email: "op@example.com", role: options.role ?? "admin", language: "it", avatarUrl: null, slackUserId: null },
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
              route={{ key: "AgentSession", name: "AgentSession", params: { id: SESSION_ID, focus: options.focus } } as never}
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

  test("il recupero finale va a pagine: una pagina piena (200) ne chiede un'altra, una corta si ferma", async () => {
    // 200 eventi dopo il 104 (una pagina PIENA), poi 2 (una pagina corta).
    const full: AgentSessionEvent[] = Array.from({ length: 200 }, (_, i) => ({
      id: String(105 + i),
      type: "assistant_text",
      segmentId: "s1",
      at: at(20),
      data: { text: `riga ${105 + i}` },
    }));
    const tail: AgentSessionEvent[] = [
      { id: "305", type: "assistant_text", segmentId: "s1", at: at(2), data: { text: "penultima" } },
      { id: "306", type: "assistant_text", segmentId: "s1", at: at(1), data: { text: "Ultima pagina arrivata" } },
    ];
    const events = jest.fn().mockImplementation(async (_id: string, page?: { after?: string; limit?: number }) => {
      if (!page?.after) return { events: FIRST_EVENTS, before: null };
      if (page.after === "104") return { events: full, before: null };
      if (page.after === "304") return { events: tail, before: null };
      return { events: [], before: null };
    });
    await renderScreen(makeClient({ events }));
    const xhr = await connection(0);
    await push(xhr, { type: "session", detail: ENDED });

    expect(await screen.findByText("Ultima pagina arrivata")).toBeTruthy();
    expect(events.mock.calls.map((c) => (c[1] as { after?: string } | undefined)?.after ?? null)).toEqual([
      null,
      "104",
      "304",
    ]);
    // Ogni pagina chiede il tetto del server: è così che una pagina corta si riconosce.
    expect((events.mock.calls[1]![1] as { limit?: number }).limit).toBe(200);
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

  test("app attiva: un altro 'active' non chiude né riapre lo stream", async () => {
    await renderScreen(makeClient());
    const first = await connection(0);
    await act(async () => setAppState("active"));
    expect(first.aborted).toBe(false);
    expect(FakeXhr.instances).toHaveLength(1);
  });

  test("app 'inactive' (centro notifiche, multitasking): lo stream resta aperto e i parziali restano", async () => {
    await renderScreen(makeClient());
    const first = await connection(0);
    await act(async () => first.respond(200));
    await push(first, { type: "partial", segmentId: "s1", text: "Ancora qui" });
    expect(await screen.findByText("Ancora qui")).toBeTruthy();
    await act(async () => setAppState("inactive"));
    expect(first.aborted).toBe(false);
    expect(FakeXhr.instances).toHaveLength(1);
    expect(screen.getByText("Ancora qui")).toBeTruthy();
    // Dall'inactive al ritorno attivo: nessuna connessione nuova.
    await act(async () => setAppState("active"));
    expect(FakeXhr.instances).toHaveLength(1);
  });

  test("lo stato iniziale si legge da AppState.currentState: partiti in background, lo stream aspetta l'active", async () => {
    const original = Object.getOwnPropertyDescriptor(AppState, "currentState");
    Object.defineProperty(AppState, "currentState", { value: "background", configurable: true, writable: true });
    try {
      await renderScreen(makeClient());
      expect(await screen.findByText(/router/)).toBeTruthy();
      expect(FakeXhr.instances).toHaveLength(0);
      await act(async () => setAppState("active"));
      const xhr = await connection(0);
      expect(xhr.after).toBe("104");
    } finally {
      if (original) Object.defineProperty(AppState, "currentState", original);
    }
  });

  test("un valore del provider ricreato (stesse dipendenze, oggetto nuovo) non riapre lo stream", async () => {
    const client = makeClient();
    const { view, queryClient, nav } = await renderScreen(client);
    const first = await connection(0);
    const authValue = {
      status: "authenticated",
      client,
      user: { id: "viewer-1", email: "op@example.com", role: "admin", language: "it", avatarUrl: null, slackUserId: null },
      justLoggedIn: false,
      login: jest.fn(),
      completeOnboarding: jest.fn(),
      openSettings: jest.fn(),
      loggedOut: jest.fn(),
    } as AuthContextValue;
    // Un genitore che ricrea il valore a ogni render (un oggetto letterale nel JSX).
    for (let i = 0; i < 2; i += 1) {
      await act(async () => {
        view.rerender(
          <QueryClientProvider client={queryClient}>
            <AuthContext.Provider value={authValue}>
              <AgentSessionStreamContext.Provider
                value={{
                  createXhr: FakeXhr.create,
                  loadSession: async () => ({ baseUrl: "https://stubwise.example", token: "stw_pat_x" }),
                  backoffMs: () => 60_000,
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
      });
    }
    expect(first.aborted).toBe(false);
    expect(FakeXhr.instances).toHaveLength(1);
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

/**
 * Task 7: scrivere all'agente e rispondere alle sue domande dalla sessione.
 * Gemello di «/agents/$id — scrivere e rispondere» del web: stesse regole,
 * con le mutazioni dell'app (`useAnswerQuestion`, `useAnswerBacklogQuestion`).
 */
describe("AgentSessionScreen — scrivere e rispondere", () => {
  const QUESTION_ID = "44444444-4444-4444-8444-444444444444";
  const QUESTION_ID_2 = "55555555-5555-4555-8555-555555555555";
  const BACKLOG_ITEM_ID = "66666666-6666-4666-8666-666666666666";
  const HINT = "Il messaggio arriva all'agente appena finisce l'azione in corso.";
  const HINT_INTERRUPT = "«Ferma e scrivi» interrompe prima.";
  const READ_ONLY = "Questo passo si può solo guardare.";

  type Question = AgentSessionDetail["questions"][number];

  function agentQuestion(overrides: Partial<Question> = {}): Question {
    return {
      id: QUESTION_ID,
      source: "agent",
      question: "Su quale API faccio il fix?",
      askedAt: at(45),
      answered: false,
      round: 1,
      options: [
        { label: "Tengo la vecchia API", consequence: "Nessun cambiamento" },
        { label: "Passo alla v2" },
      ],
      allowFreeText: false,
      canAnswer: true,
      ticketId: TICKET_ID,
      backlogItemId: null,
      ...overrides,
    } as Question;
  }

  function input(status: string, reason: string | null) {
    return {
      id: INPUT_ID,
      text: "Usa la API v2",
      status,
      reason,
      authorUserId: null,
      authorName: "ada@example.com",
      interrupt: false,
      createdAt: at(1),
    } as AgentSessionDetail["inputs"][number];
  }

  const field = () => screen.getByTestId("agent-composer-input");
  const disabled = (testID: string) =>
    screen.getByTestId(testID).props.accessibilityState?.disabled === true;

  /** Il dettaglio è arrivato: da qui l'assenza del campo è una decisione, non un caricamento. */
  async function waitForPage(client: StubwiseClient) {
    expect(await screen.findByText("Correggi il bug del login")).toBeTruthy();
    await waitFor(() => expect(client.agentSessions.events).toHaveBeenCalled());
  }

  test("due ruoli sugli stessi dati: il campo segue canWrite del server, non il ruolo (in entrambi i versi)", async () => {
    // Admin, ma il server dice canWrite: false → niente campo.
    let client = makeClient({ get: jest.fn().mockResolvedValue(detail({ canWrite: false })) });
    let view = (await renderScreen(client, focusNavigation(), 60_000, { role: "admin" })).view;
    await waitForPage(client);
    expect(screen.queryByTestId("agent-composer-input")).toBeNull();
    expect(screen.queryByTestId("agent-composer-send")).toBeNull();
    await act(async () => view.unmount());

    // Member, ma il server dice canWrite: true → il campo c'è (nessun canWrite && isAdmin nel client).
    client = makeClient({ get: jest.fn().mockResolvedValue(detail({ canWrite: true })) });
    view = (await renderScreen(client, focusNavigation(), 60_000, { role: "member" })).view;
    expect(await screen.findByTestId("agent-composer-input")).toBeTruthy();
    expect(screen.getByTestId("agent-composer-send")).toBeTruthy();
  });

  test("«Ferma e scrivi» e il suo suggerimento ci sono solo con canInterrupt; con canInterrupt manda interrupt: true", async () => {
    let client = makeClient({
      get: jest.fn().mockResolvedValue(detail({ canWrite: true, canInterrupt: false })),
    });
    const first = await renderScreen(client);
    expect(await screen.findByTestId("agent-composer-input")).toBeTruthy();
    expect(screen.getByText(HINT)).toBeTruthy();
    expect(screen.queryByText(HINT_INTERRUPT)).toBeNull();
    expect(screen.queryByTestId("agent-composer-interrupt")).toBeNull();
    await act(async () => first.view.unmount());

    client = makeClient({
      get: jest.fn().mockResolvedValue(detail({ canWrite: true, canInterrupt: true })),
    });
    await renderScreen(client);
    await fireEvent.changeText(
      await screen.findByTestId("agent-composer-input"),
      "Fermati, file sbagliato",
    );
    expect(screen.getByText(HINT_INTERRUPT)).toBeTruthy();
    await fireEvent.press(screen.getByTestId("agent-composer-interrupt"));
    await waitFor(() =>
      expect(client.agentSessions.send).toHaveBeenCalledWith(SESSION_ID, {
        text: "Fermati, file sbagliato",
        interrupt: true,
      }),
    );
  });

  test("testo vuoto o di soli spazi: bottoni spenti; tetto di 4000 caratteri", async () => {
    await renderScreen(
      makeClient({
        get: jest.fn().mockResolvedValue(detail({ canWrite: true, canInterrupt: true })),
      }),
    );
    await screen.findByTestId("agent-composer-input");
    expect(field().props.maxLength).toBe(4000);
    expect(disabled("agent-composer-send")).toBe(true);
    expect(disabled("agent-composer-interrupt")).toBe(true);
    await fireEvent.changeText(field(), "   ");
    expect(disabled("agent-composer-send")).toBe(true);
    expect(disabled("agent-composer-interrupt")).toBe(true);
    await fireEvent.changeText(field(), "ok");
    expect(disabled("agent-composer-send")).toBe(false);
    expect(disabled("agent-composer-interrupt")).toBe(false);
  });

  test("senza rete: bottoni spenti e il testo di sempre («Serve la rete»)", async () => {
    const useNetInfo = NetInfo.useNetInfo as jest.Mock;
    const online = useNetInfo();
    useNetInfo.mockReturnValue({ isConnected: false, isInternetReachable: false });
    try {
      await renderScreen(
        makeClient({
          get: jest.fn().mockResolvedValue(detail({ canWrite: true, canInterrupt: true })),
        }),
      );
      await fireEvent.changeText(await screen.findByTestId("agent-composer-input"), "ciao");
      expect(disabled("agent-composer-send")).toBe(true);
      expect(disabled("agent-composer-interrupt")).toBe(true);
      expect(screen.getByText("Serve la rete")).toBeTruthy();
    } finally {
      useNetInfo.mockReturnValue(online);
    }
  });

  test("invio: send(id, { text, interrupt: false }); la bolla arriva in consegna dal dettaglio riletto, poi «non consegnato» col motivo", async () => {
    let inputs: AgentSessionDetail["inputs"] = [];
    const planDetail = () => detail({ activeSegment: "plan", canWrite: true, inputs });
    const get = jest.fn().mockImplementation(async () => planDetail());
    const send = jest.fn().mockImplementation(async () => {
      inputs = [input("pending", null)];
      return { inputId: INPUT_ID, status: "pending" };
    });
    await renderScreen(makeClient({ get, send }));
    const xhr = await connection(0);

    await fireEvent.changeText(await screen.findByTestId("agent-composer-input"), "Usa la API v2");
    await fireEvent.press(screen.getByTestId("agent-composer-send"));
    await waitFor(() =>
      expect(send).toHaveBeenCalledWith(SESSION_ID, { text: "Usa la API v2", interrupt: false }),
    );
    // Nessuna bolla ottimistica: arriva dal dettaglio riletto, e solo allora il campo si svuota.
    expect(await screen.findByText(/in consegna…/)).toBeTruthy();
    expect(screen.getByText("Usa la API v2")).toBeTruthy();
    await waitFor(() => expect(field().props.value).toBe(""));

    // Il relay lo rifiuta: il piano aveva già dato il primo result.
    inputs = [input("undelivered", "stdin_closed")];
    await push(xhr, { type: "session", detail: planDetail() });
    expect(
      await screen.findByText(/non consegnato — l'agente non accettava più messaggi/),
    ).toBeTruthy();
    expect(screen.queryByText(/in consegna…/)).toBeNull();
    expect(send).toHaveBeenCalledTimes(1);
  });

  test("dopo l'invio i bottoni restano occupati e il campo in sola lettura finché il dettaglio riletto non porta la bolla", async () => {
    let inputs: AgentSessionDetail["inputs"] = [];
    let release: (() => void) | null = null;
    const get = jest.fn().mockImplementation(async () => {
      if (inputs.length > 0) await new Promise<void>((resolve) => (release = resolve));
      return detail({ canWrite: true, canInterrupt: true, inputs });
    });
    const send = jest.fn().mockImplementation(async () => {
      inputs = [input("pending", null)];
      return { inputId: INPUT_ID, status: "pending" };
    });
    await renderScreen(makeClient({ get, send }));
    await fireEvent.changeText(await screen.findByTestId("agent-composer-input"), "Usa la API v2");
    await fireEvent.press(screen.getByTestId("agent-composer-send"));
    await waitFor(() => expect(release).not.toBeNull());
    // TanStack notifica lo stato «in corso» con un timer a 0 ms, che può scattare
    // dopo che la rilettura è già partita: si aspetta lo stato, non si assume.
    await waitFor(() => expect(field().props.editable).toBe(false));
    // Il messaggio non è mai «da nessuna parte»: è ancora nel campo, e non si rimanda.
    expect(field().props.value).toBe("Usa la API v2");
    expect(disabled("agent-composer-send")).toBe(true);
    expect(disabled("agent-composer-interrupt")).toBe(true);
    await act(async () => release!());
    expect(await screen.findByText(/in consegna…/)).toBeTruthy();
    await waitFor(() => expect(field().props.value).toBe(""));
    expect(field().props.editable).not.toBe(false);
    expect(send).toHaveBeenCalledTimes(1);
  });

  test("l'invio sta sotto la chiave delle sessioni: il testo scritto resta fuori dalla persistenza", async () => {
    const { queryClient } = await renderScreen(
      makeClient({ get: jest.fn().mockResolvedValue(detail({ canWrite: true })) }),
    );
    await fireEvent.changeText(await screen.findByTestId("agent-composer-input"), "Testo privato");
    await fireEvent.press(screen.getByTestId("agent-composer-send"));
    await waitFor(() => expect(queryClient.getMutationCache().getAll()).toHaveLength(1));
    expect(queryClient.getMutationCache().getAll()[0]!.options.mutationKey).toEqual(agentSessionKeys.send(SESSION_ID));
  });

  test("«Ferma e scrivi» in corso: il bottone è spento e dice che sta fermando, «Scrivi» non gira", async () => {
    let release: (() => void) | null = null;
    const send = jest.fn().mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ inputId: INPUT_ID, status: "pending" });
        }),
    );
    await renderScreen(
      makeClient({ get: jest.fn().mockResolvedValue(detail({ canWrite: true, canInterrupt: true })), send }),
    );
    await fireEvent.changeText(await screen.findByTestId("agent-composer-input"), "Fermati");
    expect(screen.getByText("Ferma e scrivi")).toBeTruthy();
    await fireEvent.press(screen.getByTestId("agent-composer-interrupt"));
    await waitFor(() => expect(release).not.toBeNull());
    expect(await screen.findByText("Fermo l'agente…")).toBeTruthy();
    expect(screen.queryByText("Ferma e scrivi")).toBeNull();
    expect(disabled("agent-composer-interrupt")).toBe(true);
    // Lo spinner di «Scrivi» è solo per il suo invio.
    expect(screen.queryByTestId("agent-composer-send-spinner")).toBeNull();
    await act(async () => release!());
    expect(await screen.findByText("Ferma e scrivi")).toBeTruthy();
    expect(screen.queryByText("Fermo l'agente…")).toBeNull();
  });

  test.each([
    [409, "session_ended", "La sessione non è più attiva"],
    [409, "not_interactive", "Questo passo non accetta messaggi"],
    [409, "interrupt_unsupported", "Questo agente non si può interrompere"],
    [403, "forbidden", "Solo un maintainer può farlo."],
  ])("POST %i %s: messaggio tradotto, il testo resta nel campo", async (status, code, message) => {
    const send = jest.fn().mockRejectedValue(new ApiError(status, "parole del server", code));
    await renderScreen(
      makeClient({ get: jest.fn().mockResolvedValue(detail({ canWrite: true })), send }),
    );
    await fireEvent.changeText(
      await screen.findByTestId("agent-composer-input"),
      "Aggiorna anche la documentazione",
    );
    await fireEvent.press(screen.getByTestId("agent-composer-send"));
    expect(await screen.findByText(message)).toBeTruthy();
    expect(screen.queryByText("parole del server")).toBeNull();
    expect(field().props.value).toBe("Aggiorna anche la documentazione");
  });

  test.each([
    [
      "session_ended",
      "La sessione non è più attiva",
      { state: "ended", activeSegment: null, outcome: "completed" },
    ],
    ["not_interactive", "Questo passo non accetta messaggi", { activeSegment: "review" }],
  ] as const)(
    "409 %s col server vero (canWrite diventa false): il campo sparisce ma motivo e testo restano visibili",
    async (code, message, after) => {
      let current = detail({ canWrite: true });
      const get = jest.fn().mockImplementation(async () => current);
      const send = jest.fn().mockImplementation(async () => {
        current = detail({
          ...after,
          canWrite: false,
          canInterrupt: false,
        } as Partial<AgentSessionDetail>);
        throw new ApiError(409, "parole del server", code);
      });
      await renderScreen(makeClient({ get, send }));
      await fireEvent.changeText(
        await screen.findByTestId("agent-composer-input"),
        "Aggiorna anche la documentazione",
      );
      await fireEvent.press(screen.getByTestId("agent-composer-send"));
      // Il dettaglio riletto toglie il campo...
      await waitFor(() => expect(screen.queryByTestId("agent-composer-input")).toBeNull());
      // ...ma non quello che si era scritto, né il perché non è partito.
      expect(screen.getByText(`Non inviato: ${message}`)).toBeTruthy();
      const text = screen.getByText("Aggiorna anche la documentazione");
      expect(text.props.selectable).toBe(true);
    },
  );

  test("riga di sola lettura: solo con un segmento vivo NON interattivo (INTERACTIVE_SEGMENTS)", async () => {
    const cases: [string | null, boolean][] = [
      ["review", true],
      ["mystery_segment", true],
      ["execute", false],
      [null, false],
    ];
    for (const [activeSegment, shown] of cases) {
      const client = makeClient({
        get: jest
          .fn()
          .mockResolvedValue(
            detail({ canWrite: false, activeSegment } as Partial<AgentSessionDetail>),
          ),
      });
      const { view } = await renderScreen(client);
      await waitForPage(client);
      if (shown) expect(await screen.findByText(READ_ONLY)).toBeTruthy();
      else expect(screen.queryByText(READ_ONLY)).toBeNull();
      expect(screen.queryByTestId("agent-composer-input")).toBeNull();
      await act(async () => view.unmount());
    }
  });

  test("domanda dell'agente aperta con canAnswer: risponde con la rotta del ticket e invalida sessione, ticket e inbox", async () => {
    const client = makeClient({
      get: jest.fn().mockResolvedValue(detail({ questions: [agentQuestion()] })),
    });
    const { queryClient } = await renderScreen(client);
    const invalidate = jest.spyOn(queryClient, "invalidateQueries");
    expect(await screen.findByText("Su quale API faccio il fix?")).toBeTruthy();
    await fireEvent.press(screen.getByTestId(`session-question-${QUESTION_ID}-option-0`));
    await fireEvent.press(screen.getByTestId(`session-question-${QUESTION_ID}-submit`));
    await waitFor(() =>
      expect(client.tickets.answerQuestion).toHaveBeenCalledWith(TICKET_ID, QUESTION_ID, {
        optionIndex: 0,
      }),
    );
    await waitFor(() => {
      const keys = invalidate.mock.calls.map(([filters]) => filters?.queryKey);
      expect(keys).toContainEqual(agentSessionKeys.detail(SESSION_ID));
      expect(keys).toContainEqual(workKeys.all(TICKET_ID));
      expect(keys).toContainEqual(inboxKeys.all);
    });
  });

  test("una risposta rifiutata con 409 rilegge comunque la sessione", async () => {
    const answerTicketQuestion = jest
      .fn()
      .mockRejectedValue(new ApiError(409, "già", "already_answered"));
    const client = makeClient({
      get: jest.fn().mockResolvedValue(detail({ questions: [agentQuestion()] })),
      answerTicketQuestion,
    });
    const { queryClient } = await renderScreen(client);
    const invalidate = jest.spyOn(queryClient, "invalidateQueries");
    await screen.findByText("Su quale API faccio il fix?");
    await fireEvent.press(screen.getByTestId(`session-question-${QUESTION_ID}-option-1`));
    await fireEvent.press(screen.getByTestId(`session-question-${QUESTION_ID}-submit`));
    await waitFor(() => expect(answerTicketQuestion).toHaveBeenCalled());
    await waitFor(() => {
      const keys = invalidate.mock.calls.map(([filters]) => filters?.queryKey);
      expect(keys).toContainEqual(agentSessionKeys.detail(SESSION_ID));
      expect(keys).toContainEqual(inboxKeys.all);
    });
  });

  test("domanda aperta senza canAnswer, domanda di un server del piano A e domanda già risposta: solo testo", async () => {
    const legacy = {
      id: QUESTION_ID_2,
      source: "agent",
      question: "Domanda senza opzioni",
      askedAt: at(44),
      answered: false,
    } as unknown as Question;
    let client = makeClient({
      get: jest
        .fn()
        .mockResolvedValue(detail({ questions: [agentQuestion({ canAnswer: false }), legacy] })),
    });
    const first = await renderScreen(client);
    expect(await screen.findByText("Su quale API faccio il fix?")).toBeTruthy();
    expect(screen.getByText("Domanda senza opzioni")).toBeTruthy();
    expect(screen.queryByTestId(`session-question-${QUESTION_ID}-submit`)).toBeNull();
    expect(screen.queryByTestId(`session-question-${QUESTION_ID_2}-submit`)).toBeNull();
    expect(screen.queryByRole("radio")).toBeNull();
    await act(async () => first.view.unmount());

    client = makeClient({
      get: jest.fn().mockResolvedValue(detail({ questions: [agentQuestion({ answered: true })] })),
    });
    await renderScreen(client);
    expect(await screen.findByText("Su quale API faccio il fix?")).toBeTruthy();
    expect(screen.getByText(/Risposta data/)).toBeTruthy();
    expect(screen.queryByRole("radio")).toBeNull();
    expect(client.tickets.answerQuestion).not.toHaveBeenCalled();
  });

  test("domanda di backlog: risponde con la rotta della voce di backlog e invalida voce, sessione e inbox", async () => {
    const client = makeClient({
      get: jest.fn().mockResolvedValue(
        detail({
          kind: "backlog_item",
          ticketId: null,
          ticketNumber: null,
          questions: [
            agentQuestion({ source: "backlog", ticketId: null, backlogItemId: BACKLOG_ITEM_ID }),
          ],
        } as Partial<AgentSessionDetail>),
      ),
    });
    const { queryClient } = await renderScreen(client);
    const invalidate = jest.spyOn(queryClient, "invalidateQueries");
    await screen.findByText("Su quale API faccio il fix?");
    await fireEvent.press(screen.getByTestId(`session-question-${QUESTION_ID}-option-1`));
    await fireEvent.press(screen.getByTestId(`session-question-${QUESTION_ID}-submit`));
    await waitFor(() =>
      expect(client.backlog.answerQuestion).toHaveBeenCalledWith(BACKLOG_ITEM_ID, QUESTION_ID, {
        optionIndex: 1,
      }),
    );
    expect(client.tickets.answerQuestion).not.toHaveBeenCalled();
    await waitFor(() => {
      const keys = invalidate.mock.calls.map(([filters]) => filters?.queryKey);
      expect(keys).toContainEqual(backlogKeys.item(BACKLOG_ITEM_ID));
      expect(keys).toContainEqual(agentSessionKeys.detail(SESSION_ID));
      expect(keys).toContainEqual(inboxKeys.all);
    });
  });

  test("focus: question — la lista scorre alla prima domanda APERTA (non a quella già risposta)", async () => {
    // La lista vera, vista dallo spy: l'indice va letto sui SUOI dati (invertiti).
    let listData: readonly { id: string }[] = [];
    const scrollToIndex = jest
      .spyOn(FlatList.prototype, "scrollToIndex")
      .mockImplementation(function (this: FlatList<{ id: string }>) {
        listData = (this.props.data ?? []) as readonly { id: string }[];
      });
    try {
      const questions = [
        agentQuestion({
          id: QUESTION_ID_2,
          question: "Quella vecchia",
          answered: true,
          askedAt: at(55),
        }),
        agentQuestion(),
      ];
      await renderScreen(
        makeClient({ get: jest.fn().mockResolvedValue(detail({ questions })) }),
        focusNavigation(),
        60_000,
        {
          focus: "question",
        },
      );
      expect(await screen.findByText("Su quale API faccio il fix?")).toBeTruthy();
      await waitFor(() => expect(scrollToIndex).toHaveBeenCalledTimes(1));
      const [{ index }] = scrollToIndex.mock.calls[0]! as [{ index: number }];
      expect(listData[index]!.id).toBe(`question:${QUESTION_ID}`);
      // Non il primo né l'ultimo elemento: l'indice è calcolato, non un caso fortunato.
      expect(index).toBeGreaterThan(0);
      expect(index).toBeLessThan(listData.length - 1);
    } finally {
      scrollToIndex.mockRestore();
    }
  });

  test("focus: question — se la domanda arriva DOPO il caricamento (frame session), la lista ci scorre allora, una volta", async () => {
    const scrollToIndex = jest
      .spyOn(FlatList.prototype, "scrollToIndex")
      .mockImplementation(() => {});
    try {
      await renderScreen(makeClient(), focusNavigation(), 60_000, { focus: "question" });
      const xhr = await connection(0);
      expect(scrollToIndex).not.toHaveBeenCalled();
      await push(xhr, { type: "session", detail: detail({ questions: [agentQuestion()] }) });
      expect(await screen.findByText("Su quale API faccio il fix?")).toBeTruthy();
      await waitFor(() => expect(scrollToIndex).toHaveBeenCalledTimes(1));
      // Un altro frame non riporta la lista sulla domanda: chi legge può essersi spostato.
      await push(xhr, {
        type: "session",
        detail: detail({ lastEventAt: at(1), questions: [agentQuestion()] }),
      });
      expect(scrollToIndex).toHaveBeenCalledTimes(1);
    } finally {
      scrollToIndex.mockRestore();
    }
  });

  /**
   * Come la lista vera quando la domanda sta oltre gli elementi misurati: il
   * primo `scrollToIndex` fallisce e chiama `onScrollToIndexFailed`, che
   * riprova dopo 100 ms.
   */
  function failingFirstScroll() {
    let failed = false;
    const scrollToOffset = jest.spyOn(FlatList.prototype, "scrollToOffset").mockImplementation(() => {});
    const scrollToIndex = jest
      .spyOn(FlatList.prototype, "scrollToIndex")
      .mockImplementation(function (this: FlatList<unknown>, params: { index: number }) {
        if (failed) return;
        failed = true;
        this.props.onScrollToIndexFailed?.({ index: params.index, highestMeasuredFrameIndex: 0, averageItemLength: 40 });
      });
    return {
      scrollToIndex,
      restore() {
        scrollToIndex.mockRestore();
        scrollToOffset.mockRestore();
      },
    };
  }

  test("focus: question — se lo scorrimento fallisce, riprova una volta dopo 100 ms", async () => {
    jest.useFakeTimers();
    const spies = failingFirstScroll();
    try {
      await renderScreen(
        makeClient({ get: jest.fn().mockResolvedValue(detail({ questions: [agentQuestion()] })) }),
        focusNavigation(),
        60_000,
        { focus: "question" },
      );
      await waitFor(() => expect(spies.scrollToIndex).toHaveBeenCalledTimes(1));
      await act(async () => {
        await jest.advanceTimersByTimeAsync(100);
      });
      expect(spies.scrollToIndex).toHaveBeenCalledTimes(2);
    } finally {
      spies.restore();
      jest.useRealTimers();
    }
  });

  test("focus: question — smontata prima dei 100 ms, il nuovo tentativo non parte", async () => {
    jest.useFakeTimers();
    const spies = failingFirstScroll();
    const setTimeoutSpy = jest.spyOn(globalThis, "setTimeout");
    const clearTimeoutSpy = jest.spyOn(globalThis, "clearTimeout");
    try {
      const { view } = await renderScreen(
        makeClient({ get: jest.fn().mockResolvedValue(detail({ questions: [agentQuestion()] })) }),
        focusNavigation(),
        60_000,
        { focus: "question" },
      );
      await waitFor(() => expect(spies.scrollToIndex).toHaveBeenCalledTimes(1));
      // Il timer del nuovo tentativo: l'unico da 100 ms programmato dal fallimento.
      const retry = setTimeoutSpy.mock.calls.findIndex(([, delay]) => delay === 100);
      expect(retry).toBeGreaterThanOrEqual(0);
      const retryId = setTimeoutSpy.mock.results[retry]!.value as unknown;
      await act(async () => view.unmount());
      expect(clearTimeoutSpy).toHaveBeenCalledWith(retryId);
      await act(async () => {
        await jest.advanceTimersByTimeAsync(100);
      });
      expect(spies.scrollToIndex).toHaveBeenCalledTimes(1);
    } finally {
      setTimeoutSpy.mockRestore();
      clearTimeoutSpy.mockRestore();
      spies.restore();
      jest.useRealTimers();
    }
  });

  test("senza focus la lista non scorre da sola alla domanda", async () => {
    const scrollToIndex = jest
      .spyOn(FlatList.prototype, "scrollToIndex")
      .mockImplementation(() => {});
    try {
      await renderScreen(
        makeClient({ get: jest.fn().mockResolvedValue(detail({ questions: [agentQuestion()] })) }),
      );
      expect(await screen.findByText("Su quale API faccio il fix?")).toBeTruthy();
      expect(scrollToIndex).not.toHaveBeenCalled();
    } finally {
      scrollToIndex.mockRestore();
    }
  });
});
