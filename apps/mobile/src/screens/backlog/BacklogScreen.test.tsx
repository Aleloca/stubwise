import type { StubwiseClient } from "@stubwise/api-client";
import type { BacklogItem, Reader } from "@stubwise/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import { AuthContext } from "../../app/auth-context";
import type { AuthContextValue } from "../../app/providers";
import "../../i18n";
import { BacklogScreen } from "./BacklogScreen";

const TICKET_ID = "33333333-3333-4333-8333-333333333333";
const PROJECT = { id: "proj-1", name: "Portale B2B" };

function item(overrides: Partial<Reader<BacklogItem>> = {}): Reader<BacklogItem> {
  return {
    id: "item-1",
    projectId: PROJECT.id,
    title: "Export massivo degli ordini",
    status: "ready",
    effort: 3,
    risk: "low",
    riskNote: null,
    urgency: "high",
    requestCount: 4,
    source: "manual",
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    similarTo: null,
    ticketCount: 0,
    ...overrides,
  } as Reader<BacklogItem>;
}

function makeClient(overrides: {
  list?: jest.Mock;
  convert?: jest.Mock;
  create?: jest.Mock;
  projectsList?: jest.Mock;
} = {}): StubwiseClient {
  return {
    backlog: {
      list: overrides.list ?? jest.fn().mockResolvedValue({ items: [], nextCursor: null }),
      get: jest.fn(),
      convert: overrides.convert ?? jest.fn().mockResolvedValue({ ticketId: TICKET_ID, ticketNumber: 42 }),
      create: overrides.create ?? jest.fn().mockResolvedValue({ queued: true, jobId: "job-1" }),
      chat: jest.fn(),
      chatText: jest.fn(),
    },
    projects: {
      list: overrides.projectsList ?? jest.fn().mockResolvedValue([PROJECT]),
      get: jest.fn(),
      pulse: jest.fn(),
    },
  } as unknown as StubwiseClient;
}

async function renderScreen(client: StubwiseClient) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const navigate = jest.fn();
  const authValue: AuthContextValue = {
    status: "authenticated",
    client,
    user: { id: "viewer-1", email: "op@example.com", role: "member", language: "it", avatarUrl: null, slackUserId: null },
    justLoggedIn: false,
    login: jest.fn(),
    completeOnboarding: jest.fn(),
  };
  const navigation = { navigate } as never;
  await render(
    <QueryClientProvider client={queryClient}>
      <AuthContext.Provider value={authValue}>
        <BacklogScreen navigation={navigation} route={{ key: "List", name: "List", params: undefined }} />
      </AuthContext.Provider>
    </QueryClientProvider>,
  );
  return { navigate };
}

describe("BacklogScreen — caricamento, errori, vuoto", () => {
  test("caricamento: mostra lo skeleton", async () => {
    // Anche `projectsList` resta in sospeso: altrimenti risolverebbe su un
    // microtask successivo al render (fuori da un `act()`/`waitFor` che
    // questo test — sullo SKELETON, non sui progetti — non ha motivo di
    // attendere), producendo un warning "not wrapped in act(...)" innocuo ma
    // evitabile.
    const client = makeClient({
      list: jest.fn(() => new Promise(() => {})),
      projectsList: jest.fn(() => new Promise(() => {})),
    });
    await renderScreen(client);
    expect(screen.getByTestId("backlog-skeleton")).toBeTruthy();
  });

  test("errore di rete: mostra Riprova, che ricarica", async () => {
    const list = jest.fn().mockRejectedValueOnce(new Error("down")).mockResolvedValueOnce({ items: [item()], nextCursor: null });
    const client = makeClient({ list });
    await renderScreen(client);
    await waitFor(() => expect(screen.getByTestId("backlog-retry")).toBeTruthy());
    await fireEvent.press(screen.getByTestId("backlog-retry"));
    await waitFor(() => expect(screen.getByText("Export massivo degli ordini")).toBeTruthy());
  });

  test("lista vuota: stato vuoto dedicato", async () => {
    const client = makeClient({ list: jest.fn().mockResolvedValue({ items: [], nextCursor: null }) });
    await renderScreen(client);
    await waitFor(() => expect(screen.getByTestId("backlog-empty")).toBeTruthy());
  });
});

describe("BacklogScreen — chip di filtro", () => {
  test("chip 'Attivi' (default): nessun filtro di stato", async () => {
    const list = jest.fn().mockResolvedValue({ items: [], nextCursor: null });
    const client = makeClient({ list });
    await renderScreen(client);
    await waitFor(() => expect(list).toHaveBeenCalledWith({ projectId: undefined }));
  });

  test("chip 'Pronti': status=ready", async () => {
    const list = jest.fn().mockResolvedValue({ items: [], nextCursor: null });
    const client = makeClient({ list });
    await renderScreen(client);
    await waitFor(() => expect(screen.getByTestId("backlog-empty")).toBeTruthy());
    await fireEvent.press(screen.getByTestId("backlog-chip-ready"));
    await waitFor(() => expect(list).toHaveBeenCalledWith({ projectId: undefined, status: "ready" }));
  });

  test("chip 'Tutti': unisce attivi + convertiti + archiviati (una voce SOLO convertita compare qui, non in Attivi)", async () => {
    const list = jest.fn((filters: { status?: string }) => {
      if (filters.status === "converted") {
        return Promise.resolve({ items: [item({ id: "item-converted", title: "Voce convertita", status: "converted" })], nextCursor: null });
      }
      if (filters.status === "archived") {
        return Promise.resolve({ items: [], nextCursor: null });
      }
      return Promise.resolve({ items: [], nextCursor: null });
    });
    const client = makeClient({ list });
    await renderScreen(client);
    await waitFor(() => expect(screen.getByTestId("backlog-empty")).toBeTruthy());
    expect(screen.queryByText("Voce convertita")).toBeNull();

    await fireEvent.press(screen.getByTestId("backlog-chip-all"));
    await waitFor(() => expect(screen.getByText("Voce convertita")).toBeTruthy());
    expect(list).toHaveBeenCalledWith({ projectId: undefined, status: "converted" });
    expect(list).toHaveBeenCalledWith({ projectId: undefined, status: "archived" });
  });
});

describe("BacklogScreen — card: stato in parole e metadati", () => {
  test("voce pronta: 'Pronto', urgenza · effort · rischio · richiesto N volte", async () => {
    const client = makeClient({ list: jest.fn().mockResolvedValue({ items: [item()], nextCursor: null }) });
    await renderScreen(client);
    await waitFor(() => expect(screen.getByText("Export massivo degli ordini")).toBeTruthy());
    expect(screen.getByText("Pronto")).toBeTruthy();
    expect(screen.getByText("alta · E3 · rischio basso · richiesto 4 volte")).toBeTruthy();
  });

  test("voce in raffinamento: 'In raffinamento', niente Procedi, 'chat aperta ›' in coda", async () => {
    const client = makeClient({
      list: jest.fn().mockResolvedValue({
        items: [item({ id: "item-refining", status: "refining", requestCount: 1, urgency: "medium", effort: 3, risk: null })],
        nextCursor: null,
      }),
    });
    await renderScreen(client);
    await waitFor(() => expect(screen.getByText("In raffinamento")).toBeTruthy());
    expect(screen.getByText("media · E3 · chat aperta ›")).toBeTruthy();
    expect(screen.queryByTestId("backlog-proceed-item-refining")).toBeNull();
    expect(screen.getByTestId("backlog-refine-item-refining")).toBeTruthy();
  });

  test("voce nuova senza stime: 'da stimare — l'agente ci sta lavorando'", async () => {
    const client = makeClient({
      list: jest.fn().mockResolvedValue({
        items: [item({ id: "item-new", status: "new", urgency: null, effort: null, risk: null, requestCount: 1 })],
        nextCursor: null,
      }),
    });
    await renderScreen(client);
    await waitFor(() => expect(screen.getByText("da stimare — l'agente ci sta lavorando")).toBeTruthy());
  });

  test("voce convertita: card cliccabile verso il dettaglio, niente Procedi/Raffina", async () => {
    const client = makeClient({
      list: jest.fn().mockResolvedValue({ items: [item({ id: "item-conv", status: "converted" })], nextCursor: null }),
    });
    const { navigate } = await renderScreen(client);
    await waitFor(() => expect(screen.getByTestId("backlog-card-item-conv")).toBeTruthy());
    expect(screen.queryByTestId("backlog-proceed-item-conv")).toBeNull();
    expect(screen.queryByTestId("backlog-refine-item-conv")).toBeNull();
    await fireEvent.press(screen.getByTestId("backlog-card-item-conv"));
    expect(navigate).toHaveBeenCalledWith("Item", { id: "item-conv" });
  });
});

describe("BacklogScreen — Procedi e Raffina in chat", () => {
  test("Procedi: chiama convert e naviga al Lavoro del ticket creato", async () => {
    const convert = jest.fn().mockResolvedValue({ ticketId: TICKET_ID, ticketNumber: 42 });
    const client = makeClient({ list: jest.fn().mockResolvedValue({ items: [item()], nextCursor: null }), convert });
    const { navigate } = await renderScreen(client);
    await waitFor(() => expect(screen.getByTestId("backlog-proceed-item-1")).toBeTruthy());
    await fireEvent.press(screen.getByTestId("backlog-proceed-item-1"));
    await waitFor(() => expect(convert).toHaveBeenCalledWith("item-1"));
    await waitFor(() =>
      expect(navigate).toHaveBeenCalledWith("Main", {
        screen: "Projects",
        params: { screen: "Ticket", params: { id: TICKET_ID } },
      }),
    );
  });

  test("Raffina in chat: naviga alla Chat della voce", async () => {
    const client = makeClient({ list: jest.fn().mockResolvedValue({ items: [item()], nextCursor: null }) });
    const { navigate } = await renderScreen(client);
    await waitFor(() => expect(screen.getByTestId("backlog-refine-item-1")).toBeTruthy());
    await fireEvent.press(screen.getByTestId("backlog-refine-item-1"));
    expect(navigate).toHaveBeenCalledWith("Chat", { id: "item-1" });
  });
});

describe("BacklogScreen — cattura rapida", () => {
  test("FAB '+' apre la sheet; una create riuscita mostra il toast e invalida la lista", async () => {
    const list = jest.fn().mockResolvedValue({ items: [], nextCursor: null });
    const create = jest.fn().mockResolvedValue({ queued: true, jobId: "job-1" });
    const client = makeClient({ list, create });
    await renderScreen(client);
    // Il FAB resta disabilitato finché i progetti (query separata) non sono
    // caricati — attendere solo che compaia non basta, va atteso abilitato.
    await waitFor(() => expect(screen.getByTestId("backlog-add").props.accessibilityState?.disabled).toBe(false));

    await fireEvent.press(screen.getByTestId("backlog-add"));
    expect(screen.getByTestId("capture-sheet-input")).toBeTruthy();

    await fireEvent.changeText(screen.getByTestId("capture-sheet-input"), "I clienti chiedono un export massivo");
    await fireEvent.press(screen.getByTestId("capture-sheet-submit"));

    await waitFor(() =>
      expect(create).toHaveBeenCalledWith({
        projectId: PROJECT.id,
        title: "I clienti chiedono un export massivo",
        body: "I clienti chiedono un export massivo",
      }),
    );
    await waitFor(() => expect(screen.getByTestId("backlog-toast")).toBeTruthy());
    expect(screen.getByText("Aggiunta al backlog")).toBeTruthy();
    // La sheet si chiude dopo il successo.
    expect(screen.queryByTestId("capture-sheet-input")).toBeNull();
    // La lista invalidata rifà la query di lista almeno una seconda volta —
    // atteso fino a coda vuota per non lasciare un refetch in volo oltre la
    // fine del test (act() warning altrimenti, refetch che risolve dopo).
    await waitFor(() => expect(list.mock.calls.length).toBeGreaterThan(1));
    await waitFor(() => expect(screen.getByTestId("backlog-empty")).toBeTruthy());
  });
});
