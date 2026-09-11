import type { StubwiseClient } from "@stubwise/api-client";
import type { InboxItem, Reader } from "@stubwise/shared";
import notifee from "@notifee/react-native";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import { StyleSheet } from "react-native";
import { useBottomTabBarHeight } from "react-native-bottom-tabs";
import { AuthContext } from "../../app/auth-context";
import type { AuthContextValue } from "../../app/providers";
import "../../i18n";
import { InboxScreen } from "./InboxScreen";

/**
 * Cerca il primo nodo HOST di un dato `type` (es. `"RCTScrollView"`)
 * nell'albero di `rendered.toJSON()` — RTL v14 ha tolto `UNSAFE_getByType`
 * (risolveva comunque solo componenti host, mai composite: vedi le note di
 * migrazione v14), quindi si cerca a mano nell'unico output che resta
 * completo, il JSON dell'albero renderizzato.
 */
function findHostNode(tree: unknown, type: string): { props: Record<string, unknown> } | null {
  if (tree === null || tree === undefined) return null;
  if (Array.isArray(tree)) {
    for (const node of tree) {
      const found = findHostNode(node, type);
      if (found) return found;
    }
    return null;
  }
  const node = tree as { type?: string; children?: unknown; props?: Record<string, unknown> };
  if (node.type === type) return node as { props: Record<string, unknown> };
  return findHostNode(node.children, type);
}

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
    openSettings: jest.fn(),
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

  // Fix di review (App M1+M2, Task 2, 11 set 2026): rete anti-regressione —
  // l'avatar (unico accesso alle Impostazioni) deve restare raggiungibile su
  // OGNI schermata post-login, ripetuto file per file (vedi il piano dei fix).
  test("le Impostazioni sono raggiungibili (avatar presente)", async () => {
    const client = makeClient();
    await renderScreen(client);
    await waitFor(() => expect(screen.getByTestId("settings-avatar-button")).toBeTruthy());
  });

  // Fix di review (App M1+M2, Task 3, 11 set 2026): rete anti-regressione —
  // prima di questo test nessun test discriminava il margine di scorrimento
  // in fondo (Task 6): il mock globale di `useBottomTabBarHeight` restituisce
  // `0`, quindi togliere `+ tabBarHeight` dallo `ScrollView` non avrebbe
  // fatto fallire NIENTE. Qui si sovrascrive il mock con un valore reale e si
  // verifica che il `paddingBottom` effettivo lo includa davvero — via
  // `toJSON()` (RTL v14 ha tolto `UNSAFE_getByType`, che risolveva comunque
  // solo componenti host: `contentContainerStyle` di `ScrollView` finisce sul
  // nodo host `RCTScrollView`, verificato leggendo l'albero renderizzato).
  test("il margine sotto la barra include l'altezza reale della tab bar", async () => {
    (useBottomTabBarHeight as jest.Mock).mockReturnValue(80);
    const client = makeClient();
    const rendered = await renderScreen(client);
    await waitFor(() => expect(screen.getByText("Tutto gestito.")).toBeTruthy());
    const scrollView = findHostNode(rendered.toJSON(), "RCTScrollView");
    expect(scrollView).not.toBeNull();
    const flat = StyleSheet.flatten(scrollView!.props.contentContainerStyle as never);
    expect(flat.paddingBottom).toBe(40 + 80);
    (useBottomTabBarHeight as jest.Mock).mockReturnValue(0);
  });

  // Il banner offline NON è più responsabilità di questo screen (Task 20:
  // spostato in `app/providers.tsx`, top bar globale sopra ogni tab — vedi
  // il docblock su `InboxScreen`). La copertura "InboxScreen offline" vive
  // ora a un livello di composizione più alto, in
  // `app/navigation.test.tsx` ("il banner offline globale non duplica —
  // compare UNA sola volta anche sulla tab Inbox reale"): qui, isolato
  // dietro un `AuthContext.Provider` fittizio senza `AppProviders`, non
  // c'è alcun banner da testare per definizione.

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
