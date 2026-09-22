import type { StubwiseClient } from "@stubwise/api-client";
import type { InboxItem, Reader } from "@stubwise/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import { AuthContext } from "../../app/auth-context";
import type { AuthContextValue } from "../../app/providers";
import "../../i18n";
import { ProjectInboxScreen } from "./ProjectInboxScreen";

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";

function item(overrides: Partial<Reader<InboxItem>> & Pick<InboxItem, "id" | "kind">): Reader<InboxItem> {
  return {
    status: "open",
    text: "Testo dell'evento",
    actions: [],
    projectId: PROJECT_ID,
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

function makeClient(list?: jest.Mock): StubwiseClient {
  return {
    inbox: {
      list:
        list ??
        jest.fn().mockResolvedValue({
          items: [item({ id: "n1", kind: "review.completed", text: "Review finita su PR #12", actions: ["handled"] })],
          nextCursor: null,
          total: 1,
        }),
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
        <ProjectInboxScreen
          navigation={navigation}
          route={{
            key: "ProjectInbox",
            name: "ProjectInbox",
            params: { projectId: PROJECT_ID, projectName: "Portale B2B" },
          }}
        />
      </AuthContext.Provider>
    </QueryClientProvider>,
  );
  return { navigate, goBack };
}

beforeEach(() => jest.clearAllMocks());

describe("ProjectInboxScreen", () => {
  /**
   * ⚠️ La lista non è riscritta: monta `InboxCard`, lo stesso componente del
   * tab INB — che era già un componente a sé, quindi qui non c'è stato niente
   * da estrarre.
   */
  test("monta la card del tab INB, non una copia", async () => {
    await renderScreen(makeClient());
    await waitFor(() => expect(screen.getByText("Review finita su PR #12")).toBeTruthy());
  });

  /**
   * ⚠️ L'inbox è PER UTENTE: il filtro di progetto non allarga niente. Questa
   * asserzione fissa che la chiamata porta il progetto e nient'altro — nessun
   * parametro che possa suggerire «anche quelle degli altri».
   */
  test("chiede le notifiche del VIEWER su questo progetto", async () => {
    const list = jest.fn().mockResolvedValue({ items: [], nextCursor: null, total: 0 });
    await renderScreen(makeClient(list));
    await waitFor(() => expect(list).toHaveBeenCalled());
    expect(list).toHaveBeenCalledWith({ projectId: PROJECT_ID });
  });

  /**
   * Una proposta Google si DECIDE nella sua pagina, che vive solo
   * nell'`InboxStack` — quindi il tap sposta la scheda su INB. Vedi
   * `navigateToInboxProposal`: l'alternativa era una card di proposta senza
   * il bottone che la decide.
   */
  test("una proposta Google porta alla pagina della decisione", async () => {
    const navigate = jest.fn();
    const list = jest.fn().mockResolvedValue({
      items: [
        item({
          id: "g1",
          kind: "google.proposal",
          text: "Proposta dalla posta",
          actions: ["answer"],
          google: {
            source: "email",
            from: "cliente@acme.test",
            subject: "Serve l'export CSV",
            signal: "request",
            actions: [{ type: "create_backlog_item" }],
            auto: false,
            sourceProposalId: null,
          },
        }),
      ],
      nextCursor: null,
      total: 1,
    });
    await renderScreen(makeClient(list), navigate);
    await waitFor(() => expect(screen.getByTestId("google-proposal-card")).toBeTruthy());
    await fireEvent.press(screen.getByTestId("inbox-decide-g1"));
    expect(navigate).toHaveBeenCalledWith("Main", {
      screen: "Inbox",
      params: { screen: "Proposal", params: { id: "g1" } },
    });
  });

  test("l'indietro torna all'hub", async () => {
    const goBack = jest.fn();
    await renderScreen(makeClient(), jest.fn(), goBack);
    await waitFor(() => expect(screen.getByText("Review finita su PR #12")).toBeTruthy());
    await fireEvent.press(screen.getByTestId("screen-header-back"));
    expect(goBack).toHaveBeenCalled();
  });

  test("niente da gestire: lo stato vuoto, non un errore", async () => {
    await renderScreen(makeClient(jest.fn().mockResolvedValue({ items: [], nextCursor: null, total: 0 })));
    await waitFor(() => expect(screen.getByTestId("project-inbox-empty")).toBeTruthy());
  });

  test("errore: un messaggio con Riprova, che ricarica", async () => {
    const list = jest
      .fn()
      .mockRejectedValueOnce(new Error("down"))
      .mockResolvedValueOnce({
        items: [item({ id: "n1", kind: "review.completed", text: "Review finita su PR #12", actions: ["handled"] })],
        nextCursor: null,
        total: 1,
      });
    await renderScreen(makeClient(list));
    await waitFor(() => expect(screen.getByTestId("project-inbox-error")).toBeTruthy());
    await fireEvent.press(screen.getByTestId("project-inbox-retry"));
    await waitFor(() => expect(screen.getByText("Review finita su PR #12")).toBeTruthy());
  });

  /** ⚠️ Fixture lasciata SENZA `total` apposta (CLAUDE.md): qui non si usa. */
  test("SERVER PIÙ VECCHIO: senza `total` l'elenco si vede lo stesso", async () => {
    await renderScreen(
      makeClient(
        jest.fn().mockResolvedValue({
          items: [item({ id: "n1", kind: "review.completed", text: "Review finita su PR #12", actions: ["handled"] })],
          nextCursor: null,
        }),
      ),
    );
    await waitFor(() => expect(screen.getByText("Review finita su PR #12")).toBeTruthy());
  });
});
