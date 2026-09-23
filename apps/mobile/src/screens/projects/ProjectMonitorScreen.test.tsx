import type { StubwiseClient } from "@stubwise/api-client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import { AuthContext } from "../../app/auth-context";
import type { AuthContextValue } from "../../app/providers";
import "../../i18n";
import { ProjectMonitorScreen } from "./ProjectMonitorScreen";

const PROJECT_ID = "22222222-2222-4222-8222-222222222222";
const NOW = Date.parse("2026-09-23T10:00:00.000Z");

function server(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "s1",
    name: "prod-web-1",
    hostname: "web1.acme.test",
    status: "online",
    sampleIntervalSeconds: 30,
    agentVersion: "1.4.0",
    alertThresholds: { cpuPct: 95, memPct: 90, diskPct: 90, sustainedMinutes: 5 },
    lastSeenAt: "2026-09-23T09:48:00.000Z",
    createdAt: "2026-08-01T10:00:00.000Z",
    projects: [{ id: PROJECT_ID, name: "Portale B2B" }],
    checksUp: 3,
    checksDown: 1,
    recentCpu: [10, 25.4],
    ...overrides,
  };
}

function makeClient(list?: jest.Mock): StubwiseClient {
  return {
    servers: { list: list ?? jest.fn().mockResolvedValue([server()]) },
  } as unknown as StubwiseClient;
}

async function renderScreen(client: StubwiseClient, navigate: jest.Mock = jest.fn()) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
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
  const navigation = { goBack: jest.fn(), navigate } as never;
  await render(
    <QueryClientProvider client={queryClient}>
      <AuthContext.Provider value={authValue}>
        <ProjectMonitorScreen
          navigation={navigation}
          route={{
            key: "ProjectMonitor",
            name: "ProjectMonitor",
            params: { projectId: PROJECT_ID, projectName: "Portale B2B" },
          }}
        />
      </AuthContext.Provider>
    </QueryClientProvider>,
  );
  return { navigate };
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(Date, "now").mockReturnValue(NOW);
});

afterEach(() => jest.restoreAllMocks());

describe("ProjectMonitorScreen", () => {
  test("chiede i server del progetto", async () => {
    const list = jest.fn().mockResolvedValue([]);
    await renderScreen(makeClient(list));
    await waitFor(() => expect(list).toHaveBeenCalledWith(PROJECT_ID));
  });

  test("una card per server, con CPU, controlli e ultimo contatto", async () => {
    await renderScreen(makeClient());
    await waitFor(() => expect(screen.getByTestId("server-card-s1")).toBeTruthy());
    expect(screen.getByTestId("server-card-summary-s1").props.children).toBe(
      "CPU 25% · 3 controlli su · 1 giù · visto 12 min fa",
    );
  });

  /** ⚠️ Mai connesso: nessun numero, lo stato dice già tutto. */
  test("server mai connesso: nessuna riga di numeri", async () => {
    await renderScreen(
      makeClient(
        jest.fn().mockResolvedValue([
          server({ status: "never_connected", lastSeenAt: null, recentCpu: [], checksUp: 0, checksDown: 0 }),
        ]),
      ),
    );
    await waitFor(() => expect(screen.getByTestId("server-card-s1")).toBeTruthy());
    expect(screen.getByTestId("server-card-status-s1").props.children).toBe("Mai connesso");
    expect(screen.queryByTestId("server-card-summary-s1")).toBeNull();
  });

  test("un tap apre il cruscotto del server", async () => {
    const navigate = jest.fn();
    await renderScreen(makeClient(), navigate);
    await waitFor(() => expect(screen.getByTestId("server-card-s1")).toBeTruthy());
    await fireEvent.press(screen.getByTestId("server-card-s1"));
    expect(navigate).toHaveBeenCalledWith("Server", { serverId: "s1", projectName: "Portale B2B" });
  });

  test("nessun server: lo dice", async () => {
    await renderScreen(makeClient(jest.fn().mockResolvedValue([])));
    await waitFor(() => expect(screen.getByTestId("project-monitor-empty")).toBeTruthy());
  });

  test("errore: un messaggio con Riprova, che ricarica", async () => {
    const list = jest.fn().mockRejectedValueOnce(new Error("down")).mockResolvedValueOnce([server()]);
    await renderScreen(makeClient(list));
    await waitFor(() => expect(screen.getByTestId("project-monitor-error")).toBeTruthy());
    await fireEvent.press(screen.getByTestId("project-monitor-retry"));
    await waitFor(() => expect(screen.getByTestId("server-card-s1")).toBeTruthy());
  });
});
