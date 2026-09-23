import type { StubwiseClient } from "@stubwise/api-client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import { AuthContext } from "../../app/auth-context";
import type { AuthContextValue } from "../../app/providers";
import "../../i18n";
import { RepositoryScreen } from "./RepositoryScreen";

const SLUG = "portale-api";

function repository(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    projectId: "22222222-2222-4222-8222-222222222222",
    name: "Portale API",
    slug: SLUG,
    provider: "github",
    repoUrl: "https://github.com/acme/portale-api",
    defaultBranch: "main",
    gitAccountId: "33333333-3333-4333-8333-333333333333",
    gitAccountName: "acme-bot",
    testCommand: "pnpm test",
    installCommand: "pnpm install",
    webhookConfiguredAt: "2026-09-01T10:00:00.000Z",
    graphEnabled: true,
    createdAt: "2026-08-01T10:00:00.000Z",
    ...overrides,
  };
}

function makeClient(get?: jest.Mock): StubwiseClient {
  return {
    repositories: { get: get ?? jest.fn().mockResolvedValue(repository()) },
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
        <RepositoryScreen
          navigation={navigation}
          route={{ key: "Repository", name: "Repository", params: { slug: SLUG, projectName: "Portale B2B" } }}
        />
      </AuthContext.Provider>
    </QueryClientProvider>,
  );
  return { goBack };
}

beforeEach(() => jest.clearAllMocks());

describe("RepositoryScreen", () => {
  test("chiede il repository per SLUG, non per id", async () => {
    const get = jest.fn().mockResolvedValue(repository());
    await renderScreen(makeClient(get));
    await waitFor(() => expect(get).toHaveBeenCalledWith(SLUG));
  });

  test("mostra dove sta il codice e cosa esegue la pipeline", async () => {
    await renderScreen(makeClient());
    await waitFor(() => expect(screen.getByTestId("repository-url")).toBeTruthy());
    expect(screen.getByTestId("repository-url").props.children).toBe("https://github.com/acme/portale-api");
    expect(screen.getByTestId("repository-install-command").props.children).toBe("pnpm install");
    expect(screen.getByTestId("repository-test-command").props.children).toBe("pnpm test");
    expect(screen.getByText("main")).toBeTruthy();
    expect(screen.getByText("acme-bot")).toBeTruthy();
  });

  /**
   * ⚠️ I file d'ambiente sono SEGRETI e il design li esclude (§8): questa
   * schermata non deve offrirne nemmeno una traccia. L'asserzione è
   * negativa apposta — è l'unica forma che coglie un'aggiunta fatta «per
   * simmetria col web».
   */
  test("NON mostra niente che assomigli ai file d'ambiente", async () => {
    await renderScreen(makeClient());
    await waitFor(() => expect(screen.getByTestId("repository-url")).toBeTruthy());
    expect(screen.queryByText(/ambiente/i)).toBeNull();
    expect(screen.queryByText(/\.env/)).toBeNull();
  });

  /**
   * ⚠️ Un comando assente si DICE. Una riga che sparisce lascerebbe credere
   * che l'abbiamo dimenticata, invece che «questa pipeline non installa
   * niente».
   */
  test("un comando non configurato si dice, non sparisce", async () => {
    await renderScreen(makeClient(jest.fn().mockResolvedValue(repository({ installCommand: null, testCommand: null }))));
    await waitFor(() => expect(screen.getByTestId("repository-install-command")).toBeTruthy());
    expect(screen.getByTestId("repository-install-command").props.children).toBe("nessun comando");
    expect(screen.getByTestId("repository-test-command").props.children).toBe("nessun comando");
  });

  test("webhook mai configurato: lo dice, invece di mostrare una data inventata", async () => {
    await renderScreen(makeClient(jest.fn().mockResolvedValue(repository({ webhookConfiguredAt: null }))));
    await waitFor(() => expect(screen.getByTestId("repository-webhook")).toBeTruthy());
    expect(screen.getByTestId("repository-webhook").props.children).toBe("non configurato");
  });

  test("l'indietro torna da dove si è arrivati", async () => {
    const goBack = jest.fn();
    await renderScreen(makeClient(), goBack);
    await waitFor(() => expect(screen.getByTestId("repository-url")).toBeTruthy());
    await fireEvent.press(screen.getByTestId("screen-header-back"));
    expect(goBack).toHaveBeenCalled();
  });

  test("errore: un messaggio con Riprova, che ricarica", async () => {
    const get = jest.fn().mockRejectedValueOnce(new Error("down")).mockResolvedValueOnce(repository());
    await renderScreen(makeClient(get));
    await waitFor(() => expect(screen.getByTestId("repository-error")).toBeTruthy());
    await fireEvent.press(screen.getByTestId("repository-retry"));
    await waitFor(() => expect(screen.getByTestId("repository-url")).toBeTruthy());
  });
});
