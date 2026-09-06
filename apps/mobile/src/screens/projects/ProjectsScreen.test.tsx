import type { StubwiseClient } from "@stubwise/api-client";
import type { ProjectPulseSummary, Reader } from "@stubwise/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import { AuthContext } from "../../app/auth-context";
import type { AuthContextValue } from "../../app/providers";
import "../../i18n";
import { ProjectsScreen } from "./ProjectsScreen";

function summary(overrides: Partial<Reader<ProjectPulseSummary>>): Reader<ProjectPulseSummary> {
  return {
    projectId: "11111111-1111-4111-8111-111111111111",
    projectName: "Portale B2B",
    waitingForYou: [],
    waitingForOthers: [],
    running: [],
    failedCount: 0,
    backlogReadyCount: 0,
    idleDays: 0,
    lastReportDate: null,
    ...overrides,
  };
}

const WAITING = summary({
  projectId: "11111111-1111-4111-8111-111111111111",
  projectName: "Portale B2B",
  waitingForYou: [
    {
      kind: "question",
      ticketId: "22222222-2222-4222-8222-222222222222",
      ticketNumber: 245,
      title: "Cache immagini",
      notificationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    },
  ],
  backlogReadyCount: 4,
});

const RUNNING = summary({
  projectId: "33333333-3333-4333-8333-333333333333",
  projectName: "Piattaforma Acme",
  running: [{ ticketId: "44444444-4444-4444-8444-444444444444", ticketNumber: 12, title: "Export CSV", sinceMinutes: 25 }],
});

const IDLE = summary({
  projectId: "55555555-5555-4555-8555-555555555555",
  projectName: "Sito vetrina",
  idleDays: 6,
  backlogReadyCount: 2,
});

function makeClient(pulse: jest.Mock): StubwiseClient {
  return { projects: { pulse } } as unknown as StubwiseClient;
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
  };
  const navigation = { navigate } as never;
  // `await`, non solo `render(...)`: qui `render` può tornare una Promise
  // (l'act() interno che avvolge l'update asincrono di `useQuery` — succede
  // quando la query non risolve MAI, come nel test "caricamento"). Restituirla
  // dentro `{ rendered, navigate }` invece di un valore diretto rompe
  // l'adozione automatica della Promise da parte della funzione async
  // chiamante: chi fa `await renderScreen(...)` otterrebbe `rendered` ancora
  // pendente, e un `getByTestId` immediato dopo (senza `waitFor`) fallirebbe
  // con "render function has not been called" — verificato: è la causa esatta
  // del primo rosso incontrato scrivendo questo test.
  const rendered = await render(
    <QueryClientProvider client={queryClient}>
      <AuthContext.Provider value={authValue}>
        <ProjectsScreen navigation={navigation} route={{ key: "List", name: "List", params: undefined }} />
      </AuthContext.Provider>
    </QueryClientProvider>,
  );
  return { rendered, navigate };
}

beforeEach(() => jest.clearAllMocks());

describe("ProjectsScreen", () => {
  test("caricamento: mostra lo skeleton", async () => {
    const client = makeClient(jest.fn(() => new Promise(() => {})));
    const { rendered } = await renderScreen(client);
    expect(screen.getByTestId("projects-skeleton")).toBeTruthy();
    rendered.unmount();
  });

  test("errore: mostra Riprova, che ricarica", async () => {
    const pulse = jest.fn().mockRejectedValueOnce(new Error("down")).mockResolvedValueOnce([]);
    const client = makeClient(pulse);
    await renderScreen(client);
    await waitFor(() => expect(screen.getByText("Non riesco a caricare i progetti.")).toBeTruthy());
    await fireEvent.press(screen.getByTestId("projects-retry"));
    await waitFor(() => expect(screen.getByText("Scegli cosa seguire")).toBeTruthy());
  });

  test("vuoto: nessun progetto seguito → 'Scegli cosa seguire'", async () => {
    const client = makeClient(jest.fn().mockResolvedValue([]));
    await renderScreen(client);
    await waitFor(() => expect(screen.getByText("Scegli cosa seguire")).toBeTruthy());
    expect(screen.getByText("Riceverai decisioni e aggiornamenti solo dei progetti che segui.")).toBeTruthy();
  });

  test("lista: nell'ORDINE esatto restituito dal server, senza risistemarla lato client", async () => {
    // L'ordine qui è DELIBERATAMENTE quello sbagliato per idleDays (RUNNING
    // prima di WAITING violerebbe la priorità server, ma qui verifichiamo
    // che lo screen non tocchi affatto l'ordine — usa quello che arriva.
    const client = makeClient(jest.fn().mockResolvedValue([RUNNING, WAITING, IDLE]));
    await renderScreen(client);
    await waitFor(() => expect(screen.getByText("Piattaforma Acme")).toBeTruthy());
    const names = screen.getAllByText(/Portale B2B|Piattaforma Acme|Sito vetrina/).map((node) => node.props.children);
    expect(names).toEqual(["Piattaforma Acme", "Portale B2B", "Sito vetrina"]);
  });

  test("ogni riga mostra il polso col tono giusto e la riga di conteggi", async () => {
    const client = makeClient(jest.fn().mockResolvedValue([WAITING]));
    await renderScreen(client);
    await waitFor(() => expect(screen.getByText("aspetta te — 1 domanda dell'agente")).toBeTruthy());
    expect(screen.getByText("1 in attesa · 0 in corso · 4 pronte")).toBeTruthy();
  });

  test("l'intestazione conta i seguiti e chi aspetta te", async () => {
    const client = makeClient(jest.fn().mockResolvedValue([WAITING, RUNNING, IDLE]));
    await renderScreen(client);
    await waitFor(() => expect(screen.getByText("3 seguiti · 1 aspetta te")).toBeTruthy());
  });

  test("un tap sulla riga naviga al dettaglio con l'id del progetto", async () => {
    const navigate = jest.fn();
    const client = makeClient(jest.fn().mockResolvedValue([WAITING]));
    await renderScreen(client, navigate);
    await waitFor(() => expect(screen.getByText("Portale B2B")).toBeTruthy());
    await fireEvent.press(screen.getByTestId(`pulse-row-${WAITING.projectId}`));
    expect(navigate).toHaveBeenCalledWith("Detail", { id: WAITING.projectId });
  });
});
