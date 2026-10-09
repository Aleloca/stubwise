import type { StubwiseClient } from "@stubwise/api-client";
import type { InboxItem, Reader } from "@stubwise/shared";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ApiError } from "@stubwise/api-client";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import { Linking } from "react-native";
import { AuthContext } from "../../app/auth-context";
import type { InboxStackParamList } from "../../app/navigation";
import type { AuthContextValue } from "../../app/providers";
import "../../i18n";
import { InboxCardScreen } from "./InboxCardScreen";

function item(overrides: Partial<Reader<InboxItem>> & Pick<InboxItem, "id" | "kind">): Reader<InboxItem> {
  return {
    status: "open",
    text: "Testo dell'evento",
    actions: [],
    projectId: null,
    ticketId: null,
    jobId: null,
    createdAt: "2026-09-02T09:48:00.000Z",
    readAt: null,
    snoozedUntil: null,
    handledAt: null,
    handledBy: null,
    reviewOutcome: null,
    ...overrides,
  } as Reader<InboxItem>;
}

const QUESTION_ITEM = item({
  id: "q1",
  kind: "job.awaiting_input",
  text: "Il reso può superare il pagato?",
  actions: ["answer", "open", "snooze"],
  question: {
    questionId: "question-1",
    round: 1,
    question: "Il reso parziale può superare l'importo pagato?",
    options: [{ label: "Blocca al totale pagato" }, { label: "Consenti oltre" }],
    recommendedIndex: 0,
    allowFreeText: true,
  },
});

function makeClient(overrides: { list?: jest.Mock; projects?: jest.Mock; sessions?: jest.Mock } = {}): StubwiseClient {
  return {
    projects: {
      list: overrides.projects ?? jest.fn().mockResolvedValue([]),
    },
    inbox: {
      list: overrides.list ?? jest.fn().mockResolvedValue({ items: [QUESTION_ITEM], nextCursor: null }),
    },
    // Piano C, Task 8: nel doppio PRIMA dei test che lo usano (la ricerca
    // della sessione è una lettura accessoria: senza il metodo fallirebbe in
    // silenzio e la card resterebbe, cioè il test passerebbe per il motivo
    // sbagliato).
    agentSessions: {
      list: overrides.sessions ?? jest.fn().mockResolvedValue({ live: [], recent: [] }),
    },
  } as unknown as StubwiseClient;
}

const clients: QueryClient[] = [];
afterEach(() => {
  // Niente QueryClient vivi a fine test: i timer di gc tengono aperto il processo.
  clients.splice(0).forEach((c) => c.clear());
});

type CardScreenProps = NativeStackScreenProps<InboxStackParamList, "Card">;

async function renderScreen(client: StubwiseClient, id = "q1", backLabel?: string, session?: boolean) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  clients.push(queryClient);
  const authValue: AuthContextValue = {
    status: "authenticated",
    client,
    user: null,
    justLoggedIn: false,
    login: jest.fn(),
    completeOnboarding: jest.fn(),
    openSettings: jest.fn(),
    loggedOut: jest.fn(),
  };
  const navigate = jest.fn();
  const goBack = jest.fn();
  const replace = jest.fn();
  const isFocused = jest.fn(() => true);
  const popTo = jest.fn();
  const navigation = { navigate, goBack, replace, isFocused, popTo } as unknown as CardScreenProps["navigation"];
  const params = {
    id,
    ...(backLabel !== undefined ? { backLabel } : {}),
    ...(session !== undefined ? { session } : {}),
  };
  const route = { key: "Card", name: "Card", params } as unknown as CardScreenProps["route"];

  const rendered = await render(
    <QueryClientProvider client={queryClient}>
      <AuthContext.Provider value={authValue}>
        <InboxCardScreen route={route} navigation={navigation} />
      </AuthContext.Provider>
    </QueryClientProvider>,
  );
  return { ...rendered, navigate, goBack, replace, isFocused, popTo, queryClient };
}

describe("InboxCardScreen", () => {
  test("caricamento: mostra lo skeleton", async () => {
    const client = makeClient({ list: jest.fn(() => new Promise(() => {})) });
    const rendered = await renderScreen(client);
    expect(screen.getByTestId("inbox-card-skeleton")).toBeTruthy();
    // La query non risolve mai apposta: smonta subito, stessa cautela di
    // InboxScreen.test.tsx, per non lasciare un `setState` a inseguire nulla
    // dentro il QueryClient di questo test.
    rendered.unmount();
  });

  test("la riga esiste: rende la InboxCard giusta", async () => {
    const client = makeClient({ list: jest.fn().mockResolvedValue({ items: [QUESTION_ITEM], nextCursor: null }) });
    await renderScreen(client, "q1");
    await waitFor(() => expect(screen.getByTestId("question-card")).toBeTruthy());
    expect(screen.queryByTestId("inbox-card-not-found")).toBeNull();
    expect(screen.queryByTestId("inbox-card-error")).toBeNull();
  });

  // Fix di review (App M1+M2, Task 2, 11 set 2026): rete anti-regressione —
  // l'avatar (unico accesso alle Impostazioni) deve restare raggiungibile su
  // OGNI schermata post-login, incluse quelle di dettaglio come questa (prima
  // del fix ne era priva del tutto).
  test("le Impostazioni sono raggiungibili (avatar presente)", async () => {
    const client = makeClient({ list: jest.fn().mockResolvedValue({ items: [QUESTION_ITEM], nextCursor: null }) });
    await renderScreen(client, "q1");
    await waitFor(() => expect(screen.getByTestId("settings-avatar-button")).toBeTruthy());
  });

  // Caso 1 dei due richiesti dalla revisione: la query RIESCE ma la riga non
  // c'è più (gestita/rinviata da qualcun altro, o un deep link su un id ormai
  // scaduto) — è cronologia, non un guasto.
  test("item davvero assente (query riuscita, id non nella lista): mostra 'non trovata'", async () => {
    const client = makeClient({ list: jest.fn().mockResolvedValue({ items: [QUESTION_ITEM], nextCursor: null }) });
    await renderScreen(client, "non-esiste-più");

    await waitFor(() => expect(screen.getByTestId("inbox-card-not-found")).toBeTruthy());
    expect(screen.getByText("Questa card non c'è più.")).toBeTruthy();
    expect(screen.queryByTestId("inbox-card-error")).toBeNull();
    expect(screen.queryByTestId("inbox-card-retry")).toBeNull();
  });

  // Caso 2: la query FALLISCE (rete ballerina — il caso più probabile
  // all'apertura di un deep link push, notifica appena arrivata, tap
  // immediato). Deve restare DISTINTO da "non trovata": qui c'è un retry,
  // non un esito rassicurante "gestita da qualcun altro".
  test("query fallita (rete): mostra errore+retry, MAI 'non trovata'", async () => {
    const list = jest.fn().mockRejectedValueOnce(new Error("network down")).mockResolvedValueOnce({
      items: [QUESTION_ITEM],
      nextCursor: null,
    });
    const client = makeClient({ list });
    await renderScreen(client, "q1");

    await waitFor(() => expect(screen.getByTestId("inbox-card-error")).toBeTruthy());
    expect(screen.getByText("Non riesco a caricare l'inbox.")).toBeTruthy();
    expect(screen.queryByTestId("inbox-card-not-found")).toBeNull();
    expect(screen.queryByText("Questa card non c'è più.")).toBeNull();

    // Riprova: la seconda chiamata risolve, la card compare.
    await fireEvent.press(screen.getByTestId("inbox-card-retry"));
    await waitFor(() => expect(screen.getByTestId("question-card")).toBeTruthy());
    expect(screen.queryByTestId("inbox-card-error")).toBeNull();
  });

  test("'Torna all'Inbox' naviga verso la lista", async () => {
    const client = makeClient();
    const { popTo } = await renderScreen(client);
    await waitFor(() => expect(screen.getByTestId("question-card")).toBeTruthy());
    await fireEvent.press(screen.getByTestId("inbox-card-back"));
    expect(popTo).toHaveBeenCalledWith("List");
  });

  // Dettaglio progetto v3 (28 set 2026): «Rispondi» apre questa card dentro
  // lo stack dei PROGETTI, dove `List` è l'elenco dei progetti. Da lì il
  // bottone dice il progetto e torna indietro, non all'inbox.
  test("aperta dall'hub di un progetto: il bottone dice il progetto e torna indietro", async () => {
    const client = makeClient();
    const { navigate, goBack } = await renderScreen(client, "q1", "Portale B2B");
    await waitFor(() => expect(screen.getByTestId("question-card")).toBeTruthy());
    expect(screen.getByText("‹ Portale B2B")).toBeTruthy();
    await fireEvent.press(screen.getByTestId("inbox-card-back"));
    expect(goBack).toHaveBeenCalledTimes(1);
    expect(navigate).not.toHaveBeenCalled();
  });
});

/** «Apri» porta al ticket NELL'APP, su Stato (pagina del ticket a tab, Task 9). */
describe("InboxCardScreen — «Apri» sul ticket nell'app", () => {
  const TICKET_ID = "77777777-7777-4777-8777-777777777777";

  test("una card di ticket: naviga a Projects/Ticket con la tab, il browser no", async () => {
    const failed = item({
      id: "f1",
      kind: "job.failed",
      actions: ["open"],
      url: "https://stubwise.example/tickets/77777777",
      ticketId: TICKET_ID,
    });
    (Linking.openURL as jest.Mock).mockClear();
    const client = makeClient({ list: jest.fn().mockResolvedValue({ items: [failed], nextCursor: null }) });
    const { navigate } = await renderScreen(client, "f1");
    await waitFor(() => expect(screen.getByTestId("failed-card-open")).toBeTruthy());
    await fireEvent.press(screen.getByTestId("failed-card-open"));
    // Nello stesso stack della card, non in Projects: «indietro» torna alla card.
    expect(navigate).toHaveBeenCalledWith("Ticket", { id: TICKET_ID, tab: "status", backLabel: "Inbox" });
    expect(Linking.openURL).not.toHaveBeenCalled();
  });
});

/**
 * Piano C, Task 8 (preflight H3): la push di una domanda apre la card con
 * `session: true`. La card cerca da sé la sessione del job e la sostituisce a
 * sé stessa SOLO se la trova; in ogni altro caso resta — Review Focus 5: con
 * un server senza sessioni la push apre comunque la card, come oggi.
 */
describe("InboxCardScreen — dalla push alla sessione", () => {
  const JOB_ID = "88888888-8888-4888-8888-888888888888";
  const TICKET_ID = "77777777-7777-4777-8777-777777777777";
  const WITH_JOB = { ...QUESTION_ITEM, jobId: JOB_ID, ticketId: TICKET_ID } as Reader<InboxItem>;
  const SESSION = { id: "s1", state: "waiting_input" };

  function clientWith(sessions: jest.Mock, items: Reader<InboxItem>[] = [WITH_JOB]) {
    return makeClient({ list: jest.fn().mockResolvedValue({ items, nextCursor: null }), sessions });
  }

  test("sessione trovata: sostituisce la card con la sessione, sulla domanda", async () => {
    const sessions = jest.fn().mockResolvedValue({ live: [SESSION], recent: [] });
    const { replace } = await renderScreen(clientWith(sessions), "q1", undefined, true);
    await waitFor(() => expect(replace).toHaveBeenCalledWith("AgentSession", { id: "s1", focus: "question" }));
    expect(sessions).toHaveBeenCalledWith({ aiJobId: JOB_ID });
  });

  test("nessuna sessione: resta sulla card", async () => {
    const sessions = jest.fn().mockResolvedValue({ live: [], recent: [] });
    const { replace } = await renderScreen(clientWith(sessions), "q1", undefined, true);
    await waitFor(() => expect(sessions).toHaveBeenCalledTimes(1));
    await act(async () => {});
    expect(screen.getByTestId("question-card")).toBeTruthy();
    expect(replace).not.toHaveBeenCalled();
  });

  test("server senza sessioni (404 senza code): la card resta, UNA sola richiesta (Review Focus 5)", async () => {
    const sessions = jest.fn().mockRejectedValue(new ApiError(404, "not found"));
    const { replace, navigate } = await renderScreen(clientWith(sessions), "q1", undefined, true);
    await waitFor(() => expect(sessions).toHaveBeenCalledTimes(1));
    await act(async () => {});
    expect(screen.getByTestId("question-card")).toBeTruthy();
    expect(replace).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
    expect(sessions).toHaveBeenCalledTimes(1);
  });

  test("errore qualunque: la card resta", async () => {
    const sessions = jest.fn().mockRejectedValue(new Error("network down"));
    const { replace } = await renderScreen(clientWith(sessions), "q1", undefined, true);
    await waitFor(() => expect(sessions).toHaveBeenCalledTimes(1));
    await act(async () => {});
    expect(screen.getByTestId("question-card")).toBeTruthy();
    expect(replace).not.toHaveBeenCalled();
  });

  test("card senza jobId: nessuna ricerca, resta sulla card", async () => {
    const sessions = jest.fn().mockResolvedValue({ live: [SESSION], recent: [] });
    const { replace } = await renderScreen(clientWith(sessions, [QUESTION_ITEM]), "q1", undefined, true);
    await waitFor(() => expect(screen.getByTestId("question-card")).toBeTruthy());
    await act(async () => {});
    expect(sessions).not.toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();
  });

  test("senza `session` (aperta dalla lista o da un altro link): nessuna ricerca", async () => {
    const sessions = jest.fn().mockResolvedValue({ live: [SESSION], recent: [] });
    const { replace } = await renderScreen(clientWith(sessions), "q1");
    await waitFor(() => expect(screen.getByTestId("question-card")).toBeTruthy());
    await act(async () => {});
    expect(sessions).not.toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();
  });

  // Fix round 1: la decisione si prende UNA volta, a card intatta.
  test("mentre cerca la sessione la card non è interattiva: uno skeleton, niente «Rispondi»", async () => {
    const sessions = jest.fn(() => new Promise(() => {}));
    const rendered = await renderScreen(clientWith(sessions), "q1", undefined, true);
    await waitFor(() => expect(sessions).toHaveBeenCalledTimes(1));
    expect(screen.getByTestId("inbox-card-skeleton")).toBeTruthy();
    expect(screen.queryByTestId("question-card-respond")).toBeNull();
    rendered.unmount();
  });

  test("la ricerca risponde quando la schermata ha già perso il fuoco: nessun replace", async () => {
    let resolve: (value: unknown) => void = () => {};
    const sessions = jest.fn(() => new Promise((r) => (resolve = r)));
    const { replace, isFocused } = await renderScreen(clientWith(sessions), "q1", undefined, true);
    await waitFor(() => expect(sessions).toHaveBeenCalledTimes(1));
    isFocused.mockReturnValue(false);
    await act(async () => {
      resolve({ live: [SESSION], recent: [] });
    });
    // Tempo vero perché l'effetto (se ci fosse) parta: un `act` vuoto non basta sempre.
    await act(async () => {
      await new Promise<void>((done) => setTimeout(done, 50));
    });
    expect(replace).not.toHaveBeenCalled();
  });

  test("una ricerca successiva che trova la sessione, a card già decisa, non la sostituisce più", async () => {
    const sessions = jest.fn().mockResolvedValueOnce({ live: [], recent: [] }).mockResolvedValue({ live: [SESSION], recent: [] });
    const { replace, queryClient } = await renderScreen(clientWith(sessions), "q1", undefined, true);
    await waitFor(() => expect(screen.getByTestId("question-card")).toBeTruthy());
    await act(async () => {
      await queryClient.refetchQueries({ queryKey: ["agent-sessions"] });
    });
    expect(sessions).toHaveBeenCalledTimes(2);
    await act(async () => {
      await new Promise<void>((done) => setTimeout(done, 50));
    });
    expect(replace).not.toHaveBeenCalled();
    expect(screen.getByTestId("question-card")).toBeTruthy();
  });

  test("«Apri» di una domanda (non più rispondibile da qui) porta alla ricerca della sessione", async () => {
    const answered = { ...WITH_JOB, actions: ["open"] } as Reader<InboxItem>;
    const { navigate } = await renderScreen(clientWith(jest.fn(), [answered]), "q1");
    await waitFor(() => expect(screen.getByTestId("question-card-open")).toBeTruthy());
    await fireEvent.press(screen.getByTestId("question-card-open"));
    expect(navigate).toHaveBeenCalledWith("AgentSessionByJob", { jobId: JOB_ID, ticketId: TICKET_ID });
  });
});
