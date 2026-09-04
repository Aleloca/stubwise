import AsyncStorage from "@react-native-async-storage/async-storage";
import type { StubwiseClient } from "@stubwise/api-client";
import type { DocSpace, DocTreeNode, ProjectListItem, Reader, SearchResults } from "@stubwise/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import { AuthContext } from "../../app/auth-context";
import type { AuthContextValue } from "../../app/providers";
import "../../i18n";
import { DocsScreen } from "./DocsScreen";

const PROJECT = { id: "proj-1", name: "Portale B2B", slug: "portale-b2b" };
const PROJECT_B = { id: "proj-2", name: "Piattaforma Acme", slug: "acme" };
const REPO_ID = "11111111-1111-4111-8111-111111111111";
const REPO_B_ID = "22222222-2222-4222-8222-222222222222";

function space(overrides: Partial<Reader<DocSpace>> = {}): Reader<DocSpace> {
  return {
    repositoryId: REPO_ID,
    slug: "portale-b2b",
    name: "Portale B2B",
    pageCount: 5,
    lastGenerationAt: "2026-08-01T00:00:00.000Z",
    lastCommitSha: "abc1234",
    ...overrides,
  };
}

function node(overrides: Partial<Reader<DocTreeNode>> = {}): Reader<DocTreeNode> {
  return {
    id: "aaaaaaaa-1111-4111-8111-111111111111",
    slug: "guida-ordini",
    title: "Guida ordini",
    kind: "functional",
    parentId: null,
    position: 0,
    sourcePath: null,
    isManual: false,
    createdAt: "2026-08-01T00:00:00.000Z",
    viewCount: 0,
    significant: null,
    ...overrides,
  };
}

const TREE = [
  node({ id: "1", slug: "guida-ordini", title: "Guida ordini", kind: "functional", position: 0 }),
  node({ id: "2", slug: "guida-fatture", title: "Guida fatture", kind: "functional", position: 1 }),
  node({ id: "3", slug: "api-export", title: "API export", kind: "technical", position: 0 }),
  node({ id: "4", slug: "release-2-2", title: "Release 2.2", kind: "releases", createdAt: "2026-07-01T00:00:00.000Z" }),
  node({ id: "5", slug: "release-2-3", title: "Release 2.3", kind: "releases", createdAt: "2026-08-15T00:00:00.000Z" }),
];

function searchResults(items: Reader<SearchResults>["docs"]["items"] = []): Reader<SearchResults> {
  return {
    tickets: { items: [], hasMore: false },
    projects: { items: [], hasMore: false },
    repositories: { items: [], hasMore: false },
    docs: { items, hasMore: false },
  };
}

function makeClient(
  overrides: {
    projectsList?: jest.Mock;
    projectSpaces?: jest.Mock;
    tree?: jest.Mock;
    searchGlobal?: jest.Mock;
  } = {},
): StubwiseClient {
  return {
    projects: {
      list: overrides.projectsList ?? jest.fn().mockResolvedValue([PROJECT] as unknown as Reader<ProjectListItem>[]),
      get: jest.fn(),
      pulse: jest.fn(),
    },
    docs: {
      spaces: jest.fn(),
      projectSpaces: overrides.projectSpaces ?? jest.fn().mockResolvedValue([space()]),
      tree: overrides.tree ?? jest.fn().mockResolvedValue(TREE),
      page: jest.fn(),
      chat: jest.fn(),
      chatSessions: jest.fn(),
      chatMessages: jest.fn(),
      projectChat: jest.fn(),
      projectChatSessions: jest.fn(),
      projectChatMessages: jest.fn(),
    },
    search: {
      global: overrides.searchGlobal ?? jest.fn().mockResolvedValue(searchResults()),
      docsSemantic: jest.fn(),
    },
  } as unknown as StubwiseClient;
}

async function renderScreen(client: StubwiseClient) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const navigate = jest.fn();
  const authValue: AuthContextValue = {
    status: "authenticated",
    client,
    user: { id: "viewer-1", email: "op@example.com", role: "member", language: "it", avatarUrl: null, slackUserId: null },
    justLoggedIn: false,
    login: jest.fn(),
    completeOnboarding: jest.fn(),
  };
  const navigation = { navigate } as never;
  await render(
    <QueryClientProvider client={queryClient}>
      <AuthContext.Provider value={authValue}>
        <DocsScreen navigation={navigation} route={{ key: "List", name: "List", params: undefined }} />
      </AuthContext.Provider>
    </QueryClientProvider>,
  );
  return { navigate };
}

beforeEach(async () => {
  await AsyncStorage.clear();
});

describe("DocsScreen — picker progetto", () => {
  test("cambiare progetto ricarica gli spazi doc del progetto scelto, e lo ricorda per la prossima visita", async () => {
    const projectSpaces = jest.fn().mockImplementation((projectId: string) =>
      Promise.resolve(projectId === PROJECT_B.id ? [space({ repositoryId: REPO_B_ID, name: "Piattaforma Acme" })] : [space()]),
    );
    await renderScreen(
      makeClient({
        projectsList: jest.fn().mockResolvedValue([PROJECT, PROJECT_B]),
        projectSpaces,
      }),
    );

    await waitFor(() => expect(screen.getByTestId("docs-project-toggle")).toBeTruthy());
    await fireEvent.press(screen.getByTestId("docs-project-toggle"));
    await fireEvent.press(screen.getByTestId(`docs-project-${PROJECT_B.id}`));

    await waitFor(() => expect(projectSpaces).toHaveBeenCalledWith(PROJECT_B.id));
    await expect(AsyncStorage.getItem("stubwise:lastDocsProjectId")).resolves.toBe(PROJECT_B.id);
  });
});

describe("DocsScreen — «Oppure sfoglia» (canvas 3f)", () => {
  test("mostra i tre gruppi con i conteggi dai kind delle pagine, e l'ultima release", async () => {
    await renderScreen(makeClient());

    await waitFor(() => expect(screen.getByText("Guida funzionale")).toBeTruthy());
    expect(screen.getByText(/2 pagine/)).toBeTruthy();
    expect(screen.getByText("Pagine tecniche")).toBeTruthy();
    expect(screen.getByText(/1 pagina\b/)).toBeTruthy();
    expect(screen.getByText("Note di rilascio")).toBeTruthy();
    // La release più recente (createdAt maggiore), non l'ultima della lista in arrivo.
    expect(screen.getByText(/ultima: Release 2\.3/)).toBeTruthy();
  });

  test("toccare un gruppo lo espande e mostra le sue pagine; toccarne una naviga a DocsPageScreen", async () => {
    const { navigate } = await renderScreen(makeClient());
    await waitFor(() => expect(screen.getByText("Guida funzionale")).toBeTruthy());

    await fireEvent.press(screen.getByText("Guida funzionale"));
    await waitFor(() => expect(screen.getByText("Guida fatture")).toBeTruthy());

    await fireEvent.press(screen.getByText("Guida fatture"));
    expect(navigate).toHaveBeenCalledWith("Page", { repositoryId: REPO_ID, slug: "guida-fatture" });
  });

  test("progetto senza spazi documentati → stato vuoto, nessun crash", async () => {
    await renderScreen(makeClient({ projectSpaces: jest.fn().mockResolvedValue([]) }));
    await waitFor(() => expect(screen.getByTestId("docs-empty")).toBeTruthy());
    expect(screen.queryByText("Guida funzionale")).toBeNull();
  });
});

describe("DocsScreen — ricerca con debounce 300ms", () => {
  test("NON chiama la ricerca subito dopo ogni tocco: solo dopo una pausa, e una volta sola con l'ultimo testo", async () => {
    const searchGlobal = jest.fn().mockResolvedValue(searchResults());
    await renderScreen(makeClient({ searchGlobal }));
    await waitFor(() => expect(screen.getByText("Guida funzionale")).toBeTruthy());

    const input = screen.getByTestId("docs-search-input");
    await fireEvent.changeText(input, "e");
    await fireEvent.changeText(input, "es");
    await fireEvent.changeText(input, "esp");

    // Subito dopo l'ultimo tocco, nessuna chiamata: il debounce non è ancora scaduto.
    expect(searchGlobal).not.toHaveBeenCalled();

    await waitFor(() => expect(searchGlobal).toHaveBeenCalledTimes(1), { timeout: 2000 });
    expect(searchGlobal).toHaveBeenCalledWith("esp", REPO_ID);
  });

  test("mostra i risultati della ricerca (al posto di «Oppure sfoglia»), e toccarne uno naviga alla pagina", async () => {
    const searchGlobal = jest.fn().mockResolvedValue(
      searchResults([
        {
          slug: "esporta-ordini",
          title: "Esportare gli ordini",
          kind: "functional",
          snippet: "…genera un CSV…",
          repositoryId: REPO_ID,
          repositorySlug: "portale-b2b",
          repositoryName: "Portale B2B",
        },
      ]),
    );
    const { navigate } = await renderScreen(makeClient({ searchGlobal }));
    await waitFor(() => expect(screen.getByText("Guida funzionale")).toBeTruthy());

    await fireEvent.changeText(screen.getByTestId("docs-search-input"), "esporta");
    await waitFor(() => expect(screen.getByText("Esportare gli ordini")).toBeTruthy(), { timeout: 2000 });

    // Durante una ricerca attiva, «Oppure sfoglia» non è più in vista.
    expect(screen.queryByText("Guida funzionale")).toBeNull();

    await fireEvent.press(screen.getByText("Esportare gli ordini"));
    expect(navigate).toHaveBeenCalledWith("Page", { repositoryId: REPO_ID, slug: "esporta-ordini" });
  });

  test("nessun risultato → messaggio dedicato, non una lista vuota silenziosa", async () => {
    await renderScreen(makeClient({ searchGlobal: jest.fn().mockResolvedValue(searchResults([])) }));
    await waitFor(() => expect(screen.getByText("Guida funzionale")).toBeTruthy());

    await fireEvent.changeText(screen.getByTestId("docs-search-input"), "qualcosa");
    await waitFor(() => expect(screen.getByText("Nessun risultato.")).toBeTruthy(), { timeout: 2000 });
  });

  test("la ricerca fallisce → messaggio di errore, non un crash o una lista vuota silenziosa", async () => {
    await renderScreen(makeClient({ searchGlobal: jest.fn().mockRejectedValue(new Error("network down")) }));
    await waitFor(() => expect(screen.getByText("Guida funzionale")).toBeTruthy());

    await fireEvent.changeText(screen.getByTestId("docs-search-input"), "qualcosa");
    await waitFor(() => expect(screen.getByText("Non riesco a caricare i Docs.")).toBeTruthy(), { timeout: 2000 });
  });
});

describe("DocsScreen — «Chiedi al progetto»", () => {
  test("tocca l'entrata → naviga ad Ask con projectId + projectName (SOLO progetto, nessun repository)", async () => {
    const { navigate } = await renderScreen(makeClient());
    await waitFor(() => expect(screen.getByText("Chiedi al progetto")).toBeTruthy());

    await fireEvent.press(screen.getByTestId("docs-ask-entry"));
    expect(navigate).toHaveBeenCalledWith("Ask", { projectId: PROJECT.id, projectName: PROJECT.name });
  });
});
