import type { StubwiseClient } from "@stubwise/api-client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react-native";
import { AuthContext } from "../../app/auth-context";
import type { AuthContextValue } from "../../app/providers";
import "../../i18n";
import { ProjectDocsScreen } from "./ProjectDocsScreen";

/**
 * LA PAGINA GENERALE DELLA DOCUMENTAZIONE di un progetto, come la home Docs di
 * progetto del web («la documentazione nell'app, come sul web» §3): ricerca,
 * «Ask this project», «Start here», repository, novità.
 */
const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const REPO_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const REPO_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function space(id: string, name: string, pageCount: number, lastGenerationAt: string | null = null) {
  return { repositoryId: id, slug: name, name, pageCount, lastGenerationAt, lastCommitSha: null };
}

const SPACES = [space(REPO_B, "portale-web", 4, "2026-09-10T08:00:00.000Z"), space(REPO_A, "portale-api", 12)];

const HIGHLIGHTS = {
  countsByKind: { technical: 10, functional: 3, product: 0, manual: 0, releases: 2 },
  topViewed: [
    { slug: "auth", title: "Autenticazione", kind: "technical", viewCount: 40, repositoryId: REPO_A, repositorySlug: "portale-api", repositoryName: "portale-api" },
  ],
  latestReleases: [
    {
      slug: "release-20260924-1000-abc1234",
      title: "Nuovo checkout",
      createdAt: "2026-09-24T10:00:00.000Z",
      significant: true,
      commitSha: null,
      repositoryId: REPO_A,
      repositorySlug: "portale-api",
      repositoryName: "portale-api",
    },
  ],
};

const BRIEF = {
  brief: {
    identity: "Le API degli ordini B2B.",
    actors: [],
    surfaces: [],
    glossary: [],
    invariants: [],
    confidentialFacts: [],
    journeys: [],
    existingSources: [],
  },
  generation: { createdAt: "2026-09-25T10:30:00.000Z", commitSha: null },
  productExclusions: [],
};

function makeClient(
  overrides: { projectSpaces?: jest.Mock; projectHighlights?: jest.Mock; brief?: jest.Mock; projectSearch?: jest.Mock } = {},
): StubwiseClient {
  return {
    docs: {
      projectSpaces: overrides.projectSpaces ?? jest.fn().mockResolvedValue(SPACES),
      projectHighlights: overrides.projectHighlights ?? jest.fn().mockResolvedValue(HIGHLIGHTS),
      brief: overrides.brief ?? jest.fn().mockResolvedValue(BRIEF),
      projectSearch: overrides.projectSearch ?? jest.fn().mockResolvedValue([]),
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
  // `await`: vedi il commento gemello in `ProjectsScreen.test.tsx`.
  await render(
    <QueryClientProvider client={queryClient}>
      <AuthContext.Provider value={authValue}>
        <ProjectDocsScreen
          navigation={{ navigate, goBack } as never}
          route={{ key: "ProjectDocs", name: "ProjectDocs", params: { projectId: PROJECT_ID, projectName: "Portale B2B" } }}
        />
      </AuthContext.Provider>
    </QueryClientProvider>,
  );
  return { navigate, goBack };
}

beforeEach(() => jest.clearAllMocks());

describe("ProjectDocsScreen — la pagina generale", () => {
  test("«Ask this project» apre la chat del progetto, anche senza documentazione", async () => {
    const { navigate } = await renderScreen(makeClient({ projectSpaces: jest.fn().mockResolvedValue([]) }));
    await waitFor(() => expect(screen.getByTestId("project-docs-empty")).toBeTruthy());
    await fireEvent.press(screen.getByTestId("project-docs-ask"));
    expect(navigate).toHaveBeenCalledWith("Ask", { projectId: PROJECT_ID, projectName: "Portale B2B" });
  });

  test("«Start here» parte dal repository PRINCIPALE (quello con più pagine): brief e panoramica", async () => {
    const client = makeClient();
    const { navigate } = await renderScreen(client);
    await waitFor(() => expect(screen.getByText("Le API degli ordini B2B.")).toBeTruthy());
    expect(client.docs.brief).toHaveBeenCalledWith(REPO_A);

    await fireEvent.press(screen.getByTestId("project-docs-start-brief"));
    expect(navigate).toHaveBeenCalledWith("RepoBrief", { repositoryId: REPO_A, repositoryName: "portale-api" });
    await fireEvent.press(screen.getByTestId("project-docs-start-overview"));
    expect(navigate).toHaveBeenCalledWith("RepoDocs", { repositoryId: REPO_A, repositoryName: "portale-api" });
  });

  test("l'ultima release in «Start here» apre la sua pagina, nel repository giusto", async () => {
    const { navigate } = await renderScreen(makeClient());
    await waitFor(() => expect(screen.getByTestId("project-docs-start-release")).toBeTruthy());
    await fireEvent.press(screen.getByTestId("project-docs-start-release"));
    expect(navigate).toHaveBeenCalledWith("Page", { repositoryId: REPO_A, slug: "release-20260924-1000-abc1234" });
  });

  test("i repository: nome, pagine e l'ultima release o l'ultima generazione; il tap apre la loro documentazione", async () => {
    const { navigate } = await renderScreen(makeClient());
    await waitFor(() => expect(screen.getByTestId(`project-docs-repo-${REPO_A}`)).toBeTruthy());
    expect(screen.getByTestId(`project-docs-repo-${REPO_B}`)).toBeTruthy();
    // portale-api ha una release nelle novità; portale-web no, e mostra la generazione.
    expect(within(screen.getByTestId(`project-docs-repo-${REPO_A}`)).getByText(/ultimo: Nuovo checkout/)).toBeTruthy();
    expect(within(screen.getByTestId(`project-docs-repo-${REPO_B}`)).getByText(/10\/09\/26/)).toBeTruthy();

    await fireEvent.press(screen.getByTestId(`project-docs-repo-${REPO_B}`));
    expect(navigate).toHaveBeenCalledWith("RepoDocs", { repositoryId: REPO_B, repositoryName: "portale-web" });
  });

  test("le novità di tutti i repository, ciascuna col suo repository", async () => {
    const { navigate } = await renderScreen(makeClient());
    await waitFor(() => expect(screen.getByTestId("project-docs-whats-new")).toBeTruthy());
    expect(screen.getByTestId("project-docs-new-release-release-20260924-1000-abc1234")).toBeTruthy();
    await fireEvent.press(screen.getByTestId("project-docs-new-viewed-auth"));
    expect(navigate).toHaveBeenCalledWith("Page", { repositoryId: REPO_A, slug: "auth" });
  });

  test("⚠️ highlights e brief che FALLISCONO: spariscono le loro sezioni, i repository restano", async () => {
    await renderScreen(
      makeClient({
        projectHighlights: jest.fn().mockRejectedValue(new Error("giù")),
        brief: jest.fn().mockRejectedValue(new Error("404")),
      }),
    );
    await waitFor(() => expect(screen.getByTestId(`project-docs-repo-${REPO_A}`)).toBeTruthy());
    expect(screen.queryByTestId("project-docs-whats-new")).toBeNull();
    expect(screen.queryByTestId("project-docs-start-brief")).toBeNull();
    expect(screen.queryByTestId("project-docs-start-release")).toBeNull();
    // La panoramica del principale non dipende da loro: resta.
    expect(screen.getByTestId("project-docs-start-overview")).toBeTruthy();
    expect(screen.queryByTestId("project-docs-error")).toBeNull();
  });

  test("errore sugli spazi: messaggio con Riprova, che ricarica", async () => {
    const projectSpaces = jest.fn().mockRejectedValueOnce(new Error("giù")).mockResolvedValueOnce(SPACES);
    await renderScreen(makeClient({ projectSpaces }));
    await waitFor(() => expect(screen.getByTestId("project-docs-error")).toBeTruthy());
    await fireEvent.press(screen.getByTestId("project-docs-retry"));
    await waitFor(() => expect(screen.getByTestId(`project-docs-repo-${REPO_A}`)).toBeTruthy());
  });

  test("l'indietro torna all'hub", async () => {
    const goBack = jest.fn();
    await renderScreen(makeClient(), jest.fn(), goBack);
    await waitFor(() => expect(screen.getByTestId(`project-docs-repo-${REPO_A}`)).toBeTruthy());
    await fireEvent.press(screen.getByTestId("screen-header-back"));
    expect(goBack).toHaveBeenCalled();
  });
});

describe("ProjectDocsScreen — la ricerca del progetto", () => {
  test("i risultati sostituiscono la pagina finché il campo non è vuoto; il tap apre la pagina", async () => {
    jest.useFakeTimers();
    try {
      const projectSearch = jest.fn().mockResolvedValue([
        {
          slug: "auth",
          title: "Autenticazione",
          kind: "technical",
          snippet: "…il token…",
          score: 0.8,
          source: "hybrid",
          repositoryId: REPO_A,
          repositorySlug: "portale-api",
          repositoryName: "portale-api",
        },
      ]);
      const { navigate } = await renderScreen(makeClient({ projectSearch }));
      await waitFor(() => expect(screen.getByTestId(`project-docs-repo-${REPO_A}`)).toBeTruthy());

      await fireEvent.changeText(screen.getByTestId("project-docs-search-input"), "token");
      // Col debounce: niente chiamata prima dei 300 ms.
      expect(projectSearch).not.toHaveBeenCalled();
      await act(async () => {
        jest.advanceTimersByTime(300);
      });
      await waitFor(() => expect(screen.getByTestId("project-docs-hit-auth")).toBeTruthy());
      expect(projectSearch).toHaveBeenCalledWith(PROJECT_ID, "token");
      expect(screen.getByText("portale-api · Tecnica")).toBeTruthy();
      expect(screen.queryByTestId(`project-docs-repo-${REPO_A}`)).toBeNull();

      await fireEvent.press(screen.getByTestId("project-docs-hit-auth"));
      expect(navigate).toHaveBeenCalledWith("Page", { repositoryId: REPO_A, slug: "auth" });

      await fireEvent.changeText(screen.getByTestId("project-docs-search-input"), "");
      await act(async () => {
        jest.advanceTimersByTime(300);
      });
      await waitFor(() => expect(screen.getByTestId(`project-docs-repo-${REPO_A}`)).toBeTruthy());
    } finally {
      jest.useRealTimers();
    }
  });
});
