import type { StubwiseClient } from "@stubwise/api-client";
import { ApiError } from "@stubwise/api-client";
import type { BacklogItemDetail, Reader } from "@stubwise/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import { AuthContext } from "../../app/auth-context";
import type { AuthContextValue } from "../../app/providers";
import "../../i18n";
import { BacklogItemScreen } from "./BacklogItemScreen";

const ITEM_ID = "88888888-8888-4888-8888-888888888888";
const TICKET_ID = "99999999-9999-4999-8999-999999999999";

function item(overrides: Partial<Reader<BacklogItemDetail>> = {}): Reader<BacklogItemDetail> {
  return {
    id: ITEM_ID,
    projectId: "proj-1",
    title: "Accesso clienti con SSO",
    document: "I clienti enterprise chiedono il login SSO.",
    implementationPlan: null,
    originContent: null,
    status: "ready",
    effort: 4,
    risk: "medium",
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

function makeClient(overrides: { get?: jest.Mock; convert?: jest.Mock } = {}): StubwiseClient {
  return {
    backlog: {
      get: overrides.get ?? jest.fn().mockResolvedValue(item()),
      convert: overrides.convert ?? jest.fn().mockResolvedValue({ ticketId: TICKET_ID, ticketNumber: 7 }),
      list: jest.fn(),
      create: jest.fn(),
      chat: jest.fn(),
      chatText: jest.fn(),
    },
  } as unknown as StubwiseClient;
}

async function renderScreen(client: StubwiseClient) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const goBack = jest.fn();
  const navigate = jest.fn();
  const authValue: AuthContextValue = {
    status: "authenticated",
    client,
    user: { id: "viewer-1", email: "op@example.com", role: "member", language: "it", avatarUrl: null, slackUserId: null },
    justLoggedIn: false,
    login: jest.fn(),
    completeOnboarding: jest.fn(),
  };
  const navigation = { goBack, navigate } as never;
  await render(
    <QueryClientProvider client={queryClient}>
      <AuthContext.Provider value={authValue}>
        <BacklogItemScreen navigation={navigation} route={{ key: "Item", name: "Item", params: { id: ITEM_ID } }} />
      </AuthContext.Provider>
    </QueryClientProvider>,
  );
  return { goBack, navigate };
}

describe("BacklogItemScreen — caricamento ed errori", () => {
  test("caricamento: mostra lo skeleton", async () => {
    const client = makeClient({ get: jest.fn(() => new Promise(() => {})) });
    await renderScreen(client);
    expect(screen.getByTestId("backlog-item-skeleton")).toBeTruthy();
  });

  test("404: stato 'non c'è più'", async () => {
    const client = makeClient({ get: jest.fn().mockRejectedValue(new ApiError(404, "Not found", "backlog_item_not_found")) });
    await renderScreen(client);
    await waitFor(() => expect(screen.getByTestId("backlog-item-not-found")).toBeTruthy());
  });

  test("errore di rete: Riprova ricarica", async () => {
    const get = jest.fn().mockRejectedValueOnce(new Error("down")).mockResolvedValueOnce(item());
    const client = makeClient({ get });
    await renderScreen(client);
    await waitFor(() => expect(screen.getByTestId("backlog-item-retry")).toBeTruthy());
    await fireEvent.press(screen.getByTestId("backlog-item-retry"));
    await waitFor(() => expect(screen.getByText("Accesso clienti con SSO")).toBeTruthy());
  });

  test("il tasto indietro chiama goBack", async () => {
    const { goBack } = await renderScreen(makeClient());
    await waitFor(() => expect(screen.getByText("Accesso clienti con SSO")).toBeTruthy());
    await fireEvent.press(screen.getByTestId("backlog-item-back"));
    expect(goBack).toHaveBeenCalled();
  });
});

describe("BacklogItemScreen — corpo", () => {
  test("titolo, stato in parole, metadati e documento", async () => {
    await renderScreen(makeClient());
    await waitFor(() => expect(screen.getByText("Accesso clienti con SSO")).toBeTruthy());
    expect(screen.getByText("Pronto")).toBeTruthy();
    expect(screen.getByText("alta · E4 · rischio medio")).toBeTruthy();
    expect(screen.getByText("I clienti enterprise chiedono il login SSO.")).toBeTruthy();
  });

  test("voce 'ready': Procedi converte e naviga al Lavoro del ticket creato", async () => {
    const convert = jest.fn().mockResolvedValue({ ticketId: TICKET_ID, ticketNumber: 7 });
    const client = makeClient({ convert });
    const { navigate } = await renderScreen(client);
    await waitFor(() => expect(screen.getByTestId("backlog-item-proceed")).toBeTruthy());
    await fireEvent.press(screen.getByTestId("backlog-item-proceed"));
    await waitFor(() => expect(convert).toHaveBeenCalledWith(ITEM_ID));
    await waitFor(() =>
      expect(navigate).toHaveBeenCalledWith("Main", {
        screen: "Projects",
        params: { screen: "Ticket", params: { id: TICKET_ID } },
      }),
    );
  });

  test("voce convertita: niente Procedi né Raffina", async () => {
    const client = makeClient({ get: jest.fn().mockResolvedValue(item({ status: "converted" })) });
    await renderScreen(client);
    await waitFor(() => expect(screen.getByText("Accesso clienti con SSO")).toBeTruthy());
    expect(screen.queryByTestId("backlog-item-proceed")).toBeNull();
    expect(screen.queryByTestId("backlog-item-refine")).toBeNull();
  });

  test("voce 'refining': niente Procedi, Raffina naviga alla Chat", async () => {
    const client = makeClient({ get: jest.fn().mockResolvedValue(item({ status: "refining" })) });
    const { navigate } = await renderScreen(client);
    await waitFor(() => expect(screen.getByTestId("backlog-item-refine")).toBeTruthy());
    expect(screen.queryByTestId("backlog-item-proceed")).toBeNull();
    await fireEvent.press(screen.getByTestId("backlog-item-refine"));
    expect(navigate).toHaveBeenCalledWith("Chat", { id: ITEM_ID });
  });

  test("ticket collegati: elencati, un tap naviga al Lavoro di quel ticket", async () => {
    const linkedTicketId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const client = makeClient({
      get: jest
        .fn()
        .mockResolvedValue(item({ status: "converted", tickets: [{ id: linkedTicketId, number: 12, title: "Login SSO enterprise", role: "converted_to" }] })),
    });
    const { navigate } = await renderScreen(client);
    await waitFor(() => expect(screen.getByText("Login SSO enterprise")).toBeTruthy());
    await fireEvent.press(screen.getByTestId(`backlog-item-ticket-${linkedTicketId}`));
    expect(navigate).toHaveBeenCalledWith("Main", {
      screen: "Projects",
      params: { screen: "Ticket", params: { id: linkedTicketId } },
    });
  });
});
