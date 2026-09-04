import AsyncStorage from "@react-native-async-storage/async-storage";
import type { StubwiseClient } from "@stubwise/api-client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import NetInfo from "@react-native-community/netinfo";
import { AuthContext } from "../../app/auth-context";
import type { AuthContextValue } from "../../app/providers";
import "../../i18n";
import { CaptureSheet } from "./CaptureSheet";

const PROJECT_A = { id: "proj-a", name: "Portale B2B" };
const PROJECT_B = { id: "proj-b", name: "Piattaforma Acme" };

function makeClient(overrides: { create?: jest.Mock } = {}): StubwiseClient {
  return {
    backlog: {
      create: overrides.create ?? jest.fn().mockResolvedValue({ queued: true, jobId: "job-1" }),
      list: jest.fn(),
      get: jest.fn(),
      convert: jest.fn(),
      chat: jest.fn(),
      chatText: jest.fn(),
    },
  } as unknown as StubwiseClient;
}

async function renderSheet(
  client: StubwiseClient,
  overrides: Partial<React.ComponentProps<typeof CaptureSheet>> = {},
) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const onRequestClose = jest.fn();
  const onSubmitted = jest.fn();
  const authValue: AuthContextValue = {
    status: "authenticated",
    client,
    user: { id: "viewer-1", email: "op@example.com", role: "member", language: "it", avatarUrl: null, slackUserId: null },
    justLoggedIn: false,
    login: jest.fn(),
    completeOnboarding: jest.fn(),
  };
  await render(
    <QueryClientProvider client={queryClient}>
      <AuthContext.Provider value={authValue}>
        <CaptureSheet
          visible
          onRequestClose={onRequestClose}
          projects={[PROJECT_A, PROJECT_B]}
          onSubmitted={onSubmitted}
          testID="capture-sheet"
          {...overrides}
        />
      </AuthContext.Provider>
    </QueryClientProvider>,
  );
  return { onRequestClose, onSubmitted };
}

beforeEach(async () => {
  await AsyncStorage.clear();
  (NetInfo.useNetInfo as jest.Mock).mockReturnValue({ isConnected: true, isInternetReachable: true });
});

describe("CaptureSheet — visibilità e copy", () => {
  test("nascosta quando visible=false", async () => {
    const client = makeClient();
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await render(
      <QueryClientProvider client={queryClient}>
        <AuthContext.Provider
          value={{
            status: "authenticated",
            client,
            user: { id: "viewer-1", email: "a@b.c", role: "member", language: "it", avatarUrl: null, slackUserId: null },
            justLoggedIn: false,
            login: jest.fn(),
            completeOnboarding: jest.fn(),
          }}
        >
          <CaptureSheet visible={false} onRequestClose={jest.fn()} projects={[PROJECT_A]} onSubmitted={jest.fn()} />
        </AuthContext.Provider>
      </QueryClientProvider>,
    );
    expect(screen.queryByTestId("capture-sheet-input")).toBeNull();
  });

  test("titolo e hint dal canvas", async () => {
    await renderSheet(makeClient());
    expect(screen.getByText("Nuova idea")).toBeTruthy();
    expect(screen.getByText("// l'agente la trasforma in una voce con urgenza, effort e duplicati uniti")).toBeTruthy();
  });
});

describe("CaptureSheet — picker progetto (default: ultimo usato)", () => {
  test("senza storico: preseleziona il primo progetto della lista", async () => {
    await renderSheet(makeClient());
    await waitFor(() => expect(screen.getByText("Portale B2B ▾")).toBeTruthy());
  });

  test("con uno storico valido: preseleziona l'ultimo progetto usato (non il primo)", async () => {
    await AsyncStorage.setItem("stubwise:lastBacklogProjectId", PROJECT_B.id);
    await renderSheet(makeClient());
    await waitFor(() => expect(screen.getByText("Piattaforma Acme ▾")).toBeTruthy());
  });

  test("storico che punta a un progetto non più disponibile: ricade sul primo", async () => {
    await AsyncStorage.setItem("stubwise:lastBacklogProjectId", "proj-removed");
    await renderSheet(makeClient());
    await waitFor(() => expect(screen.getByText("Portale B2B ▾")).toBeTruthy());
  });

  test("tocca la pillola apre l'elenco; scegliere un progetto aggiorna la pillola e chiude l'elenco", async () => {
    await renderSheet(makeClient());
    await waitFor(() => expect(screen.getByText("Portale B2B ▾")).toBeTruthy());
    await fireEvent.press(screen.getByTestId("capture-sheet-project-toggle"));
    expect(screen.getByTestId("capture-sheet-project-list")).toBeTruthy();
    await fireEvent.press(screen.getByTestId(`capture-sheet-project-${PROJECT_B.id}`));
    expect(screen.getByText("Piattaforma Acme ▾")).toBeTruthy();
    expect(screen.queryByTestId("capture-sheet-project-list")).toBeNull();
  });
});

describe("CaptureSheet — invio", () => {
  test("submit disabilitato finché il testo è vuoto", async () => {
    await renderSheet(makeClient());
    const submit = screen.getByTestId("capture-sheet-submit");
    expect(submit.props.accessibilityState?.disabled).toBe(true);
  });

  test("invio: create riceve title/body derivati dall'UNICO campo di testo, e ricorda il progetto scelto per la prossima volta", async () => {
    const create = jest.fn().mockResolvedValue({ queued: true, jobId: "job-1" });
    const { onSubmitted } = await renderSheet(makeClient({ create }));
    await waitFor(() => expect(screen.getByText("Portale B2B ▾")).toBeTruthy());
    await fireEvent.press(screen.getByTestId("capture-sheet-project-toggle"));
    await fireEvent.press(screen.getByTestId(`capture-sheet-project-${PROJECT_B.id}`));

    await fireEvent.changeText(
      screen.getByTestId("capture-sheet-input"),
      "I clienti chiedono di salvare i carrelli come preventivi",
    );
    await fireEvent.press(screen.getByTestId("capture-sheet-submit"));

    await waitFor(() =>
      expect(create).toHaveBeenCalledWith({
        projectId: PROJECT_B.id,
        title: "I clienti chiedono di salvare i carrelli come preventivi",
        body: "I clienti chiedono di salvare i carrelli come preventivi",
      }),
    );
    await waitFor(() => expect(onSubmitted).toHaveBeenCalled());
    await waitFor(async () => expect(await AsyncStorage.getItem("stubwise:lastBacklogProjectId")).toBe(PROJECT_B.id));
  });

  test("errore del server: mostra il messaggio, non chiama onSubmitted", async () => {
    const { ApiError } = jest.requireActual("@stubwise/api-client");
    const create = jest.fn().mockRejectedValue(new ApiError(500, "boom"));
    const { onSubmitted } = await renderSheet(makeClient({ create }));
    await fireEvent.changeText(screen.getByTestId("capture-sheet-input"), "Un'idea qualunque");
    await fireEvent.press(screen.getByTestId("capture-sheet-submit"));
    await waitFor(() => expect(screen.getByText("Qualcosa è andato storto. Riprova.")).toBeTruthy());
    expect(onSubmitted).not.toHaveBeenCalled();
  });

  test("offline: il bottone mostra 'Serve la rete' ed è disabilitato", async () => {
    (NetInfo.useNetInfo as jest.Mock).mockReturnValue({ isConnected: false, isInternetReachable: false });
    await renderSheet(makeClient());
    await fireEvent.changeText(screen.getByTestId("capture-sheet-input"), "Un'idea qualunque");
    // Compare due volte: la notice E la label del bottone dicono la stessa cosa.
    expect(screen.getAllByText("Serve la rete").length).toBeGreaterThanOrEqual(2);
    expect(screen.getByTestId("capture-sheet-submit").props.accessibilityState?.disabled).toBe(true);
  });

  test("Annulla chiama onRequestClose", async () => {
    const { onRequestClose } = await renderSheet(makeClient());
    await fireEvent.press(screen.getByTestId("capture-sheet-cancel"));
    expect(onRequestClose).toHaveBeenCalled();
  });

  test("nessun progetto disponibile: avviso dedicato, submit resta disabilitato", async () => {
    await renderSheet(makeClient(), { projects: [] });
    expect(screen.getByText("Nessun progetto disponibile.")).toBeTruthy();
    await fireEvent.changeText(screen.getByTestId("capture-sheet-input"), "Un'idea qualunque");
    expect(screen.getByTestId("capture-sheet-submit").props.accessibilityState?.disabled).toBe(true);
  });
});
