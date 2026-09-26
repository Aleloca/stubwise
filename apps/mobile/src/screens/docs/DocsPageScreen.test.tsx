import { ApiError } from "@stubwise/api-client";
import type { StubwiseClient } from "@stubwise/api-client";
import type { DocPage, Reader } from "@stubwise/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import { AuthContext } from "../../app/auth-context";
import type { AuthContextValue } from "../../app/providers";
import "../../i18n";
import { resetViewPings } from "../../lib/view-ping";
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

function makeClient(overrides: { page?: jest.Mock; viewPage?: jest.Mock } = {}): StubwiseClient {
  return {
    docs: {
      page: overrides.page ?? jest.fn().mockResolvedValue(page()),
      // Il ping delle visite (25 set 2026): nel doppio PRIMA dei test che lo
      // usano, o una sua assenza passerebbe inosservata (è fire-and-forget).
      viewPage: overrides.viewPage ?? jest.fn().mockResolvedValue(undefined),
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
  const push = jest.fn();
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
  const navigation = { goBack, navigate: jest.fn(), push } as never;
  const view = await render(
    <QueryClientProvider client={queryClient}>
      <AuthContext.Provider value={authValue}>
        <DocsPageScreen navigation={navigation} route={{ key: "Page", name: "Page", params }} />
      </AuthContext.Provider>
    </QueryClientProvider>,
  );
  return { goBack, push, unmount: view.unmount };
}

beforeEach(() => resetViewPings());

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

  // Fix di review (App M1+M2, Task 2, 11 set 2026): rete anti-regressione —
  // l'avatar (unico accesso alle Impostazioni) deve restare raggiungibile su
  // OGNI schermata post-login, incluse quelle di dettaglio come questa (prima
  // del fix ne era priva del tutto).
  test("le Impostazioni sono raggiungibili (avatar presente)", async () => {
    await renderScreen(makeClient());
    await waitFor(() => expect(screen.getByTestId("settings-avatar-button")).toBeTruthy());
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

/**
 * «La documentazione nell'app, come sul web» (25 set 2026, design §5): i
 * badge, le pagine collegate e il conteggio delle visite.
 */
describe("DocsPageScreen — badge, pagine collegate, visite", () => {
  test("i badge: categoria, data di aggiornamento e commit abbreviato", async () => {
    await renderScreen(makeClient({ page: jest.fn().mockResolvedValue(page({ commitSha: "abc1234def5678" })) }));
    await waitFor(() => expect(screen.getByTestId("docs-page-badges")).toBeTruthy());
    expect(screen.getByText("01/08/26")).toBeTruthy();
    expect(screen.getByText("abc1234")).toBeTruthy();
  });

  test("le pagine collegate, raggruppate come sul web, e premibili", async () => {
    const { push } = await renderScreen(
      makeClient({
        page: jest.fn().mockResolvedValue(
          page({
            links: [
              { type: "related", slug: "resi", title: "Gestire i resi" },
              { type: "implemented_by", slug: "export-csv", title: "Export CSV" },
            ],
          }),
        ),
      }),
    );
    await waitFor(() => expect(screen.getByTestId("docs-page-related")).toBeTruthy());
    // Ordine dei gruppi come sul web: implementata da, implementa, correlate.
    const ids = screen.getAllByTestId(/^docs-page-link-/).map((el) => el.props.testID);
    expect(ids).toEqual(["docs-page-link-export-csv", "docs-page-link-resi"]);
    await fireEvent.press(screen.getByTestId("docs-page-link-resi"));
    expect(push).toHaveBeenCalledWith("Page", { repositoryId: REPO_ID, slug: "resi" });
  });

  test("senza collegamenti la sezione non c'è", async () => {
    await renderScreen(makeClient());
    await waitFor(() => expect(screen.getByTestId("docs-page-body")).toBeTruthy());
    expect(screen.queryByTestId("docs-page-related")).toBeNull();
  });

  test("la visita si conta UNA volta per pagina entro il TTL, anche riaprendola", async () => {
    const viewPage = jest.fn().mockResolvedValue(undefined);
    const client = makeClient({ viewPage });
    const first = await renderScreen(client);
    await waitFor(() => expect(viewPage).toHaveBeenCalledWith(REPO_ID, "esporta-ordini"));
    await first.unmount();
    const second = await renderScreen(client);
    await waitFor(() => expect(screen.getByTestId("docs-page-body")).toBeTruthy());
    expect(viewPage).toHaveBeenCalledTimes(1);

    // Un'altra pagina conta subito.
    await second.unmount();
    await renderScreen(client, { repositoryId: REPO_ID, slug: "altra-pagina" });
    await waitFor(() => expect(viewPage).toHaveBeenCalledWith(REPO_ID, "altra-pagina"));
    expect(viewPage).toHaveBeenCalledTimes(2);
  });

  test("⚠️ un ping che fallisce non tocca la pagina", async () => {
    const viewPage = jest.fn().mockRejectedValue(new Error("giù"));
    await renderScreen(makeClient({ viewPage }));
    await waitFor(() => expect(screen.getByTestId("docs-page-body")).toBeTruthy());
    await waitFor(() => expect(viewPage).toHaveBeenCalled());
    expect(screen.queryByTestId("docs-page-error")).toBeNull();
    expect(screen.getByTestId("docs-page-body")).toBeTruthy();
  });
});
