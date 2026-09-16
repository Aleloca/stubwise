import { ApiError, type StubwiseClient } from "@stubwise/api-client";
import type { MailThreadDetail, Reader } from "@stubwise/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import { AuthContext } from "../../app/auth-context";
import type { AuthContextValue } from "../../app/providers";
import "../../i18n";
import { ThreadDetailScreen } from "./ThreadDetailScreen";

/**
 * Una CONVERSAZIONE letta per intero sull'app («la posta si legge per
 * conversazione» §4, Task 15).
 */
const AMMESSO = "11111111-1111-4111-8111-111111111111";
const CONTESTO = "22222222-2222-4222-8222-222222222222";
const PROPOSTA = "33333333-3333-4333-8333-333333333333";

function detail(overrides: Partial<Reader<MailThreadDetail>> = {}): Reader<MailThreadDetail> {
  return {
    threadId: "thread-1",
    accountId: "acc-1",
    accountEmail: "ops@example.com",
    subject: "Re: Reso ordine #123",
    url: "https://mail.google.com/x",
    messages: [
      {
        id: CONTESTO,
        from: "Cliente <cliente@example.com>",
        to: [],
        receivedAt: "2026-09-09T09:00:00.000Z",
        textExcerpt: "La PRIMA email della conversazione",
        admitted: false,
        proposalIds: [],
        // Un messaggio di CONTESTO non ha proposte, quindi non ha niente da
        // riproporre: non è «non ancora», è «mai».
        reproposals: [],
      },
      {
        id: AMMESSO,
        from: "Cliente <cliente@example.com>",
        to: [],
        receivedAt: "2026-09-11T09:00:00.000Z",
        textExcerpt: "L'ULTIMA email, con https://esempio.test dentro",
        admitted: true,
        proposalIds: [PROPOSTA],
        reproposals: [{ source: "email", id: PROPOSTA, projectName: "Apollo" }],
      },
    ],
    ...overrides,
  } as Reader<MailThreadDetail>;
}

function makeClient(thread?: jest.Mock, repropose?: jest.Mock): StubwiseClient {
  return {
    mail: {
      thread: thread ?? jest.fn().mockResolvedValue(detail()),
      repropose: repropose ?? jest.fn().mockResolvedValue({ ok: true }),
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
    loggedOut: jest.fn(),
  };
  await render(
    <QueryClientProvider client={queryClient}>
      <AuthContext.Provider value={authValue}>
        <ThreadDetailScreen
          navigation={{ goBack } as never}
          route={{ key: "ThreadDetail", name: "ThreadDetail", params: { threadId: "thread-1" } } as never}
        />
      </AuthContext.Provider>
    </QueryClientProvider>,
  );
  return { goBack };
}

describe("ThreadDetailScreen", () => {
  test("i messaggi in ORDINE, ciascuno col suo mittente e il suo corpo", async () => {
    await renderScreen(makeClient());
    await waitFor(() => expect(screen.getByTestId(`thread-message-${AMMESSO}`)).toBeTruthy());

    expect(screen.getByText("La PRIMA email della conversazione")).toBeTruthy();
    expect(screen.getByText(/L'ULTIMA email/)).toBeTruthy();
    expect(screen.getByText("2 messaggi · ops@example.com")).toBeTruthy();
  });

  test("un messaggio di CONTESTO si dichiara tale; uno ammesso no", async () => {
    // Non è uno che «non ha ancora» prodotto una proposta: è uno che non ne
    // produrrà mai, ed è una cosa diversa.
    await renderScreen(makeClient());
    await waitFor(() => expect(screen.getByTestId(`thread-message-${CONTESTO}`)).toBeTruthy());

    expect(screen.getByTestId(`thread-message-context-${CONTESTO}`)).toBeTruthy();
    expect(screen.queryByTestId(`thread-message-context-${AMMESSO}`)).toBeNull();
  });

  test("un messaggio senza estratto lo dichiara, invece di mostrare un vuoto", async () => {
    const thread = jest.fn().mockResolvedValue(
      detail({
        messages: [
          {
            id: AMMESSO,
            from: "cliente@example.com",
            to: [],
            receivedAt: "2026-09-11T09:00:00.000Z",
            textExcerpt: null,
            admitted: true,
            proposalIds: [],
            reproposals: [],
          },
        ],
      } as Partial<Reader<MailThreadDetail>>),
    );
    await renderScreen(makeClient(thread));
    await waitFor(() => expect(screen.getByTestId(`thread-message-${AMMESSO}`)).toBeTruthy());
    expect(screen.getByText(/Nessun estratto salvato/)).toBeTruthy();
  });

  test("caricamento: skeleton, non una conversazione vuota", async () => {
    await renderScreen(makeClient(jest.fn(() => new Promise(() => {}))));
    expect(screen.getByTestId("thread-detail-skeleton")).toBeTruthy();
  });

  test("404: l'errore si vede e non offre un Riprova che non servirebbe", async () => {
    const thread = jest.fn().mockRejectedValue(new ApiError(404, "gone", "not_found"));
    await renderScreen(makeClient(thread));
    await waitFor(() => expect(screen.getByTestId("thread-detail-error")).toBeTruthy());
    expect(screen.queryByTestId("thread-detail-retry")).toBeNull();
  });

  test("errore di rete: Riprova ricarica", async () => {
    const thread = jest
      .fn()
      .mockRejectedValueOnce(new Error("down"))
      .mockResolvedValueOnce(detail());
    await renderScreen(makeClient(thread));
    await waitFor(() => expect(screen.getByTestId("thread-detail-retry")).toBeTruthy());
    await fireEvent.press(screen.getByTestId("thread-detail-retry"));
    await waitFor(() => expect(screen.getByTestId(`thread-message-${AMMESSO}`)).toBeTruthy());
  });

  test("da una proposta fallita si riparte: «Riproponi» sul messaggio, non sul contesto", async () => {
    // Lo stato vero da cui si deve poter uscire. Senza questo bottone
    // l'unica via di recupero sarebbe una chiamata HTTP a mano.
    const repropose = jest.fn().mockResolvedValue({ ok: true });
    await renderScreen(makeClient(undefined, repropose));
    await waitFor(() => expect(screen.getByTestId(`thread-message-${AMMESSO}`)).toBeTruthy());

    // Sul messaggio di CONTESTO l'azione non c'è: proposte non ne ha.
    expect(screen.queryByTestId(`thread-repropose-${CONTESTO}`)).toBeNull();

    const button = screen.getByTestId(`thread-repropose-${PROPOSTA}`);
    await fireEvent.press(button);

    // La rotta chiamata è quella della PROPOSTA, con la sua sorgente.
    await waitFor(() => expect(repropose).toHaveBeenCalledWith("email", PROPOSTA));
  });

  test("il tasto indietro chiama goBack", async () => {
    const { goBack } = await renderScreen(makeClient());
    await waitFor(() => expect(screen.getByText("Re: Reso ordine #123")).toBeTruthy());
    await fireEvent.press(screen.getByTestId("screen-header-back"));
    expect(goBack).toHaveBeenCalled();
  });
});
