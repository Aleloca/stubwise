import type { StubwiseClient } from "@stubwise/api-client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import { AuthContext } from "../../app/auth-context";
import type { AuthContextValue } from "../../app/providers";
import "../../i18n";
import { ProjectDocsScreen } from "./ProjectDocsScreen";

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const REPO_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const REPO_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function space(id: string, name: string, pageCount = 12): Record<string, unknown> {
  return { repositoryId: id, slug: name, name, pageCount, lastGenerationAt: null, lastCommitSha: null };
}

function node(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { id: "n1", parentId: null, slug: "guida", title: "Guida all'API", kind: "functional", ...overrides };
}

function makeClient(overrides: { projectSpaces?: jest.Mock; tree?: jest.Mock } = {}): StubwiseClient {
  return {
    docs: {
      projectSpaces:
        overrides.projectSpaces ?? jest.fn().mockResolvedValue([space(REPO_A, "Spazio API"), space(REPO_B, "Spazio Web", 4)]),
      tree: overrides.tree ?? jest.fn().mockResolvedValue([node()]),
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
        <ProjectDocsScreen
          navigation={navigation}
          route={{ key: "ProjectDocs", name: "ProjectDocs", params: { projectId: PROJECT_ID, projectName: "Portale B2B" } }}
        />
      </AuthContext.Provider>
    </QueryClientProvider>,
  );
  return { navigate, goBack };
}

beforeEach(() => jest.clearAllMocks());

describe("ProjectDocsScreen", () => {
  /**
   * ⚠️ TUTTI gli spazi, non solo il principale: il tab DOC ne sceglie uno
   * (`mainDocSpace`) perché ha un solo switcher; qui la domanda è «di cosa è
   * fatto QUESTO progetto», e nasconderne due risponderebbe a un'altra
   * domanda.
   */
  test("elenca TUTTI gli spazi del progetto, non solo quello principale", async () => {
    await renderScreen(makeClient());
    await waitFor(() => expect(screen.getByText("Spazio API")).toBeTruthy());
    expect(screen.getByText("Spazio Web")).toBeTruthy();
  });

  /**
   * ⚠️ L'albero di uno spazio si chiede SOLO aprendolo: con N repository
   * sarebbero N richieste all'ingresso per mostrarne una.
   */
  test("non chiede nessun albero finché non si apre uno spazio", async () => {
    const tree = jest.fn().mockResolvedValue([node()]);
    await renderScreen(makeClient({ tree }));
    await waitFor(() => expect(screen.getByText("Spazio API")).toBeTruthy());
    expect(tree).not.toHaveBeenCalled();

    await fireEvent.press(screen.getByTestId(`project-docs-space-${REPO_A}`));
    await waitFor(() => expect(tree).toHaveBeenCalledWith(REPO_A));
    // E SOLO quello aperto: l'altro spazio resta chiuso e non chiede niente.
    expect(tree).toHaveBeenCalledTimes(1);
  });

  test("aperto uno spazio, un gruppo si espande e una pagina naviga — dentro lo stack del progetto", async () => {
    const navigate = jest.fn();
    await renderScreen(makeClient(), navigate);
    await waitFor(() => expect(screen.getByTestId(`project-docs-space-${REPO_A}`)).toBeTruthy());
    await fireEvent.press(screen.getByTestId(`project-docs-space-${REPO_A}`));
    await waitFor(() => expect(screen.getByTestId(`project-docs-browse-${REPO_A}-functional`)).toBeTruthy());

    await fireEvent.press(screen.getByTestId(`project-docs-browse-${REPO_A}-functional`));
    await waitFor(() => expect(screen.getByText("Guida all'API")).toBeTruthy());
    await fireEvent.press(screen.getByText("Guida all'API"));

    expect(navigate).toHaveBeenCalledWith("Page", { repositoryId: REPO_A, slug: "guida" });
    // ⚠️ Non un salto al tab DOC: la pagina è registrata anche qui.
    expect(navigate).not.toHaveBeenCalledWith("Main", expect.anything());
  });

  test("un albero che non si carica lo dice, e non porta giù la schermata", async () => {
    await renderScreen(makeClient({ tree: jest.fn().mockRejectedValue(new Error("down")) }));
    await waitFor(() => expect(screen.getByTestId(`project-docs-space-${REPO_A}`)).toBeTruthy());
    await fireEvent.press(screen.getByTestId(`project-docs-space-${REPO_A}`));
    await waitFor(() => expect(screen.getByTestId(`project-docs-tree-error-${REPO_A}`)).toBeTruthy());
    // Gli altri spazi restano leggibili e apribili.
    expect(screen.getByText("Spazio Web")).toBeTruthy();
  });

  test("nessuno spazio documentato: lo stato vuoto, non un errore", async () => {
    await renderScreen(makeClient({ projectSpaces: jest.fn().mockResolvedValue([]) }));
    await waitFor(() => expect(screen.getByTestId("project-docs-empty")).toBeTruthy());
  });

  test("errore sugli spazi: un messaggio con Riprova, che ricarica", async () => {
    const projectSpaces = jest
      .fn()
      .mockRejectedValueOnce(new Error("down"))
      .mockResolvedValueOnce([space(REPO_A, "Spazio API")]);
    await renderScreen(makeClient({ projectSpaces }));
    await waitFor(() => expect(screen.getByTestId("project-docs-error")).toBeTruthy());
    await fireEvent.press(screen.getByTestId("project-docs-retry"));
    await waitFor(() => expect(screen.getByText("Spazio API")).toBeTruthy());
  });

  test("l'indietro torna all'hub", async () => {
    const goBack = jest.fn();
    await renderScreen(makeClient(), jest.fn(), goBack);
    await waitFor(() => expect(screen.getByText("Spazio API")).toBeTruthy());
    await fireEvent.press(screen.getByTestId("screen-header-back"));
    expect(goBack).toHaveBeenCalled();
  });
});
