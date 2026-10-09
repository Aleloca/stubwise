import { NavigationContext } from "@react-navigation/native";
import { ApiError, type StubwiseClient } from "@stubwise/api-client";
import type { AgentSessionSummary } from "@stubwise/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react-native";
import { AuthContext } from "../../app/auth-context";
import type { AuthContextValue } from "../../app/providers";
import "../../i18n";
import { AgentsScreen } from "./AgentsScreen";

const NOW = new Date().toISOString();

/** Una sessione COMPLETA (il client è un doppio: il parse non gira, la fixture arriva così com'è). */
function session(overrides: Partial<AgentSessionSummary> = {}): AgentSessionSummary {
  return {
    id: "s-live",
    kind: "ai_job",
    title: "Correggi il bug dei ticket",
    projectId: "p1",
    projectName: "Alfa",
    ticketId: "t1",
    ticketNumber: 12,
    startedAt: NOW,
    lastEventAt: NOW,
    state: "working",
    activeSegment: "execute",
    lastActivity: { kind: "edit", target: "routes/tickets.ts" },
    aiJobId: "j1",
    outcome: null,
    ...overrides,
  };
}

const LIVE = session();
const FAILED = session({ id: "s-failed", title: "Fix fallito", state: "ended", lastActivity: null, outcome: "failed" });
const DONE = session({ id: "s-done", title: "Fix riuscito", state: "ended", lastActivity: null, outcome: "completed" });

function makeClient(overrides: { list?: jest.Mock; projects?: jest.Mock } = {}): StubwiseClient {
  return {
    agentSessions: {
      list: overrides.list ?? jest.fn().mockResolvedValue({ live: [LIVE], recent: [FAILED, DONE] }),
      get: jest.fn(),
      events: jest.fn(),
      send: jest.fn(),
      streamPath: jest.fn(),
    },
    projects: {
      list:
        overrides.projects ??
        jest.fn().mockResolvedValue([
          { id: "p1", name: "Alfa" },
          { id: "p2", name: "Beta" },
        ]),
    },
  } as unknown as StubwiseClient;
}

const clients: QueryClient[] = [];
afterEach(() => {
  // Niente QueryClient vivi a fine test: i timer di gc tengono aperto il processo.
  clients.splice(0).forEach((c) => c.clear());
});

async function renderScreen(client: StubwiseClient, focusNavigation?: object) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, retryDelay: 0 } } });
  clients.push(queryClient);
  const navigate = jest.fn();
  const authValue: AuthContextValue = {
    status: "authenticated",
    client,
    user: { id: "viewer-1", email: "op@example.com", role: "member", language: "it", avatarUrl: null, slackUserId: null },
    justLoggedIn: false,
    login: jest.fn(),
    completeOnboarding: jest.fn(),
    openSettings: jest.fn(),
    loggedOut: jest.fn(),
  };
  const screenEl = (
    <AgentsScreen navigation={{ navigate } as never} route={{ key: "List", name: "List", params: undefined } as never} />
  );
  await render(
    <QueryClientProvider client={queryClient}>
      <AuthContext.Provider value={authValue}>
        {focusNavigation ? (
          <NavigationContext.Provider value={focusNavigation as never}>{screenEl}</NavigationContext.Provider>
        ) : (
          screenEl
        )}
      </AuthContext.Provider>
    </QueryClientProvider>,
  );
  return { navigate, queryClient };
}

describe("AgentsScreen", () => {
  test("riga viva: titolo, progetto e numero, stato, durata e ultima azione", async () => {
    await renderScreen(makeClient());
    await waitFor(() => expect(screen.getByTestId("agent-row-s-live")).toBeTruthy());
    const row = within(screen.getByTestId("agent-row-s-live"));
    expect(row.getByText("Correggi il bug dei ticket")).toBeTruthy();
    expect(row.getByText("Alfa #12")).toBeTruthy();
    expect(row.getByText("sta modificando routes/tickets.ts")).toBeTruthy();
    expect(row.getByText("al lavoro")).toBeTruthy();
    expect(row.getByText("da 0 min")).toBeTruthy();
  });

  test("fixture SENZA lastActivity/outcome/aiJobId: nessun crash, riga mostrata", async () => {
    const bare = { ...LIVE } as Partial<AgentSessionSummary>;
    delete bare.lastActivity;
    delete bare.outcome;
    delete bare.aiJobId;
    const ended = { ...DONE } as Partial<AgentSessionSummary>;
    delete ended.outcome;
    await renderScreen(makeClient({ list: jest.fn().mockResolvedValue({ live: [bare], recent: [ended] }) }));
    await waitFor(() => expect(screen.getByTestId("agent-row-s-live")).toBeTruthy());
    expect(screen.getByTestId("agent-row-s-done")).toBeTruthy();
    // Esito assente → nessuna etichetta NELLA riga (il chip del filtro la ha, la riga no).
    expect(within(screen.getByTestId("agent-row-s-done")).queryByText("completata")).toBeNull();
  });

  test("404 senza code: «non disponibile», nessuna riga, UNA sola chiamata", async () => {
    const list = jest.fn().mockRejectedValue(new ApiError(404, "not found"));
    await renderScreen(makeClient({ list }));
    await waitFor(() => expect(screen.getByTestId("agents-unavailable")).toBeTruthy());
    expect(screen.getByText("Le sessioni degli agenti non sono disponibili su questa istanza.")).toBeTruthy();
    expect(screen.queryByTestId("agent-row-s-live")).toBeNull();
    expect(list).toHaveBeenCalledTimes(1);
  });

  test("404 CON code: è un errore normale, non «non disponibile»", async () => {
    const list = jest.fn().mockRejectedValue(new ApiError(404, "x", "not_found"));
    await renderScreen(makeClient({ list }));
    await waitFor(() => expect(screen.getByTestId("agents-error")).toBeTruthy());
    expect(screen.queryByTestId("agents-unavailable")).toBeNull();
  });

  test("filtro «fallita»: resta la sola sessione failed", async () => {
    await renderScreen(makeClient());
    await waitFor(() => expect(screen.getByTestId("agent-row-s-done")).toBeTruthy());
    await fireEvent.press(screen.getByTestId("agents-outcome-failed"));
    expect(screen.getByTestId("agent-row-s-failed")).toBeTruthy();
    expect(screen.queryByTestId("agent-row-s-done")).toBeNull();
  });

  test("filtro progetto: chiede al server con projectId e tiene l'elenco precedente nel frattempo", async () => {
    let resolveFiltered: (v: unknown) => void = () => {};
    const list = jest.fn().mockImplementation((filters?: { projectId?: string }) =>
      filters?.projectId
        ? new Promise((resolve) => {
            resolveFiltered = resolve;
          })
        : Promise.resolve({ live: [LIVE], recent: [FAILED, DONE] }),
    );
    await renderScreen(makeClient({ list }));
    await waitFor(() => expect(screen.getByTestId("agents-project-p2")).toBeTruthy());
    await fireEvent.press(screen.getByTestId("agents-project-p2"));
    await waitFor(() => expect(list).toHaveBeenLastCalledWith({ projectId: "p2" }));
    // Nessun lampo di vuoto: le righe di prima restano finché non arriva la risposta.
    expect(screen.getByTestId("agent-row-s-live")).toBeTruthy();
    resolveFiltered({ live: [], recent: [DONE] });
    await waitFor(() => expect(screen.queryByTestId("agent-row-s-live")).toBeNull());
    expect(screen.getByTestId("agent-row-s-done")).toBeTruthy();
  });

  test("tap su una riga: navigate(\"AgentSession\", { id })", async () => {
    const { navigate } = await renderScreen(makeClient());
    await waitFor(() => expect(screen.getByTestId("agent-row-s-live")).toBeTruthy());
    await fireEvent.press(screen.getByTestId("agent-row-s-live"));
    expect(navigate).toHaveBeenCalledWith("AgentSession", { id: "s-live" });
    await fireEvent.press(screen.getByTestId("agent-row-s-done"));
    expect(navigate).toHaveBeenCalledWith("AgentSession", { id: "s-done" });
  });

  test("esito e quando sulle concluse; stati vuoti", async () => {
    await renderScreen(makeClient({ list: jest.fn().mockResolvedValue({ live: [], recent: [FAILED] }) }));
    await waitFor(() => expect(screen.getByTestId("agent-row-s-failed")).toBeTruthy());
    expect(within(screen.getByTestId("agent-row-s-failed")).getByText("fallita")).toBeTruthy();
    expect(screen.getByText("// nessun agente al lavoro")).toBeTruthy();
  });

  test("projects.list che RIFIUTA: niente chip dei progetti, il resto della schermata è intatto", async () => {
    const projects = jest.fn().mockRejectedValue(new ApiError(500, "boom"));
    await renderScreen(makeClient({ projects }));
    await waitFor(() => expect(screen.getByTestId("agent-row-s-live")).toBeTruthy());
    await waitFor(() => expect(projects).toHaveBeenCalled());
    expect(screen.queryByTestId("agents-project-p1")).toBeNull();
    expect(screen.queryByTestId("agents-error")).toBeNull();
    expect(screen.getByTestId("agent-row-s-failed")).toBeTruthy();
    await fireEvent.press(screen.getByTestId("agents-outcome-completed"));
    expect(screen.getByTestId("agent-row-s-done")).toBeTruthy();
    expect(screen.queryByTestId("agent-row-s-failed")).toBeNull();
  });

  test("fuori fuoco il polling si ferma", async () => {
    jest.useFakeTimers();
    try {
      const handlers: Record<string, () => void> = {};
      const nav = {
        isFocused: () => true,
        addListener: (ev: string, cb: () => void) => {
          handlers[ev] = cb;
          return () => {};
        },
      };
      const client = makeClient();
      await renderScreen(client, nav);
      const list = client.agentSessions.list as jest.Mock;
      await waitFor(() => expect(list).toHaveBeenCalledTimes(1));
      await act(async () => {
        await jest.advanceTimersByTimeAsync(5_100);
      });
      expect(list.mock.calls.length).toBeGreaterThanOrEqual(2); // a fuoco: polla
      await act(async () => {
        handlers["blur"]?.();
      });
      const before = list.mock.calls.length;
      await act(async () => {
        await jest.advanceTimersByTimeAsync(20_000);
      });
      expect(list).toHaveBeenCalledTimes(before);
    } finally {
      jest.useRealTimers();
    }
  });
});
