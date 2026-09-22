import type { StubwiseClient } from "@stubwise/api-client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import { AuthContext } from "../../app/auth-context";
import type { AuthContextValue } from "../../app/providers";
import "../../i18n";
import { ProjectTicketsScreen } from "./ProjectTicketsScreen";

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const TICKET_A = "22222222-2222-4222-8222-222222222222";

function ticket(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: TICKET_A,
    projectId: PROJECT_ID,
    number: 33,
    title: "Export CSV clienti",
    type: "bug",
    priority: "medium",
    status: "open",
    createdAt: "2026-09-20T10:00:00.000Z",
    ...overrides,
  };
}

function makeClient(list?: jest.Mock): StubwiseClient {
  return {
    tickets: { list: list ?? jest.fn().mockResolvedValue({ items: [ticket()], nextCursor: null, total: 1 }) },
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
        <ProjectTicketsScreen
          navigation={navigation}
          route={{ key: "Tickets", name: "Tickets", params: { projectId: PROJECT_ID, projectName: "Portale B2B" } }}
        />
      </AuthContext.Provider>
    </QueryClientProvider>,
  );
  return { navigate, goBack };
}

beforeEach(() => jest.clearAllMocks());

describe("ProjectTicketsScreen", () => {
  test("la riga dice QUALE ticket è: `#numero · priorità · tipo · aperto …` sopra il titolo", async () => {
    await renderScreen(makeClient());
    await waitFor(() => expect(screen.getByText("Export CSV clienti")).toBeTruthy());
    expect(screen.getByText(/^#33 · media · guasto · aperto/)).toBeTruthy();
  });

  /**
   * ⚠️ Il filtro d'ingresso deve chiedere lo STESSO insieme che la sezione
   * dell'hub conta: chi tocca «vedi» su «14 aperti» deve trovare quei 14. Se
   * i due insiemi divergessero, il numero mentirebbe proprio nel momento in
   * cui lo si verifica.
   */
  test("all'ingresso chiede gli APERTI: gli stessi quattro stati che conta l'hub", async () => {
    const list = jest.fn().mockResolvedValue({ items: [], nextCursor: null, total: 0 });
    await renderScreen(makeClient(list));
    await waitFor(() => expect(list).toHaveBeenCalled());
    expect(list).toHaveBeenCalledWith({
      projectId: PROJECT_ID,
      statuses: ["open", "triaged", "in_progress", "in_review"],
    });
  });

  test("«In corso» restringe agli stati del lavoro già cominciato", async () => {
    const list = jest.fn().mockResolvedValue({ items: [], nextCursor: null, total: 0 });
    await renderScreen(makeClient(list));
    await waitFor(() => expect(list).toHaveBeenCalled());
    await fireEvent.press(screen.getByTestId("project-tickets-filter-inProgress"));
    await waitFor(() =>
      expect(list).toHaveBeenCalledWith({ projectId: PROJECT_ID, statuses: ["in_progress", "in_review"] }),
    );
  });

  test("«Tutti» NON manda nessuno stato: chiusi e conclusi inclusi, che è ciò che la parola promette", async () => {
    const list = jest.fn().mockResolvedValue({ items: [], nextCursor: null, total: 0 });
    await renderScreen(makeClient(list));
    await waitFor(() => expect(list).toHaveBeenCalled());
    await fireEvent.press(screen.getByTestId("project-tickets-filter-all"));
    await waitFor(() => expect(list).toHaveBeenCalledWith({ projectId: PROJECT_ID }));
  });

  test("un tap su una riga apre il ticket, con la riga «indietro» sul nome del progetto", async () => {
    const navigate = jest.fn();
    await renderScreen(makeClient(), navigate);
    await waitFor(() => expect(screen.getByText("Export CSV clienti")).toBeTruthy());
    await fireEvent.press(screen.getByText("Export CSV clienti"));
    expect(navigate).toHaveBeenCalledWith("Ticket", { id: TICKET_A, backLabel: "Portale B2B" });
  });

  test("l'indietro torna all'hub, non alla lista progetti", async () => {
    const goBack = jest.fn();
    await renderScreen(makeClient(), jest.fn(), goBack);
    await waitFor(() => expect(screen.getByText("Export CSV clienti")).toBeTruthy());
    await fireEvent.press(screen.getByTestId("screen-header-back"));
    expect(goBack).toHaveBeenCalled();
  });

  test("nessun ticket con quel filtro: lo stato vuoto, non un errore", async () => {
    await renderScreen(makeClient(jest.fn().mockResolvedValue({ items: [], nextCursor: null, total: 0 })));
    await waitFor(() => expect(screen.getByTestId("project-tickets-empty")).toBeTruthy());
  });

  test("errore: un messaggio con Riprova, che ricarica", async () => {
    const list = jest
      .fn()
      .mockRejectedValueOnce(new Error("down"))
      .mockResolvedValueOnce({ items: [ticket()], nextCursor: null, total: 1 });
    await renderScreen(makeClient(list));
    await waitFor(() => expect(screen.getByTestId("project-tickets-error")).toBeTruthy());
    await fireEvent.press(screen.getByTestId("project-tickets-retry"));
    await waitFor(() => expect(screen.getByText("Export CSV clienti")).toBeTruthy());
  });

  /**
   * ⚠️ Fixture lasciata SENZA `total` apposta (CLAUDE.md): un server più
   * vecchio non lo manda, e questa schermata non lo usa affatto — le righe
   * devono comparire comunque.
   */
  test("SERVER PIÙ VECCHIO: senza `total` l'elenco si vede lo stesso", async () => {
    await renderScreen(makeClient(jest.fn().mockResolvedValue({ items: [ticket()], nextCursor: null })));
    await waitFor(() => expect(screen.getByText("Export CSV clienti")).toBeTruthy());
  });
});
