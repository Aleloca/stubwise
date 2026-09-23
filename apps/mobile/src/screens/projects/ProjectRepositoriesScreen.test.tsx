import type { StubwiseClient } from "@stubwise/api-client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import { AuthContext } from "../../app/auth-context";
import type { AuthContextValue } from "../../app/providers";
import "../../i18n";
import { ProjectRepositoriesScreen } from "./ProjectRepositoriesScreen";

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";

function makeClient(get?: jest.Mock): StubwiseClient {
  return {
    projects: {
      get:
        get ??
        jest.fn().mockResolvedValue({
          id: PROJECT_ID,
          repositories: [{ id: "r1", name: "Portale API", slug: "portale-api", provider: "github" }],
        }),
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
        <ProjectRepositoriesScreen
          navigation={navigation}
          route={{
            key: "ProjectRepositories",
            name: "ProjectRepositories",
            params: { projectId: PROJECT_ID, projectName: "Portale B2B" },
          }}
        />
      </AuthContext.Provider>
    </QueryClientProvider>,
  );
  return { navigate, goBack };
}

beforeEach(() => jest.clearAllMocks());

describe("ProjectRepositoriesScreen", () => {
  test("elenca i repository del progetto", async () => {
    await renderScreen(makeClient());
    await waitFor(() => expect(screen.getByText("Portale API")).toBeTruthy());
  });

  /**
   * ⚠️ L'elenco viene da `projects.get`, la STESSA query della sezione
   * dell'hub: nessuna richiesta di lista a sé. Questa asserzione lo fissa —
   * se qualcuno introducesse un `repositories.list`, si vedrebbe qui.
   */
  test("non chiede una lista sua: legge quella che `projects.get` porta già", async () => {
    const get = jest.fn().mockResolvedValue({ id: PROJECT_ID, repositories: [] });
    await renderScreen(makeClient(get));
    await waitFor(() => expect(get).toHaveBeenCalledWith(PROJECT_ID));
    expect(get).toHaveBeenCalledTimes(1);
  });

  test("un tap apre il dettaglio per SLUG, col nome del progetto per l'indietro", async () => {
    const navigate = jest.fn();
    await renderScreen(makeClient(), navigate);
    await waitFor(() => expect(screen.getByTestId("project-repository-r1")).toBeTruthy());
    await fireEvent.press(screen.getByTestId("project-repository-r1"));
    expect(navigate).toHaveBeenCalledWith("Repository", { slug: "portale-api", projectName: "Portale B2B" });
  });

  test("nessun repository: lo stato vuoto, non un errore", async () => {
    await renderScreen(makeClient(jest.fn().mockResolvedValue({ id: PROJECT_ID, repositories: [] })));
    await waitFor(() => expect(screen.getByTestId("project-repositories-empty")).toBeTruthy());
  });

  test("errore: un messaggio con Riprova, che ricarica", async () => {
    const get = jest
      .fn()
      .mockRejectedValueOnce(new Error("down"))
      .mockResolvedValueOnce({ id: PROJECT_ID, repositories: [{ id: "r1", name: "Portale API", slug: "portale-api", provider: "github" }] });
    await renderScreen(makeClient(get));
    await waitFor(() => expect(screen.getByTestId("project-repositories-error")).toBeTruthy());
    await fireEvent.press(screen.getByTestId("project-repositories-retry"));
    await waitFor(() => expect(screen.getByText("Portale API")).toBeTruthy());
  });

  test("l'indietro torna all'hub", async () => {
    const goBack = jest.fn();
    await renderScreen(makeClient(), jest.fn(), goBack);
    await waitFor(() => expect(screen.getByText("Portale API")).toBeTruthy());
    await fireEvent.press(screen.getByTestId("screen-header-back"));
    expect(goBack).toHaveBeenCalled();
  });
});
