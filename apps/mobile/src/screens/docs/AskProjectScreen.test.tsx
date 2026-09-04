import type { StubwiseClient } from "@stubwise/api-client";
import { ApiError } from "@stubwise/api-client";
import type { DocsChatAnswer, Reader } from "@stubwise/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import { AuthContext } from "../../app/auth-context";
import type { AuthContextValue } from "../../app/providers";
import "../../i18n";
import { AskProjectScreen } from "./AskProjectScreen";

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const SESSION_ID = "22222222-2222-4222-8222-222222222222";
const REPO_ID = "33333333-3333-4333-8333-333333333333";

function answer(overrides: Partial<Reader<DocsChatAnswer>> = {}): Reader<DocsChatAnswer> {
  return {
    answer: "Sì, dall'area Ordini: «Esporta» genera un CSV.",
    sources: [
      {
        slug: "guida-ordini",
        title: "Guida ordini",
        kind: "functional",
        repositoryId: REPO_ID,
        repositorySlug: "portale-b2b",
        repositoryName: "Portale B2B",
      },
    ],
    sessionId: SESSION_ID,
    ...overrides,
  };
}

function makeClient(overrides: { projectChat?: jest.Mock } = {}): StubwiseClient {
  return {
    docs: {
      page: jest.fn(),
      spaces: jest.fn(),
      projectSpaces: jest.fn(),
      tree: jest.fn(),
      chat: jest.fn(),
      chatSessions: jest.fn(),
      chatMessages: jest.fn(),
      projectChat: overrides.projectChat ?? jest.fn().mockResolvedValue(answer()),
      projectChatSessions: jest.fn(),
      projectChatMessages: jest.fn(),
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
  };
  const navigation = { navigate, goBack } as never;
  await render(
    <QueryClientProvider client={queryClient}>
      <AuthContext.Provider value={authValue}>
        <AskProjectScreen
          navigation={navigation}
          route={{ key: "Ask", name: "Ask", params: { projectId: PROJECT_ID, projectName: "Portale B2B" } }}
        />
      </AuthContext.Provider>
    </QueryClientProvider>,
  );
  return { navigate, goBack };
}

describe("AskProjectScreen — chat di progetto (canvas 3f, «Chiedi al progetto»)", () => {
  test("mostra il nome del progetto in testata", async () => {
    await renderScreen(makeClient());
    expect(screen.getByText("Portale B2B")).toBeTruthy();
  });

  test("invia una domanda → bolla utente + bolla agente con la risposta, sessionId assente al primo turno", async () => {
    const projectChat = jest.fn().mockResolvedValue(answer());
    await renderScreen(makeClient({ projectChat }));

    await fireEvent.changeText(screen.getByTestId("ask-project-input"), "Posso esportare gli ordini in Excel?");
    await fireEvent.press(screen.getByTestId("ask-project-send"));

    expect(screen.getByText("Posso esportare gli ordini in Excel?")).toBeTruthy();
    await waitFor(() => expect(screen.getByText(answer().answer)).toBeTruthy());
    expect(projectChat).toHaveBeenCalledWith(PROJECT_ID, { message: "Posso esportare gli ordini in Excel?", sessionId: undefined });
  });

  test("le Fonti compaiono ed elencano il titolo di ogni pagina citata", async () => {
    await renderScreen(makeClient());
    await fireEvent.changeText(screen.getByTestId("ask-project-input"), "domanda");
    await fireEvent.press(screen.getByTestId("ask-project-send"));
    await waitFor(() => expect(screen.getByText("Guida ordini")).toBeTruthy());
  });

  test("toccare una fonte naviga a DocsPageScreen con repositoryId+slug della pagina citata", async () => {
    const { navigate } = await renderScreen(makeClient());
    await fireEvent.changeText(screen.getByTestId("ask-project-input"), "domanda");
    await fireEvent.press(screen.getByTestId("ask-project-send"));
    await waitFor(() => expect(screen.getByText("Guida ordini")).toBeTruthy());

    await fireEvent.press(screen.getByText("Guida ordini"));
    expect(navigate).toHaveBeenCalledWith("Page", { repositoryId: REPO_ID, slug: "guida-ordini" });
  });

  // Multi-turno: il SECONDO messaggio deve riusare il sessionId tornato dal
  // PRIMO — vedi il commento su `useAskProjectChat` in `lib/docs-mutations.ts`.
  // Mutazione da rompere apposta: se lo screen non tenesse lo stato del
  // sessionId (o lo dimenticasse), questo test morirebbe (secondo turno
  // chiamato con sessionId undefined invece di quello del primo).
  test("il secondo turno passa il sessionId ricevuto dal primo (conversazione multi-turno)", async () => {
    const projectChat = jest
      .fn()
      .mockResolvedValueOnce(answer({ answer: "Prima risposta.", sessionId: SESSION_ID }))
      .mockResolvedValueOnce(answer({ answer: "Seconda risposta.", sessionId: SESSION_ID }));
    await renderScreen(makeClient({ projectChat }));

    await fireEvent.changeText(screen.getByTestId("ask-project-input"), "prima domanda");
    await fireEvent.press(screen.getByTestId("ask-project-send"));
    await waitFor(() => expect(screen.getByText("Prima risposta.")).toBeTruthy());

    await fireEvent.changeText(screen.getByTestId("ask-project-input"), "seconda domanda");
    await fireEvent.press(screen.getByTestId("ask-project-send"));
    await waitFor(() => expect(screen.getByText("Seconda risposta.")).toBeTruthy());

    expect(projectChat).toHaveBeenNthCalledWith(1, PROJECT_ID, { message: "prima domanda", sessionId: undefined });
    expect(projectChat).toHaveBeenNthCalledWith(2, PROJECT_ID, { message: "seconda domanda", sessionId: SESSION_ID });
  });

  test("503 chat_unavailable → messaggio dedicato, non l'errore generico", async () => {
    const projectChat = jest.fn().mockRejectedValue(new ApiError(503, "Docs chat requires an API-key AI provider", "chat_unavailable"));
    await renderScreen(makeClient({ projectChat }));

    await fireEvent.changeText(screen.getByTestId("ask-project-input"), "domanda");
    await fireEvent.press(screen.getByTestId("ask-project-send"));

    await waitFor(() => expect(screen.getByTestId("ask-project-send-error")).toBeTruthy());
    expect(screen.getByText("La chat richiede un provider AI con chiave API.")).toBeTruthy();
  });
});
