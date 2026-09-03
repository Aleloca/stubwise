import type { StubwiseClient } from "@stubwise/api-client";
import type { InboxItem, Reader } from "@stubwise/shared";
import notifee from "@notifee/react-native";
import NetInfo from "@react-native-community/netinfo";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import { AuthContext } from "../../app/auth-context";
import type { AuthContextValue } from "../../app/providers";
import "../../i18n";
import { InboxScreen } from "./InboxScreen";

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

function makeClient(overrides: { list?: jest.Mock; unreadCount?: jest.Mock; projects?: jest.Mock } = {}): StubwiseClient {
  return {
    projects: {
      list: overrides.projects ?? jest.fn().mockResolvedValue([]),
    },
    inbox: {
      list: overrides.list ?? jest.fn().mockResolvedValue({ items: [], nextCursor: null }),
      unreadCount: overrides.unreadCount ?? jest.fn().mockResolvedValue({ count: 0 }),
    },
  } as unknown as StubwiseClient;
}

async function renderScreen(client: StubwiseClient, role: "admin" | "member" = "member") {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const authValue: AuthContextValue = {
    status: "authenticated",
    client,
    user: { id: "u1", email: "op@example.com", role, language: "it", avatarUrl: null, slackUserId: null },
    justLoggedIn: false,
    login: jest.fn(),
    completeOnboarding: jest.fn(),
  };
  return render(
    <QueryClientProvider client={queryClient}>
      <AuthContext.Provider value={authValue}>
        <InboxScreen />
      </AuthContext.Provider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  // AUTHORIZED di default: solo i test sui permessi negati lo sovrascrivono.
  (notifee.getNotificationSettings as jest.Mock).mockResolvedValue({ authorizationStatus: 1 });
  (NetInfo.useNetInfo as jest.Mock).mockReturnValue({ isConnected: true, isInternetReachable: true });
});

describe("InboxScreen", () => {
  test("caricamento: mostra lo skeleton, non uno spinner a pagina intera", async () => {
    const client = makeClient({ list: jest.fn(() => new Promise(() => {})) });
    const rendered = await renderScreen(client);
    expect(screen.getByTestId("inbox-skeleton")).toBeTruthy();
    // La query non risolve mai apposta (verifica lo stato di caricamento):
    // smonta subito così non resta a inseguire un `setState` per sempre
    // dentro il QueryClient di questo test.
    rendered.unmount();
  });

  test("inbox vuota: 'Tutto gestito.'", async () => {
    const client = makeClient();
    await renderScreen(client);
    await waitFor(() => expect(screen.getByText("Tutto gestito.")).toBeTruthy());
    expect(screen.getByText("Ti avviso io quando un progetto ha bisogno di te.")).toBeTruthy();
  });

  test("offline: banner persistente in cima alla lista", async () => {
    (NetInfo.useNetInfo as jest.Mock).mockReturnValue({ isConnected: false, isInternetReachable: false });
    const client = makeClient();
    await renderScreen(client);
    await waitFor(() => expect(screen.getByText(/Offline/)).toBeTruthy());
  });

  test("permessi di notifica negati: card non bloccante — il resto dello screen resta usabile", async () => {
    (notifee.getNotificationSettings as jest.Mock).mockResolvedValue({ authorizationStatus: 0 });
    const client = makeClient({ list: jest.fn().mockResolvedValue({ items: [QUESTION_ITEM], nextCursor: null }) });
    await renderScreen(client);

    await waitFor(() => expect(screen.getByTestId("inbox-notifications-denied")).toBeTruthy());
    expect(screen.getByText("Stubwise non può raggiungerti")).toBeTruthy();
    // Non bloccante: la card sotto resta a schermo e coi suoi bottoni attivi.
    expect(screen.getByTestId("question-card-respond")).toBeTruthy();
  });

  test("con righe aperte: divide nelle sezioni e mostra il conteggio", async () => {
    const client = makeClient({ list: jest.fn().mockResolvedValue({ items: [QUESTION_ITEM], nextCursor: null }) });
    await renderScreen(client);
    await waitFor(() => expect(screen.getByText("Ti blocca · 1")).toBeTruthy());
    expect(screen.getByTestId("question-card-respond")).toBeTruthy();
  });

  test("errore di caricamento: mostra Riprova, che ricarica", async () => {
    const list = jest.fn().mockRejectedValueOnce(new Error("network down")).mockResolvedValueOnce({ items: [], nextCursor: null });
    const client = makeClient({ list });
    await renderScreen(client);
    await waitFor(() => expect(screen.getByText("Non riesco a caricare l'inbox.")).toBeTruthy());
    await fireEvent.press(screen.getByTestId("inbox-retry"));
    await waitFor(() => expect(screen.getByText("Tutto gestito.")).toBeTruthy());
  });
});
