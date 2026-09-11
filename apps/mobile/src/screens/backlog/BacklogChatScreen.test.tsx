import type { StubwiseClient } from "@stubwise/api-client";
import { ApiError } from "@stubwise/api-client";
import type { BacklogItemDetail, BacklogQuestion, Reader } from "@stubwise/shared";
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
    openQuestion: null,
    ...overrides,
  } as Reader<BacklogItemDetail>;
}

function question(overrides: Partial<Reader<BacklogQuestion>> & Pick<Reader<BacklogQuestion>, "questionId">): Reader<BacklogQuestion> {
  return {
    backlogItemId: ITEM_ID,
    question: "Il reso parziale può superare l'importo pagato?",
    options: [{ label: "Blocca al totale pagato" }, { label: "Consenti oltre" }],
    recommendedIndex: 0,
    allowFreeText: true,
    askedAt: "2026-08-01T00:00:00.000Z",
    answer: null,
    answeredAt: null,
    answeredBy: null,
    dismissedAt: null,
    ...overrides,
  } as Reader<BacklogQuestion>;
}

function makeClient(
  overrides: {
    get?: jest.Mock;
    chatText?: jest.Mock;
    chat?: jest.Mock;
    answerQuestion?: jest.Mock;
    dismissQuestion?: jest.Mock;
  } = {},
): StubwiseClient {
  return {
    backlog: {
      get: overrides.get ?? jest.fn().mockResolvedValue(item()),
      chatText: overrides.chatText ?? jest.fn().mockResolvedValue({ answer: "Risposta dell'agente.", sources: [], sessionId: ITEM_ID }),
      chat: overrides.chat ?? jest.fn(),
      answerQuestion: overrides.answerQuestion ?? jest.fn().mockResolvedValue({ backlogItemId: ITEM_ID }),
      dismissQuestion: overrides.dismissQuestion ?? jest.fn().mockResolvedValue({ backlogItemId: ITEM_ID }),
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
    openSettings: jest.fn(),
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

  // Fix di review (App M1+M2, Task 2, 11 set 2026): rete anti-regressione —
  // l'avatar (unico accesso alle Impostazioni) deve restare raggiungibile su
  // OGNI schermata post-login, incluse le due chat (prima del fix ne erano
  // prive del tutto).
  test("le Impostazioni sono raggiungibili (avatar presente)", async () => {
    await renderScreen(makeClient());
    await waitFor(() => expect(screen.getByTestId("settings-avatar-button")).toBeTruthy());
  });
});

describe("BacklogChatScreen — storia e invio", () => {
  test("semina le bolle dalla storia persistita; i messaggi 'system' arrivano come divider, non come bolle", async () => {
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
    // App M3 Fase A: i messaggi `system` (fra cui la risposta permanente a
    // una domanda a bottoni, Task 2) ORA compaiono, come divider — non più
    // esclusi: prima di questa fase non ce n'era motivo, la sola fonte
    // `system` era l'aggiornamento del documento; ora sono anche la
    // conferma scritta di una risposta/"non ora".
    expect(screen.getByText("Documento aggiornato.")).toBeTruthy();
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

  test("sessione di analisi sul codice attiva (avviata da web): composer disabilitato, niente chatText — chatText fallirebbe con invalid_response", async () => {
    const chatText = jest.fn().mockResolvedValue({ answer: "non dovrebbe arrivare qui", sources: [], sessionId: ITEM_ID });
    const client = makeClient({
      get: jest
        .fn()
        .mockResolvedValue(item({ codeSession: { status: "active", repositoryId: "repo-1", startedAt: "2026-08-01T00:00:00.000Z" } })),
      chatText,
    });
    await renderScreen(client);
    await waitFor(() => expect(screen.getByTestId("backlog-chat-code-session-notice")).toBeTruthy());
    expect(screen.getByText("Sessione di analisi sul codice attiva su questa voce — continua da web.")).toBeTruthy();

    expect(screen.getByTestId("backlog-chat-input").props.editable).toBe(false);
    await fireEvent.changeText(screen.getByTestId("backlog-chat-input"), "Domanda");
    expect(screen.getByTestId("backlog-chat-send").props.accessibilityState?.disabled).toBe(true);

    await fireEvent.press(screen.getByTestId("backlog-chat-send"));
    expect(chatText).not.toHaveBeenCalled();
  });
});

describe("BacklogChatScreen — domande a bottoni (App M3 Fase A)", () => {
  test("una domanda con opzioni: sceglierne una e inviare chiama answerQuestion con optionIndex", async () => {
    const Q = question({ questionId: "q1" });
    const answerQuestion = jest.fn().mockResolvedValue({ backlogItemId: ITEM_ID });
    const client = makeClient({ get: jest.fn().mockResolvedValue(item({ openQuestion: Q })), answerQuestion });
    await renderScreen(client);
    await waitFor(() => expect(screen.getByTestId("backlog-chat-question")).toBeTruthy());
    expect(screen.getByText(Q.question)).toBeTruthy();

    await fireEvent.press(screen.getByTestId("backlog-chat-question-option-1"));
    await fireEvent.press(screen.getByTestId("backlog-chat-question-submit"));

    expect(answerQuestion).toHaveBeenCalledWith(ITEM_ID, "q1", { optionIndex: 1 });
  });

  test("una domanda risolta con testo libero: invia con text", async () => {
    const Q = question({ questionId: "q1" });
    const answerQuestion = jest.fn().mockResolvedValue({ backlogItemId: ITEM_ID });
    const client = makeClient({ get: jest.fn().mockResolvedValue(item({ openQuestion: Q })), answerQuestion });
    await renderScreen(client);
    await waitFor(() => expect(screen.getByTestId("backlog-chat-question-other")).toBeTruthy());

    await fireEvent.press(screen.getByTestId("backlog-chat-question-other"));
    await fireEvent.changeText(screen.getByTestId("backlog-chat-question-free-text"), "Dipende dal canale");
    await fireEvent.press(screen.getByTestId("backlog-chat-question-submit"));

    expect(answerQuestion).toHaveBeenCalledWith(ITEM_ID, "q1", { text: "Dipende dal canale" });
  });

  // Stesso invariante di QuestionSheet/QuestionForm, verificato anche qui
  // perché la resa in linea è un contenitore NUOVO: un'opzione senza
  // etichetta deve azzerare l'INTERO elenco, non solo quella voce.
  test("bail-out: un'opzione senza etichetta azzera l'intero elenco, resta solo il testo libero", async () => {
    const Q = question({ questionId: "q1", options: [{ label: "Valida" }, { label: "   " }] });
    const client = makeClient({ get: jest.fn().mockResolvedValue(item({ openQuestion: Q })) });
    await renderScreen(client);
    await waitFor(() => expect(screen.getByTestId("backlog-chat-question")).toBeTruthy());

    expect(screen.queryByText("Valida")).toBeNull();
    expect(screen.queryByTestId("backlog-chat-question-option-0")).toBeNull();
    expect(screen.getByTestId("backlog-chat-question-free-text")).toBeTruthy();
  });

  test("«non ora»: chiama dismissQuestion e disabilita il composer finché la domanda è aperta", async () => {
    const Q = question({ questionId: "q1" });
    const dismissQuestion = jest.fn().mockResolvedValue({ backlogItemId: ITEM_ID });
    const client = makeClient({ get: jest.fn().mockResolvedValue(item({ openQuestion: Q })), dismissQuestion });
    await renderScreen(client);
    await waitFor(() => expect(screen.getByTestId("backlog-chat-question-not-now")).toBeTruthy());

    // Il composer è disabilitato finché c'è una domanda aperta — come sul
    // web (`sendDisabled = ... || openQuestion !== null`).
    expect(screen.getByTestId("backlog-chat-input").props.editable).toBe(false);

    await fireEvent.press(screen.getByTestId("backlog-chat-question-not-now"));
    expect(dismissQuestion).toHaveBeenCalledWith(ITEM_ID, "q1");
  });

  // Il bug trovato dalla review Stubwise sul web (question-panel.tsx): senza
  // rimonta/reset dello stato al cambio di `questionId`, una scelta fatta
  // sulla domanda precedente resterebbe marcata su quella nuova.
  test("il cambio da una domanda all'altra: la selezione precedente non sopravvive", async () => {
    const Q1 = question({ questionId: "q1", question: "Prima domanda?" });
    const Q2 = question({ questionId: "q2", question: "Seconda domanda?" });
    const get = jest
      .fn()
      .mockResolvedValueOnce(item({ openQuestion: Q1 }))
      .mockResolvedValueOnce(item({ openQuestion: Q2 }));
    const answerQuestion = jest.fn().mockResolvedValue({ backlogItemId: ITEM_ID });
    const client = makeClient({ get, answerQuestion });
    await renderScreen(client);
    await waitFor(() => expect(screen.getByText("Prima domanda?")).toBeTruthy());

    await fireEvent.press(screen.getByTestId("backlog-chat-question-option-0"));
    expect(screen.getByTestId("backlog-chat-question-option-0").props.accessibilityState?.checked).toBe(true);
    await fireEvent.press(screen.getByTestId("backlog-chat-question-submit"));

    await waitFor(() => expect(screen.getByText("Seconda domanda?")).toBeTruthy());
    // Nessuna opzione della domanda nuova risulta selezionata: lo stato
    // della prima domanda non è sopravvissuto al cambio.
    expect(screen.getByTestId("backlog-chat-question-option-0").props.accessibilityState?.checked).toBe(false);
    expect(screen.getByTestId("backlog-chat-question-option-1").props.accessibilityState?.checked).toBe(false);
  });

  test("una domanda aperta durante una sessione di analisi attiva resta rispondibile: solo il testo libero è bloccato", async () => {
    const Q = question({ questionId: "q1" });
    const answerQuestion = jest.fn().mockResolvedValue({ backlogItemId: ITEM_ID });
    const client = makeClient({
      get: jest
        .fn()
        .mockResolvedValue(
          item({ openQuestion: Q, codeSession: { status: "active", repositoryId: "repo-1", startedAt: "2026-08-01T00:00:00.000Z" } }),
        ),
      answerQuestion,
    });
    await renderScreen(client);
    await waitFor(() => expect(screen.getByTestId("backlog-chat-question")).toBeTruthy());

    // Il testo libero della chat resta bloccato (guardia `codeSessionActive`)…
    expect(screen.getByTestId("backlog-chat-input").props.editable).toBe(false);
    // …e l'avviso lo dice, ma non manda più "continua da web": con una
    // domanda aperta c'è qualcosa da fare qui (Task 3, dopo il Task 2).
    expect(screen.getByText("Sessione di analisi sul codice attiva — puoi rispondere alla domanda qui sotto, il testo libero resta da web.")).toBeTruthy();
    // …ma la domanda a bottoni si risponde comunque: è la RAGIONE per cui
    // la modalità CODE esiste sull'app (design M3 §3).
    await fireEvent.press(screen.getByTestId("backlog-chat-question-option-0"));
    await fireEvent.press(screen.getByTestId("backlog-chat-question-submit"));
    expect(answerQuestion).toHaveBeenCalledWith(ITEM_ID, "q1", { optionIndex: 0 });
  });
});
