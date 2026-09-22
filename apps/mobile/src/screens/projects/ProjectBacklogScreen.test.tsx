import type { StubwiseClient } from "@stubwise/api-client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import { AuthContext } from "../../app/auth-context";
import type { AuthContextValue } from "../../app/providers";
import "../../i18n";
import { ProjectBacklogScreen } from "./ProjectBacklogScreen";

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const ITEM_ID = "88888888-8888-4888-8888-888888888888";
const TICKET_ID = "99999999-9999-4999-8999-999999999999";

function item(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: ITEM_ID,
    projectId: PROJECT_ID,
    title: "Accesso clienti con SSO",
    status: "ready",
    effort: 4,
    risk: "medium",
    riskNote: null,
    urgency: "high",
    requestCount: 1,
    source: "manual",
    similarTo: null,
    ticketCount: 0,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    ...overrides,
  };
}

function makeClient(overrides: { list?: jest.Mock; convert?: jest.Mock } = {}): StubwiseClient {
  return {
    backlog: {
      list: overrides.list ?? jest.fn().mockResolvedValue({ items: [item()], nextCursor: null, total: 1 }),
      convert: overrides.convert ?? jest.fn().mockResolvedValue({ ticketId: TICKET_ID, ticketNumber: 7 }),
    },
  } as unknown as StubwiseClient;
}

async function renderScreen(client: StubwiseClient, navigate: jest.Mock = jest.fn(), goBack: jest.Mock = jest.fn()) {
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
  const navigation = { navigate, goBack } as never;
  // `await`: vedi il commento gemello in `ProjectsScreen.test.tsx`.
  await render(
    <QueryClientProvider client={queryClient}>
      <AuthContext.Provider value={authValue}>
        <ProjectBacklogScreen
          navigation={navigation}
          route={{
            key: "ProjectBacklog",
            name: "ProjectBacklog",
            params: { projectId: PROJECT_ID, projectName: "Portale B2B" },
          }}
        />
      </AuthContext.Provider>
    </QueryClientProvider>,
  );
  return { navigate, goBack };
}

beforeEach(() => jest.clearAllMocks());

describe("ProjectBacklogScreen", () => {
  /**
   * ⚠️ La lista non è riscritta: monta `BacklogListCard`, lo stesso
   * componente del tab BLG. Il `testID` della card è la prova che il
   * componente montato è QUELLO, non una copia scritta qui.
   */
  test("monta la card del tab BLG, non una copia", async () => {
    await renderScreen(makeClient());
    await waitFor(() => expect(screen.getByTestId(`backlog-card-${ITEM_ID}`)).toBeTruthy());
    expect(screen.getByText("Accesso clienti con SSO")).toBeTruthy();
  });

  test("chiede SOLO il backlog di questo progetto", async () => {
    const list = jest.fn().mockResolvedValue({ items: [], nextCursor: null, total: 0 });
    await renderScreen(makeClient({ list }));
    await waitFor(() => expect(list).toHaveBeenCalled());
    expect(list).toHaveBeenCalledWith({ projectId: PROJECT_ID });
  });

  test("il chip «Pronti» restringe allo stato `ready`, sempre sul progetto", async () => {
    const list = jest.fn().mockResolvedValue({ items: [], nextCursor: null, total: 0 });
    await renderScreen(makeClient({ list }));
    await waitFor(() => expect(list).toHaveBeenCalled());
    await fireEvent.press(screen.getByTestId("project-backlog-chip-ready"));
    await waitFor(() => expect(list).toHaveBeenCalledWith({ projectId: PROJECT_ID, status: "ready" }));
  });

  test("«Procedi» converte la voce e porta al Lavoro del ticket creato", async () => {
    const navigate = jest.fn();
    const convert = jest.fn().mockResolvedValue({ ticketId: TICKET_ID, ticketNumber: 7 });
    await renderScreen(makeClient({ convert }), navigate);
    await waitFor(() => expect(screen.getByTestId(`backlog-proceed-${ITEM_ID}`)).toBeTruthy());
    await fireEvent.press(screen.getByTestId(`backlog-proceed-${ITEM_ID}`));
    await waitFor(() => expect(convert).toHaveBeenCalledWith(ITEM_ID));
    await waitFor(() =>
      expect(navigate).toHaveBeenCalledWith("Main", {
        screen: "Projects",
        params: { screen: "Ticket", params: { id: TICKET_ID } },
      }),
    );
  });

  /**
   * ⚠️ Aprire una voce NON deve uscire dallo stack `Projects`: `Item` è
   * registrata anche qui (22 set 2026), quindi si naviga DENTRO — ed è ciò
   * che fa tornare l'indietro a questo elenco invece che alla lista
   * generale.
   *
   * La seconda asserzione non è ridondante: è quella che fallirebbe se
   * qualcuno reintroducesse il salto fra tab. Senza, il test passerebbe
   * anche con una navigazione verso `Main` che ce la mette in aggiunta.
   */
  test("aprire una voce resta DENTRO lo stack del progetto, non salta al tab BLG", async () => {
    const navigate = jest.fn();
    await renderScreen(makeClient(), navigate);
    await waitFor(() => expect(screen.getByTestId(`backlog-open-${ITEM_ID}`)).toBeTruthy());
    await fireEvent.press(screen.getByTestId(`backlog-open-${ITEM_ID}`));
    expect(navigate).toHaveBeenCalledWith("Item", { id: ITEM_ID });
    expect(navigate).not.toHaveBeenCalledWith("Main", expect.anything());
  });

  test("l'indietro torna all'hub", async () => {
    const goBack = jest.fn();
    await renderScreen(makeClient(), jest.fn(), goBack);
    await waitFor(() => expect(screen.getByText("Accesso clienti con SSO")).toBeTruthy());
    await fireEvent.press(screen.getByTestId("screen-header-back"));
    expect(goBack).toHaveBeenCalled();
  });

  test("backlog vuoto: lo stato vuoto, non un errore", async () => {
    await renderScreen(makeClient({ list: jest.fn().mockResolvedValue({ items: [], nextCursor: null, total: 0 }) }));
    await waitFor(() => expect(screen.getByTestId("project-backlog-empty")).toBeTruthy());
  });

  test("errore: un messaggio con Riprova, che ricarica", async () => {
    const list = jest
      .fn()
      .mockRejectedValueOnce(new Error("down"))
      .mockResolvedValueOnce({ items: [item()], nextCursor: null, total: 1 });
    await renderScreen(makeClient({ list }));
    await waitFor(() => expect(screen.getByTestId("project-backlog-error")).toBeTruthy());
    await fireEvent.press(screen.getByTestId("project-backlog-retry"));
    await waitFor(() => expect(screen.getByText("Accesso clienti con SSO")).toBeTruthy());
  });

  /** ⚠️ Fixture lasciata SENZA `total` apposta (CLAUDE.md): qui non si usa. */
  test("SERVER PIÙ VECCHIO: senza `total` l'elenco si vede lo stesso", async () => {
    await renderScreen(makeClient({ list: jest.fn().mockResolvedValue({ items: [item()], nextCursor: null }) }));
    await waitFor(() => expect(screen.getByText("Accesso clienti con SSO")).toBeTruthy());
  });
});
