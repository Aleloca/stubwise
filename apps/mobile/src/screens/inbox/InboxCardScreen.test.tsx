import type { StubwiseClient } from "@stubwise/api-client";
import type { InboxItem, Reader } from "@stubwise/shared";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react-native";
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

function makeClient(overrides: { list?: jest.Mock; projects?: jest.Mock } = {}): StubwiseClient {
  return {
    projects: {
      list: overrides.projects ?? jest.fn().mockResolvedValue([]),
    },
    inbox: {
      list: overrides.list ?? jest.fn().mockResolvedValue({ items: [QUESTION_ITEM], nextCursor: null }),
    },
  } as unknown as StubwiseClient;
}

type CardScreenProps = NativeStackScreenProps<InboxStackParamList, "Card">;

async function renderScreen(client: StubwiseClient, id = "q1") {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const authValue: AuthContextValue = {
    status: "authenticated",
    client,
    user: null,
    justLoggedIn: false,
    login: jest.fn(),
    completeOnboarding: jest.fn(),
  };
  const navigate = jest.fn();
  const navigation = { navigate } as unknown as CardScreenProps["navigation"];
  const route = { key: "Card", name: "Card", params: { id } } as unknown as CardScreenProps["route"];

  const rendered = await render(
    <QueryClientProvider client={queryClient}>
      <AuthContext.Provider value={authValue}>
        <InboxCardScreen route={route} navigation={navigation} />
      </AuthContext.Provider>
    </QueryClientProvider>,
  );
  return { ...rendered, navigate };
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
    const { navigate } = await renderScreen(client);
    await waitFor(() => expect(screen.getByTestId("question-card")).toBeTruthy());
    await fireEvent.press(screen.getByTestId("inbox-card-back"));
    expect(navigate).toHaveBeenCalledWith("List");
  });
});
