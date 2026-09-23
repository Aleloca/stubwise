import type { StubwiseClient } from "@stubwise/api-client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import { AuthContext } from "../../app/auth-context";
import type { AuthContextValue } from "../../app/providers";
import "../../i18n";
import { ServerScreen } from "./ServerScreen";

const SERVER_ID = "11111111-1111-4111-8111-111111111111";
const NOW = Date.parse("2026-09-23T10:00:00.000Z");
const GB = 1024 ** 3;

/**
 * Il dettaglio COMPLETO: nei test `readerSchema` non gira, quindi ogni campo
 * che la rotta manda sta qui — memoria compresa. Il caso del server più
 * vecchio, SENZA memoria, lo costruisce apposta il test che lo riguarda.
 */
function detail(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: SERVER_ID,
    name: "prod-web-1",
    hostname: "web1.acme.test",
    status: "online",
    sampleIntervalSeconds: 30,
    agentVersion: "1.4.0",
    alertThresholds: { cpuPct: 95, memPct: 90, diskPct: 90, sustainedMinutes: 5 },
    lastSeenAt: "2026-09-23T09:59:40.000Z",
    createdAt: "2026-08-01T10:00:00.000Z",
    projects: [],
    checksUp: 3,
    checksDown: 1,
    recentCpu: [10, 20, 42.4],
    services: [
      { source: "docker", name: "api", state: "running", cpuPct: 4.2, memBytes: 512 * 1024 ** 2, restarts: null },
      { source: "pm2", name: "worker", state: "online", cpuPct: null, memBytes: null, restarts: 2 },
    ],
    disks: [
      { mount: "/", usedBytes: 40 * GB, totalBytes: 100 * GB },
      { mount: "/data", usedBytes: 1 * GB, totalBytes: 4 * GB },
    ],
    metricsAt: "2026-09-23T09:59:40.000Z",
    memUsedBytes: 3 * GB,
    memTotalBytes: 4 * GB,
    ...overrides,
  };
}

function makeClient(get?: jest.Mock): StubwiseClient {
  return {
    servers: { get: get ?? jest.fn().mockResolvedValue(detail()) },
  } as unknown as StubwiseClient;
}

async function renderScreen(client: StubwiseClient, goBack: jest.Mock = jest.fn()) {
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
  const navigation = { goBack, navigate: jest.fn() } as never;
  await render(
    <QueryClientProvider client={queryClient}>
      <AuthContext.Provider value={authValue}>
        <ServerScreen
          navigation={navigation}
          route={{ key: "Server", name: "Server", params: { serverId: SERVER_ID, projectName: "Portale B2B" } }}
        />
      </AuthContext.Provider>
    </QueryClientProvider>,
  );
  return { goBack };
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(Date, "now").mockReturnValue(NOW);
});

afterEach(() => jest.restoreAllMocks());

describe("ServerScreen", () => {
  test("chiede il server per ID", async () => {
    const get = jest.fn().mockResolvedValue(detail());
    await renderScreen(makeClient(get));
    await waitFor(() => expect(get).toHaveBeenCalledWith(SERVER_ID));
  });

  test("il cruscotto pieno: CPU, memoria, dischi, controlli, servizi, agente", async () => {
    await renderScreen(makeClient());
    await waitFor(() => expect(screen.getByTestId("server-cpu-now")).toBeTruthy());
    expect(screen.getByTestId("server-cpu-now").props.children).toBe("42%");
    expect(screen.getByTestId("server-cpu-sparkline")).toBeTruthy();
    expect(screen.getByTestId("server-memory").props.children).toBe("3 GB di 4 GB");
    expect(screen.getByTestId("server-disk-/")).toBeTruthy();
    expect(screen.getByText("40 GB di 100 GB")).toBeTruthy();
    expect(screen.getByTestId("server-disk-/data")).toBeTruthy();
    expect(screen.getByTestId("server-checks").props.children).toBe("3 controlli su · 1 giù");
    expect(screen.getByTestId("server-service-api")).toBeTruthy();
    expect(screen.getByText("pm2 · 2 riavvii")).toBeTruthy();
    expect(screen.getByTestId("server-agent-version").props.children).toBe("1.4.0");
  });

  test("campione fresco: nessun avviso", async () => {
    await renderScreen(makeClient());
    await waitFor(() => expect(screen.getByTestId("server-sample")).toBeTruthy());
    expect(screen.queryByTestId("server-stale-warning")).toBeNull();
  });

  /**
   * ⚠️ Numeri di due ore fa mostrati come attuali sono una bugia. Il server
   * è ancora `online` per il suo stato, ma l'ultimo campione è vecchio: la
   * schermata lo dice, prima dei numeri.
   */
  test("campione vecchio: la schermata lo dice", async () => {
    await renderScreen(makeClient(jest.fn().mockResolvedValue(detail({ metricsAt: "2026-09-23T08:00:00.000Z" }))));
    await waitFor(() => expect(screen.getByTestId("server-stale-warning")).toBeTruthy());
    expect(screen.getByTestId("server-stale-warning").props.children).toBe(
      "L'ultimo campione è di 2 h fa: i numeri qui sotto potrebbero non essere più veri.",
    );
  });

  /**
   * ⚠️ Un server che non ha mai mandato campioni NON ha numeri: niente «0%»,
   * niente «0 GB». Lo si dice, e le sezioni dei numeri non compaiono.
   */
  test("mai connesso: si dice, e nessun numero falso", async () => {
    await renderScreen(
      makeClient(
        jest.fn().mockResolvedValue(
          detail({
            status: "never_connected",
            hostname: null,
            agentVersion: null,
            lastSeenAt: null,
            checksUp: 0,
            checksDown: 0,
            recentCpu: [],
            services: [],
            disks: [],
            metricsAt: null,
            memUsedBytes: null,
            memTotalBytes: null,
          }),
        ),
      ),
    );
    await waitFor(() => expect(screen.getByTestId("server-never-connected")).toBeTruthy());
    expect(screen.getByTestId("server-status").props.children).toBe("Mai connesso");
    expect(screen.queryByTestId("server-cpu-now")).toBeNull();
    expect(screen.queryByTestId("server-memory")).toBeNull();
    expect(screen.queryByText(/0%/)).toBeNull();
    expect(screen.queryByText(/0 B/)).toBeNull();
  });

  /**
   * ⚠️ SERVER PIÙ VECCHIO: ha campioni ma la risposta non porta la memoria
   * (il campo è arrivato il 23 set 2026). Il `.default(null)` dello schema,
   * in produzione, la fa arrivare come null; qui la simuliamo così. Si dice
   * che non è disponibile — mai «0 GB».
   */
  test("server che non manda la memoria: non disponibile, mai 0", async () => {
    await renderScreen(makeClient(jest.fn().mockResolvedValue(detail({ memUsedBytes: null, memTotalBytes: null }))));
    await waitFor(() => expect(screen.getByTestId("server-memory-unavailable")).toBeTruthy());
    expect(screen.queryByTestId("server-memory")).toBeNull();
    // Il resto del cruscotto c'è: la memoria mancante non costa la schermata.
    expect(screen.getByTestId("server-cpu-now")).toBeTruthy();
  });

  test("l'indietro torna da dove si è arrivati", async () => {
    const goBack = jest.fn();
    await renderScreen(makeClient(), goBack);
    await waitFor(() => expect(screen.getByTestId("server-cpu-now")).toBeTruthy());
    await fireEvent.press(screen.getByTestId("screen-header-back"));
    expect(goBack).toHaveBeenCalled();
  });

  test("errore: un messaggio con Riprova, che ricarica", async () => {
    const get = jest.fn().mockRejectedValueOnce(new Error("down")).mockResolvedValueOnce(detail());
    await renderScreen(makeClient(get));
    await waitFor(() => expect(screen.getByTestId("server-error")).toBeTruthy());
    await fireEvent.press(screen.getByTestId("server-retry"));
    await waitFor(() => expect(screen.getByTestId("server-cpu-now")).toBeTruthy());
  });
});
