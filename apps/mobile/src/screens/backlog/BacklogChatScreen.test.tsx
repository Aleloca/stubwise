import type { StubwiseClient } from "@stubwise/api-client";
import { ApiError } from "@stubwise/api-client";
import type { BacklogItemDetail, Reader } from "@stubwise/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import { AuthContext } from "../../app/auth-context";
import type { AuthContextValue } from "../../app/providers";
import "../../i18n";
import { BacklogChatScreen } from "./BacklogChatScreen";

const ITEM_ID = "77777777-7777-4777-8777-777777777777";

function item(overrides: Partial<Reader<BacklogItemDetail>> = {}): Reader<BacklogItemDetail> {
  return {
    id: ITEM_ID,
    projectId: "proj-1",
    title: "Export massivo degli ordini",
    document: "Documento della voce.",
    implementationPlan: null,
    originContent: null,
    status: "refining",
    effort: 3,
    risk: "low",
    riskNote: null,
    urgency: "high",
    requestCount: 1,
    source: "manual",
    suggested: null,
    similarTo: null,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    tickets: [],
    messages: [],
    deepDivePending: false,
    codeSession: null,
    pendingTurn: false,
    ...overrides,
  } as Reader<BacklogItemDetail>;
}

function makeClient(overrides: { get?: jest.Mock; chatText?: jest.Mock; chat?: jest.Mock } = {}): StubwiseClient {
  return {
    backlog: {
      get: overrides.get ?? jest.fn().mockResolvedValue(item()),
      chatText: overrides.chatText ?? jest.fn().mockResolvedValue({ answer: "Risposta dell'agente.", sources: [], sessionId: ITEM_ID }),
      chat: overrides.chat ?? jest.fn(),
      list: jest.fn(),
      convert: jest.fn(),
      create: jest.fn(),
    },
  } as unknown as StubwiseClient;
}

async function renderScreen(client: StubwiseClient) {
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
  const navigation = { goBack } as never;
  await render(
    <QueryClientProvider client={queryClient}>
      <AuthContext.Provider value={authValue}>
        <BacklogChatScreen navigation={navigation} route={{ key: "Chat", name: "Chat", params: { id: ITEM_ID } }} />
      </AuthContext.Provider>
    </QueryClientProvider>,
  );
  return { goBack };
}

describe("BacklogChatScreen — caricamento ed errori", () => {
  test("caricamento: mostra lo skeleton", async () => {
    const client = makeClient({ get: jest.fn(() => new Promise(() => {})) });
    await renderScreen(client);
    expect(screen.getByTestId("backlog-chat-skeleton")).toBeTruthy();
  });

  test("404: stato 'non c'è più'", async () => {
    const client = makeClient({ get: jest.fn().mockRejectedValue(new ApiError(404, "Not found", "backlog_item_not_found")) });
    await renderScreen(client);
    await waitFor(() => expect(screen.getByTestId("backlog-chat-not-found")).toBeTruthy());
  });

  test("errore di rete: Riprova ricarica", async () => {
    const get = jest.fn().mockRejectedValueOnce(new Error("down")).mockResolvedValueOnce(item());
    const client = makeClient({ get });
    await renderScreen(client);
    await waitFor(() => expect(screen.getByTestId("backlog-chat-retry")).toBeTruthy());
    await fireEvent.press(screen.getByTestId("backlog-chat-retry"));
    await waitFor(() => expect(screen.getByText("Export massivo degli ordini")).toBeTruthy());
  });

  test("il tasto indietro chiama goBack", async () => {
    const { goBack } = await renderScreen(makeClient());
    await waitFor(() => expect(screen.getByText("Export massivo degli ordini")).toBeTruthy());
    await fireEvent.press(screen.getByTestId("backlog-chat-back"));
    expect(goBack).toHaveBeenCalled();
  });
});

describe("BacklogChatScreen — storia e invio", () => {
  test("semina le bolle dalla storia persistita, escludendo i messaggi 'system'", async () => {
    const client = makeClient({
      get: jest.fn().mockResolvedValue(
        item({
          messages: [
            { id: "m1", role: "user", content: "Chi userà l'export?", citations: null, createdAt: "2026-08-01T00:00:00.000Z" },
            { id: "m2", role: "assistant", content: "Una persona o il gestionale?", citations: null, createdAt: "2026-08-01T00:01:00.000Z" },
            { id: "m3", role: "system", content: "Documento aggiornato.", citations: null, createdAt: "2026-08-01T00:02:00.000Z" },
          ],
        }),
      ),
    });
    await renderScreen(client);
    await waitFor(() => expect(screen.getByText("Chi userà l'export?")).toBeTruthy());
    expect(screen.getByText("Una persona o il gestionale?")).toBeTruthy();
    expect(screen.queryByText("Documento aggiornato.")).toBeNull();
  });

  test("invio: bolla utente subito, poi la risposta INTERA dell'agente — via chatText, non chat", async () => {
    const chatText = jest.fn().mockResolvedValue({ answer: "Aggiorno il documento con questo scenario.", sources: [], sessionId: ITEM_ID });
    const chat = jest.fn();
    const client = makeClient({ chatText, chat });
    await renderScreen(client);
    await waitFor(() => expect(screen.getByTestId("backlog-chat-input")).toBeTruthy());

    await fireEvent.changeText(screen.getByTestId("backlog-chat-input"), "Una persona, dal portale");
    await fireEvent.press(screen.getByTestId("backlog-chat-send"));

    expect(screen.getByText("Una persona, dal portale")).toBeTruthy();
    await waitFor(() => expect(screen.getByText("Aggiorno il documento con questo scenario.")).toBeTruthy());
    expect(chatText).toHaveBeenCalledWith(ITEM_ID, "Una persona, dal portale");
    expect(chat).not.toHaveBeenCalled();
  });

  test("mentre la risposta è in volo mostra l'indicatore 'Sta pensando…'", async () => {
    let resolve!: (value: { answer: string; sources: never[]; sessionId: string }) => void;
    const chatText = jest.fn(() => new Promise((r) => (resolve = r)));
    const client = makeClient({ chatText });
    await renderScreen(client);
    await waitFor(() => expect(screen.getByTestId("backlog-chat-input")).toBeTruthy());

    await fireEvent.changeText(screen.getByTestId("backlog-chat-input"), "Domanda");
    await fireEvent.press(screen.getByTestId("backlog-chat-send"));
    await waitFor(() => expect(screen.getByTestId("backlog-chat-thinking")).toBeTruthy());

    resolve({ answer: "Risposta.", sources: [], sessionId: ITEM_ID });
    await waitFor(() => expect(screen.queryByTestId("backlog-chat-thinking")).toBeNull());
  });

  test("errore d'invio: mostra il messaggio (la bolla utente resta, era già stata inviata)", async () => {
    const chatText = jest.fn().mockRejectedValue(new ApiError(503, "down", "chat_unavailable"));
    const client = makeClient({ chatText });
    await renderScreen(client);
    await waitFor(() => expect(screen.getByTestId("backlog-chat-input")).toBeTruthy());

    await fireEvent.changeText(screen.getByTestId("backlog-chat-input"), "Domanda");
    await fireEvent.press(screen.getByTestId("backlog-chat-send"));

    expect(screen.getByText("Domanda")).toBeTruthy();
    await waitFor(() => expect(screen.getByText("La chat richiede un provider AI con chiave API.")).toBeTruthy());
  });

  test("invio disabilitato con campo vuoto", async () => {
    await renderScreen(makeClient());
    await waitFor(() => expect(screen.getByTestId("backlog-chat-send")).toBeTruthy());
    expect(screen.getByTestId("backlog-chat-send").props.accessibilityState?.disabled).toBe(true);
  });
});
