import type { StubwiseClient } from "@stubwise/api-client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import { AuthContext } from "../../app/auth-context";
import type { AuthContextValue } from "../../app/providers";
import "../../i18n";
import { ProjectRoadmapScreen } from "./ProjectRoadmapScreen";

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";

function milestone(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "m1",
    projectId: PROJECT_ID,
    name: "Lancio pilota",
    description: null,
    dueDate: "2026-10-15T00:00:00.000Z",
    status: "open",
    closedAt: null,
    createdAt: "2026-08-01T00:00:00.000Z",
    counts: { total: 8, completed: 3, byStatus: {} },
    ...overrides,
  };
}

function makeClient(milestones?: jest.Mock): StubwiseClient {
  return {
    projects: { milestones: milestones ?? jest.fn().mockResolvedValue([milestone()]) },
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
  // `await`: vedi il commento gemello in `ProjectsScreen.test.tsx`.
  await render(
    <QueryClientProvider client={queryClient}>
      <AuthContext.Provider value={authValue}>
        <ProjectRoadmapScreen
          navigation={navigation}
          route={{
            key: "ProjectRoadmap",
            name: "ProjectRoadmap",
            params: { projectId: PROJECT_ID, projectName: "Portale B2B" },
          }}
        />
      </AuthContext.Provider>
    </QueryClientProvider>,
  );
  return { goBack };
}

beforeEach(() => jest.clearAllMocks());

describe("ProjectRoadmapScreen", () => {
  test("una milestone mostra nome, scadenza e avanzamento — i conteggi del server", async () => {
    await renderScreen(makeClient());
    await waitFor(() => expect(screen.getByText("Lancio pilota")).toBeTruthy());
    expect(screen.getByTestId("milestone-due-m1").props.children).toBe("scade il 15/10/26");
    expect(screen.getByTestId("milestone-progress-m1").props.children).toBe("3 di 8 ticket completati");
  });

  /**
   * ⚠️ `dueDate` è nullable: l'assenza si mostra COME assenza. Mai
   * «scaduta», che sarebbe falso, né una data inventata al posto del null.
   */
  test("milestone senza scadenza: lo dice, e non la chiama scaduta", async () => {
    await renderScreen(makeClient(jest.fn().mockResolvedValue([milestone({ dueDate: null })])));
    await waitFor(() => expect(screen.getByTestId("milestone-due-m1")).toBeTruthy());
    expect(screen.getByTestId("milestone-due-m1").props.children).toBe("senza scadenza");
    expect(screen.queryByText(/scadut/i)).toBeNull();
  });

  test("una milestone chiusa è distinguibile da una aperta", async () => {
    await renderScreen(
      makeClient(
        jest
          .fn()
          .mockResolvedValue([milestone({ id: "m2", name: "Beta", status: "closed", closedAt: "2026-09-01T00:00:00.000Z" })]),
      ),
    );
    await waitFor(() => expect(screen.getByText("Chiusa")).toBeTruthy());
    expect(screen.queryByText("Aperta")).toBeNull();
  });

  /**
   * L'ordine è quello del SERVER (aperte prima, poi per scadenza): questa
   * schermata non riordina, e l'asserzione lo fissa — un `sort` aggiunto
   * qui sarebbe una seconda verità sull'ordine.
   */
  test("non riordina: l'ordine è quello in cui il server le manda", async () => {
    await renderScreen(
      makeClient(
        jest.fn().mockResolvedValue([
          milestone({ id: "m3", name: "Terza", dueDate: null }),
          milestone({ id: "m1", name: "Prima" }),
        ]),
      ),
    );
    await waitFor(() => expect(screen.getByText("Terza")).toBeTruthy());
    const cards = screen.getAllByTestId(/^milestone-card-/);
    expect(cards.map((card) => card.props.testID)).toEqual(["milestone-card-m3", "milestone-card-m1"]);
  });

  test("nessuna milestone: lo stato vuoto, non un errore", async () => {
    await renderScreen(makeClient(jest.fn().mockResolvedValue([])));
    await waitFor(() => expect(screen.getByTestId("project-roadmap-empty")).toBeTruthy());
  });

  test("errore: un messaggio con Riprova, che ricarica", async () => {
    const milestones = jest.fn().mockRejectedValueOnce(new Error("down")).mockResolvedValueOnce([milestone()]);
    await renderScreen(makeClient(milestones));
    await waitFor(() => expect(screen.getByTestId("project-roadmap-error")).toBeTruthy());
    await fireEvent.press(screen.getByTestId("project-roadmap-retry"));
    await waitFor(() => expect(screen.getByText("Lancio pilota")).toBeTruthy());
  });

  test("l'indietro torna all'hub", async () => {
    const goBack = jest.fn();
    await renderScreen(makeClient(), goBack);
    await waitFor(() => expect(screen.getByText("Lancio pilota")).toBeTruthy());
    await fireEvent.press(screen.getByTestId("screen-header-back"));
    expect(goBack).toHaveBeenCalled();
  });
});
