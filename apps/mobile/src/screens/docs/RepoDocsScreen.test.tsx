import AsyncStorage from "@react-native-async-storage/async-storage";
import type { StubwiseClient } from "@stubwise/api-client";
import type { DocTreeNode, Reader } from "@stubwise/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import { AuthContext } from "../../app/auth-context";
import type { AuthContextValue } from "../../app/providers";
import "../../i18n";
import { RepoDocsScreen } from "./RepoDocsScreen";

/**
 * LA DOCUMENTAZIONE DI UN REPOSITORY, a tab come sul web («la documentazione
 * nell'app, come sul web» §4).
 */
const REPO = "11111111-1111-4111-8111-111111111111";

function node(overrides: Partial<Reader<DocTreeNode>> & { id: string }): Reader<DocTreeNode> {
  return {
    slug: overrides.id,
    title: overrides.id,
    kind: "technical",
    parentId: null,
    position: 0,
    sourcePath: null,
    isManual: false,
    createdAt: "2026-09-01T00:00:00.000Z",
    viewCount: 0,
    significant: null,
    ...overrides,
  } as Reader<DocTreeNode>;
}

const TREE = [
  node({ id: "architettura", title: "Architettura", kind: "technical", position: 0 }),
  node({ id: "api", title: "API", kind: "technical", parentId: "architettura", position: 1 }),
  node({ id: "setup", title: "Setup", kind: "technical", position: 1 }),
  node({
    id: "release-20260920-0900-aaa1111",
    title: "Rilascio grande",
    kind: "releases",
    position: 0,
    significant: true,
    createdAt: "2026-09-20T09:00:00.000Z",
  }),
  node({
    id: "release-20260921-0900-bbb2222",
    title: "Rilascio piccolo",
    kind: "releases",
    position: 1,
    significant: false,
    createdAt: "2026-09-21T09:00:00.000Z",
  }),
];

const HIGHLIGHTS = {
  countsByKind: { technical: 3, functional: 0, product: 0, manual: 0, releases: 2 },
  topViewed: [{ slug: "setup", title: "Setup", kind: "technical", viewCount: 30 }],
  recentlyUpdated: [{ slug: "api", title: "API", kind: "technical", viewCount: 2 }],
  latestReleases: [
    { slug: "release-20260921-0900-bbb2222", title: "Rilascio piccolo", createdAt: "2026-09-21T09:00:00.000Z", significant: false, commitSha: null },
  ],
};

const BRIEF = {
  brief: {
    identity: "Il portale per gli ordini dei clienti B2B.",
    actors: [],
    surfaces: [],
    glossary: [],
    invariants: [],
    confidentialFacts: [],
    journeys: [],
    existingSources: [],
  },
  generation: { createdAt: "2026-09-25T10:30:00.000Z", commitSha: "abc1234" },
  productExclusions: [],
};

function makeClient(
  overrides: {
    tree?: jest.Mock;
    repoHighlights?: jest.Mock;
    brief?: jest.Mock;
    global?: jest.Mock;
    docsSemantic?: jest.Mock;
  } = {},
): StubwiseClient {
  return {
    docs: {
      tree: overrides.tree ?? jest.fn().mockResolvedValue(TREE),
      repoHighlights: overrides.repoHighlights ?? jest.fn().mockResolvedValue(HIGHLIGHTS),
      brief: overrides.brief ?? jest.fn().mockResolvedValue(BRIEF),
    },
    search: {
      global:
        overrides.global ??
        jest.fn().mockResolvedValue({
          tickets: { items: [], hasMore: false },
          projects: { items: [], hasMore: false },
          repositories: { items: [], hasMore: false },
          docs: { items: [], hasMore: false },
          mail: { items: [], hasMore: false },
        }),
      docsSemantic: overrides.docsSemantic ?? jest.fn().mockResolvedValue([]),
    },
  } as unknown as StubwiseClient;
}

async function renderScreen(client: StubwiseClient) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const navigate = jest.fn();
  const goBack = jest.fn();
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
  await render(
    <QueryClientProvider client={queryClient}>
      <AuthContext.Provider value={authValue}>
        <RepoDocsScreen
          navigation={{ navigate, goBack } as never}
          route={{ key: "RepoDocs", name: "RepoDocs", params: { repositoryId: REPO, repositoryName: "portale-web" } }}
        />
      </AuthContext.Provider>
    </QueryClientProvider>,
  );
  return { navigate, goBack };
}

beforeEach(async () => {
  await AsyncStorage.clear();
  jest.clearAllMocks();
});

describe("RepoDocsScreen — le tab", () => {
  test("Overview più le SOLE categorie con pagine", async () => {
    await renderScreen(makeClient());
    await waitFor(() => expect(screen.getByTestId("repo-docs-tab-overview")).toBeTruthy());
    expect(screen.getByTestId("repo-docs-tab-technical")).toBeTruthy();
    expect(screen.getByTestId("repo-docs-tab-releases")).toBeTruthy();
    expect(screen.queryByTestId("repo-docs-tab-functional")).toBeNull();
    expect(screen.queryByTestId("repo-docs-tab-product")).toBeNull();
    expect(screen.queryByTestId("repo-docs-tab-manual")).toBeNull();
  });

  test("senza memoria si apre su Overview", async () => {
    await renderScreen(makeClient());
    await waitFor(() => expect(screen.getByTestId("repo-docs-overview")).toBeTruthy());
    expect(screen.getByTestId("repo-docs-tab-overview").props.accessibilityState).toMatchObject({ selected: true });
  });

  test("l'ultima tab si ricorda PER repository, e si riapre lì", async () => {
    await AsyncStorage.setItem(`stubwise:repoDocsTab:${REPO}`, "releases");
    await renderScreen(makeClient());
    await waitFor(() => expect(screen.getByTestId("repo-docs-releases")).toBeTruthy());
  });

  test("se la tab ricordata non c'è più (nessuna pagina), si apre Overview", async () => {
    await AsyncStorage.setItem(`stubwise:repoDocsTab:${REPO}`, "product");
    await renderScreen(makeClient());
    await waitFor(() => expect(screen.getByTestId("repo-docs-overview")).toBeTruthy());
  });

  test("scegliere una tab la ricorda", async () => {
    await renderScreen(makeClient());
    await waitFor(() => expect(screen.getByTestId("repo-docs-tab-technical")).toBeTruthy());
    await fireEvent.press(screen.getByTestId("repo-docs-tab-technical"));
    await waitFor(async () => expect(await AsyncStorage.getItem(`stubwise:repoDocsTab:${REPO}`)).toBe("technical"));
  });

  test("l'albero non carica: errore e riprova", async () => {
    const tree = jest.fn().mockRejectedValueOnce(new Error("giù")).mockResolvedValueOnce(TREE);
    await renderScreen(makeClient({ tree }));
    await waitFor(() => expect(screen.getByTestId("repo-docs-retry")).toBeTruthy());
    await fireEvent.press(screen.getByTestId("repo-docs-retry"));
    await waitFor(() => expect(screen.getByTestId("repo-docs-tab-technical")).toBeTruthy());
  });
});

describe("RepoDocsScreen — Overview", () => {
  test("il brief in testa, «Brief ›» apre la schermata del brief", async () => {
    const { navigate } = await renderScreen(makeClient());
    await waitFor(() => expect(screen.getByText("Il portale per gli ordini dei clienti B2B.")).toBeTruthy());
    await fireEvent.press(screen.getByTestId("repo-docs-brief-link"));
    expect(navigate).toHaveBeenCalledWith("RepoBrief", { repositoryId: REPO, repositoryName: "portale-web" });
  });

  test("«Start here»: la prima pagina tecnica e l'ultima release", async () => {
    const { navigate } = await renderScreen(makeClient());
    await waitFor(() => expect(screen.getByTestId("repo-docs-start-technical")).toBeTruthy());
    await fireEvent.press(screen.getByTestId("repo-docs-start-technical"));
    expect(navigate).toHaveBeenCalledWith("Page", { repositoryId: REPO, slug: "architettura" });
    expect(screen.getByTestId("repo-docs-start-release")).toBeTruthy();
  });

  test("un tile di categoria col conteggio apre la sua tab", async () => {
    await renderScreen(makeClient());
    await waitFor(() => expect(screen.getByTestId("repo-docs-category-technical")).toBeTruthy());
    await fireEvent.press(screen.getByTestId("repo-docs-category-technical"));
    await waitFor(() => expect(screen.getByTestId("repo-docs-forest")).toBeTruthy());
  });

  test("le novità: aggiornate di recente e più viste", async () => {
    await renderScreen(makeClient());
    await waitFor(() => expect(screen.getByTestId("repo-docs-whats-new")).toBeTruthy());
    expect(screen.getByTestId("repo-docs-recent-api")).toBeTruthy();
    expect(screen.getByTestId("repo-docs-viewed-setup")).toBeTruthy();
  });

  test("⚠️ brief e highlights che FALLISCONO: le loro sezioni spariscono, la pagina resta intera", async () => {
    await renderScreen(
      makeClient({
        brief: jest.fn().mockRejectedValue(new Error("404")),
        repoHighlights: jest.fn().mockRejectedValue(new Error("giù")),
      }),
    );
    await waitFor(() => expect(screen.getByTestId("repo-docs-overview")).toBeTruthy());
    // «Start here» e le categorie vengono dall'albero, che c'è.
    await waitFor(() => expect(screen.getByTestId("repo-docs-start-technical")).toBeTruthy());
    expect(screen.getByTestId("repo-docs-category-technical")).toBeTruthy();
    expect(screen.queryByTestId("repo-docs-brief-link")).toBeNull();
    expect(screen.queryByTestId("repo-docs-whats-new")).toBeNull();
    expect(screen.queryByTestId("repo-docs-error")).toBeNull();
  });
});

describe("RepoDocsScreen — una categoria", () => {
  /**
   * Correzione dopo la prova sul telefono (26 set 2026): il chevron era troppo
   * piccolo per colpirlo, e il tap finiva sul titolo aprendo la pagina. Ora una
   * voce CON sotto-pagine è un ramo: TUTTA la riga lo apre e lo chiude, e la
   * pagina della voce sta dentro, come prima riga.
   */
  async function openTechnical() {
    const result = await renderScreen(makeClient());
    await waitFor(() => expect(screen.getByTestId("repo-docs-tab-technical")).toBeTruthy());
    await fireEvent.press(screen.getByTestId("repo-docs-tab-technical"));
    await waitFor(() => expect(screen.getByTestId("repo-docs-branch-architettura")).toBeTruthy());
    return result;
  }

  test("un tap sulla riga di un ramo NON naviga: apre il ramo, e lo dice all'accessibilità", async () => {
    const { navigate } = await openTechnical();
    const branch = screen.getByTestId("repo-docs-branch-architettura");
    expect(branch.props.accessibilityRole).toBe("button");
    expect(branch.props.accessibilityState).toMatchObject({ expanded: false });
    expect(screen.queryByTestId("repo-docs-node-api")).toBeNull();

    await fireEvent.press(branch);
    expect(navigate).not.toHaveBeenCalled();
    expect(screen.getByTestId("repo-docs-branch-architettura").props.accessibilityState).toMatchObject({ expanded: true });
    expect(screen.getByTestId("repo-docs-node-api")).toBeTruthy();

    // Un secondo tap lo richiude.
    await fireEvent.press(screen.getByTestId("repo-docs-branch-architettura"));
    expect(screen.queryByTestId("repo-docs-node-api")).toBeNull();
  });

  test("dentro il ramo, la PRIMA riga è la pagina della voce stessa, «<titolo> · panoramica»", async () => {
    const { navigate } = await openTechnical();
    await fireEvent.press(screen.getByTestId("repo-docs-branch-architettura"));
    const ids = screen.getAllByTestId(/^repo-docs-(node|overview)-/).map((el) => el.props.testID);
    expect(ids.slice(0, 2)).toEqual(["repo-docs-overview-architettura", "repo-docs-node-api"]);
    expect(screen.getByText("Architettura · panoramica")).toBeTruthy();

    await fireEvent.press(screen.getByTestId("repo-docs-overview-architettura"));
    expect(navigate).toHaveBeenCalledWith("Page", { repositoryId: REPO, slug: "architettura" });
  });

  test("una foglia apre la sua pagina, con la freccia a destra", async () => {
    const { navigate } = await openTechnical();
    const leaf = screen.getByTestId("repo-docs-node-setup");
    expect(screen.getByTestId("repo-docs-leaf-arrow-setup")).toBeTruthy();
    await fireEvent.press(leaf);
    expect(navigate).toHaveBeenCalledWith("Page", { repositoryId: REPO, slug: "setup" });
    // Una foglia non è un ramo.
    expect(screen.queryByTestId("repo-docs-branch-setup")).toBeNull();
  });
});

describe("RepoDocsScreen — Releases", () => {
  async function openReleases() {
    await renderScreen(makeClient());
    await waitFor(() => expect(screen.getByTestId("repo-docs-tab-releases")).toBeTruthy());
    await fireEvent.press(screen.getByTestId("repo-docs-tab-releases"));
    await waitFor(() => expect(screen.getByTestId("repo-docs-releases")).toBeTruthy());
  }

  test("in ordine di position, col commit ricavato dallo slug e il badge «minor»", async () => {
    await openReleases();
    const ids = screen.getAllByTestId(/^repo-docs-release-/).map((el) => el.props.testID);
    expect(ids).toEqual(["repo-docs-release-release-20260920-0900-aaa1111", "repo-docs-release-release-20260921-0900-bbb2222"]);
    expect(screen.getByText("aaa1111")).toBeTruthy();
    expect(screen.getByTestId("repo-docs-minor-release-20260921-0900-bbb2222")).toBeTruthy();
    expect(screen.queryByTestId("repo-docs-minor-release-20260920-0900-aaa1111")).toBeNull();
  });

  test("«Solo significative» nasconde le release minori", async () => {
    await openReleases();
    await fireEvent(screen.getByTestId("repo-docs-only-significant"), "valueChange", true);
    expect(screen.queryByTestId("repo-docs-release-release-20260921-0900-bbb2222")).toBeNull();
    expect(screen.getByTestId("repo-docs-release-release-20260920-0900-aaa1111")).toBeTruthy();
  });
});

describe("RepoDocsScreen — la ricerca nel repository", () => {
  const hit = (slug: string, title: string) => ({
    slug,
    title,
    kind: "technical",
    snippet: `…${title}…`,
    repositoryId: REPO,
    repositorySlug: "portale-web",
    repositoryName: "portale-web",
  });

  test("copre le tab mentre si cerca e le scopre col campo vuoto; semantica prima, senza doppioni", async () => {
    jest.useFakeTimers();
    try {
      const global = jest.fn().mockResolvedValue({
        tickets: { items: [], hasMore: false },
        projects: { items: [], hasMore: false },
        repositories: { items: [], hasMore: false },
        docs: { items: [hit("setup", "Setup"), hit("api", "API full-text")], hasMore: false },
        mail: { items: [], hasMore: false },
      });
      const docsSemantic = jest.fn().mockResolvedValue([{ ...hit("api", "API semantica"), score: 0.9 }]);
      const { navigate } = await renderScreen(makeClient({ global, docsSemantic }));
      await waitFor(() => expect(screen.getByTestId("repo-docs-overview")).toBeTruthy());

      await fireEvent.changeText(screen.getByTestId("repo-docs-search-input"), "api");
      await act(async () => {
        jest.advanceTimersByTime(300);
      });
      await waitFor(() => expect(screen.getByTestId("repo-docs-search-results")).toBeTruthy());
      expect(global).toHaveBeenCalledWith("api", REPO);
      expect(docsSemantic).toHaveBeenCalledWith("api", REPO);
      expect(screen.queryByTestId("repo-docs-overview")).toBeNull();
      const ids = screen.getAllByTestId(/^repo-docs-hit-/).map((el) => el.props.testID);
      expect(ids).toEqual(["repo-docs-hit-api", "repo-docs-hit-setup"]);
      expect(screen.getByText("API semantica")).toBeTruthy();

      await fireEvent.press(screen.getByTestId("repo-docs-hit-setup"));
      expect(navigate).toHaveBeenCalledWith("Page", { repositoryId: REPO, slug: "setup" });

      await fireEvent.changeText(screen.getByTestId("repo-docs-search-input"), "");
      await act(async () => {
        jest.advanceTimersByTime(300);
      });
      await waitFor(() => expect(screen.getByTestId("repo-docs-overview")).toBeTruthy());
    } finally {
      jest.useRealTimers();
    }
  });
});
