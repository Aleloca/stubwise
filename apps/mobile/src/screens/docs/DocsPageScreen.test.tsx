import { ApiError } from "@stubwise/api-client";
import type { StubwiseClient } from "@stubwise/api-client";
import type { DocPage, Reader } from "@stubwise/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react-native";
import { AuthContext } from "../../app/auth-context";
import type { AuthContextValue } from "../../app/providers";
import "../../i18n";
import { DocsPageScreen } from "./DocsPageScreen";

const REPO_ID = "11111111-1111-4111-8111-111111111111";

function page(overrides: Partial<Reader<DocPage>> = {}): Reader<DocPage> {
  return {
    id: "22222222-2222-4222-8222-222222222222",
    slug: "esporta-ordini",
    title: "Esportare gli ordini",
    kind: "functional",
    parentId: null,
    position: 0,
    sourcePath: null,
    body: "Dall'area **Ordini**, il pulsante Esporta genera un CSV.",
    isManual: false,
    commitSha: "abc1234",
    commitUrl: null,
    links: null,
    updatedAt: "2026-08-01T00:00:00.000Z",
    createdAt: "2026-08-01T00:00:00.000Z",
    viewCount: 3,
    significant: null,
    ...overrides,
  };
}

function makeClient(overrides: { page?: jest.Mock } = {}): StubwiseClient {
  return {
    docs: {
      page: overrides.page ?? jest.fn().mockResolvedValue(page()),
      spaces: jest.fn(),
      projectSpaces: jest.fn(),
      tree: jest.fn(),
      chat: jest.fn(),
      chatSessions: jest.fn(),
      chatMessages: jest.fn(),
      projectChat: jest.fn(),
      projectChatSessions: jest.fn(),
      projectChatMessages: jest.fn(),
    },
  } as unknown as StubwiseClient;
}

async function renderScreen(client: StubwiseClient, params: { repositoryId: string; slug: string } = { repositoryId: REPO_ID, slug: "esporta-ordini" }) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const goBack = jest.fn();
  const authValue: AuthContextValue = {
    status: "authenticated",
    client,
    user: { id: "viewer-1", email: "op@example.com", role: "member", language: "it", avatarUrl: null, slackUserId: null },
    justLoggedIn: false,
    login: jest.fn(),
    completeOnboarding: jest.fn(),
  };
  const navigation = { goBack, navigate: jest.fn() } as never;
  await render(
    <QueryClientProvider client={queryClient}>
      <AuthContext.Provider value={authValue}>
        <DocsPageScreen navigation={navigation} route={{ key: "Page", name: "Page", params }} />
      </AuthContext.Provider>
    </QueryClientProvider>,
  );
  return { goBack };
}

describe("DocsPageScreen — caricamento, errori, rendering markdown", () => {
  test("caricamento: mostra lo skeleton", async () => {
    await renderScreen(makeClient({ page: jest.fn().mockReturnValue(new Promise(() => {})) }));
    expect(screen.getByTestId("docs-page-skeleton")).toBeTruthy();
  });

  test("successo: titolo + corpo markdown VERO (grassetto interpretato)", async () => {
    await renderScreen(makeClient());
    await waitFor(() => expect(screen.getByText("Esportare gli ordini")).toBeTruthy());
    // Markdown vero: gli asterischi di **Ordini** sono interpretati (spariscono).
    expect(screen.getByText("Ordini")).toBeTruthy();
    expect(screen.queryByText(/\*\*/)).toBeNull();
  });

  test("404 → pagina non trovata (non l'errore generico)", async () => {
    const notFound = jest.fn().mockRejectedValue(new ApiError(404, "Page not found", "page_not_found"));
    await renderScreen(makeClient({ page: notFound }));
    await waitFor(() => expect(screen.getByTestId("docs-page-not-found")).toBeTruthy());
  });

  test("altro errore → stato di errore con retry", async () => {
    const failing = jest.fn().mockRejectedValue(new Error("network down"));
    await renderScreen(makeClient({ page: failing }));
    await waitFor(() => expect(screen.getByTestId("docs-page-error")).toBeTruthy());
    expect(screen.getByTestId("docs-page-retry")).toBeTruthy();
  });
});
