import { ApiError, type StubwiseClient } from "@stubwise/api-client";
import type { MailPage, MailThreadItem, Reader } from "@stubwise/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import { AuthContext } from "../../app/auth-context";
import type { AuthContextValue } from "../../app/providers";
import "../../i18n";
import { MbxScreen } from "./MbxScreen";

/** Una pagina vuota per `mail.list`, che il client finto espone ancora. */
function page(items: never[] = []): Reader<MailPage> {
  return { items, nextCursor: null };
}

function makeClient(
  overrides: {
    list?: jest.Mock;
    repropose?: jest.Mock;
    range?: jest.Mock;
    threads?: jest.Mock;
    rejections?: jest.Mock;
  } = {},
): StubwiseClient {
  return {
    mail: {
      list: overrides.list ?? jest.fn().mockResolvedValue(page([])),
      threads: overrides.threads ?? jest.fn().mockResolvedValue({ items: [], nextCursor: null }),
      thread: jest.fn(),
      summary: jest.fn(),
      // Nessuno scarto di default: la riga «tenute fuori» non compare, e i
      // test che non la riguardano vedono la schermata di sempre.
      rejections: overrides.rejections ?? jest.fn().mockResolvedValue({ days: 7, total: 0, accounts: [] }),
      get: jest.fn(),
      original: jest.fn(),
      repropose: overrides.repropose ?? jest.fn().mockResolvedValue({ ok: true }),
    },
    calendar: {
      list: jest.fn(),
      range: overrides.range ?? jest.fn().mockResolvedValue({ items: [], nextCursor: null }),
      series: jest.fn().mockResolvedValue({ items: [] }),
      putSeries: jest.fn(),
      deleteSeries: jest.fn(),
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
    openSettings: jest.fn(),
    loggedOut: jest.fn(),
  };
  const navigation = { navigate } as never;
  await render(
    <QueryClientProvider client={queryClient}>
      <AuthContext.Provider value={authValue}>
        <MbxScreen navigation={navigation} route={{ key: "List", name: "List", params: undefined }} />
      </AuthContext.Provider>
    </QueryClientProvider>,
  );
  return { navigate };
}

describe("MbxScreen — lo scambio Posta/Calendario", () => {
  test("nasce su Posta: lo switch mostra due opzioni, 'Posta' selezionata", async () => {
    await renderScreen(makeClient());
    await waitFor(() => expect(screen.getByTestId("mbx-mail-empty")).toBeTruthy());
    expect(screen.getByTestId("mbx-switch")).toBeTruthy();
    expect(screen.queryByTestId("mbx-calendar-placeholder")).toBeNull();
  });

  test("passando a Calendario si vede la GRIGLIA (Fase D), non più il segnaposto", async () => {
    await renderScreen(makeClient());
    await waitFor(() => expect(screen.getByTestId("mbx-mail-empty")).toBeTruthy());
    await fireEvent.press(screen.getByTestId("mbx-tab-calendar"));
    await waitFor(() => expect(screen.getByTestId("calendar-panel")).toBeTruthy());
    expect(screen.queryByTestId("mbx-calendar-placeholder")).toBeNull();
    expect(screen.queryByTestId("mbx-mail-empty")).toBeNull();
  });
});

/**
 * ⚠️ La lista della scheda MBX mostra CONVERSAZIONI da «la posta si legge per
 * conversazione» §4, non più messaggi: i test di prima esercitavano le righe
 * per messaggio (`mbx-mail-row-*`, «Riproponi», la disambiguazione
 * email/email_triage/calendar) ed è cambiato il comportamento, non il modo di
 * verificarlo. La disambiguazione per source resta provata dove vive ora
 * (`mail-mutations`, e il dettaglio di un messaggio raggiunto da un deep
 * link); «Riproponi» resta sulla card d'inbox e sulla pagina Posta del sito,
 * dove agisce su UN messaggio — cosa che una conversazione non è.
 */
describe("MbxScreen — la lista per conversazione", () => {
  function thread(overrides: Partial<Reader<MailThreadItem>> = {}): Reader<MailThreadItem> {
    return {
      threadId: "thread-1",
      accountId: "acc-1",
      accountEmail: "ops@example.com",
      subject: "Re: Reso ordine #123",
      lastFrom: "cliente@example.com",
      lastReceivedAt: "2026-09-11T09:00:00.000Z",
      messageCount: 3,
      openProposals: 1,
      projectNames: ["negozio-web"],
      ...overrides,
    } as Reader<MailThreadItem>;
  }

  test("caricamento: skeleton", async () => {
    const client = makeClient({ threads: jest.fn(() => new Promise(() => {})) });
    await renderScreen(client);
    expect(screen.getByTestId("mbx-mail-skeleton")).toBeTruthy();
  });

  test("errore di caricamento: Riprova ricarica", async () => {
    const threads = jest
      .fn()
      .mockRejectedValueOnce(new Error("down"))
      .mockResolvedValueOnce({ items: [thread()], nextCursor: null });
    await renderScreen(makeClient({ threads }));
    await waitFor(() => expect(screen.getByTestId("mbx-mail-retry")).toBeTruthy());
    await fireEvent.press(screen.getByTestId("mbx-mail-retry"));
    await waitFor(() => expect(screen.getByText("Re: Reso ordine #123")).toBeTruthy());
  });

  test("vuota: lo stato si spiega da solo", async () => {
    await renderScreen(makeClient());
    await waitFor(() => expect(screen.getByTestId("mbx-mail-empty")).toBeTruthy());
    expect(screen.getByText("Nessuna conversazione qui")).toBeTruthy();
  });

  test("una riga mostra ultimo mittente, oggetto, quanti messaggi e quante proposte aperte", async () => {
    const client = makeClient({ threads: jest.fn().mockResolvedValue({ items: [thread()], nextCursor: null }) });
    await renderScreen(client);
    await waitFor(() => expect(screen.getByTestId("mbx-thread-row-thread-1")).toBeTruthy());

    expect(screen.getByText("cliente@example.com")).toBeTruthy();
    expect(screen.getByText("Re: Reso ordine #123")).toBeTruthy();
    expect(screen.getByText("3 messaggi")).toBeTruthy();
    expect(screen.getByText("1 proposta aperta")).toBeTruthy();
    expect(screen.getByText("negozio-web")).toBeTruthy();
  });

  test("una conversazione di UN messaggio non dice «1 messaggio»: sarebbe rumore", async () => {
    const client = makeClient({
      threads: jest.fn().mockResolvedValue({
        items: [thread({ messageCount: 1, openProposals: 0, projectNames: [] })],
        nextCursor: null,
      }),
    });
    await renderScreen(client);
    await waitFor(() => expect(screen.getByTestId("mbx-thread-row-thread-1")).toBeTruthy());
    expect(screen.queryByText("1 messaggio")).toBeNull();
  });

  test("un tap apre la CONVERSAZIONE, non un messaggio", async () => {
    const client = makeClient({ threads: jest.fn().mockResolvedValue({ items: [thread()], nextCursor: null }) });
    const { navigate } = await renderScreen(client);
    await waitFor(() => expect(screen.getByTestId("mbx-thread-row-thread-1")).toBeTruthy());
    await fireEvent.press(screen.getByTestId("mbx-thread-row-thread-1"));
    expect(navigate).toHaveBeenCalledWith("ThreadDetail", { threadId: "thread-1" });
  });
});

/**
 * LE MAIL TENUTE FUORI (25 set 2026): una riga in fondo alla Posta, che porta
 * alla schermata dei motivi. È una lettura ACCESSORIA: se fallisce o non c'è
 * niente da dire, la riga non compare e la lista resta intera.
 */
describe("MbxScreen — la riga delle mail tenute fuori", () => {
  function rejections(total: number) {
    return jest.fn().mockResolvedValue({
      days: 7,
      total,
      accounts:
        total === 0
          ? []
          : [
              {
                accountId: "acc-1",
                email: "ops@example.com",
                total,
                reasons: [{ reason: "automated", count: total, domains: [], otherDomains: 0 }],
              },
            ],
    });
  }

  const oneThread = {
    items: [
      {
        threadId: "thread-1",
        accountId: "acc-1",
        accountEmail: "ops@example.com",
        subject: "Re: Reso ordine #123",
        lastFrom: "cliente@example.com",
        lastReceivedAt: "2026-09-11T09:00:00.000Z",
        messageCount: 1,
        openProposals: 0,
        projectNames: [],
      },
    ],
    nextCursor: null,
  };

  test("sotto la lista, col totale e il periodo, e chiede 7 giorni", async () => {
    const reject = rejections(335);
    await renderScreen(makeClient({ threads: jest.fn().mockResolvedValue(oneThread), rejections: reject }));
    await waitFor(() => expect(screen.getByTestId("mbx-rejections-row")).toBeTruthy());
    expect(screen.getByText("335 email tenute fuori negli ultimi 7 giorni")).toBeTruthy();
    expect(screen.getByTestId("mbx-thread-row-thread-1")).toBeTruthy();
    expect(reject).toHaveBeenCalledWith(7);
  });

  test("anche quando la lista è VUOTA: è proprio lì che serve", async () => {
    await renderScreen(makeClient({ rejections: rejections(3) }));
    await waitFor(() => expect(screen.getByTestId("mbx-rejections-row")).toBeTruthy());
    expect(screen.getByTestId("mbx-mail-empty")).toBeTruthy();
  });

  test("totale zero: la riga non compare", async () => {
    const reject = rejections(0);
    await renderScreen(makeClient({ threads: jest.fn().mockResolvedValue(oneThread), rejections: reject }));
    await waitFor(() => expect(screen.getByTestId("mbx-thread-row-thread-1")).toBeTruthy());
    await waitFor(() => expect(reject).toHaveBeenCalled());
    expect(screen.queryByTestId("mbx-rejections-row")).toBeNull();
  });

  test("server vecchio (404): la riga non compare e la lista resta", async () => {
    const reject = jest.fn().mockRejectedValue(new ApiError(404, "Not found", "not_found"));
    await renderScreen(makeClient({ threads: jest.fn().mockResolvedValue(oneThread), rejections: reject }));
    await waitFor(() => expect(screen.getByTestId("mbx-thread-row-thread-1")).toBeTruthy());
    await waitFor(() => expect(reject).toHaveBeenCalled());
    expect(screen.queryByTestId("mbx-rejections-row")).toBeNull();
    expect(screen.queryByTestId("mbx-mail-error")).toBeNull();
  });

  test("nel Calendario non c'è: riguarda la posta", async () => {
    await renderScreen(makeClient({ rejections: rejections(3) }));
    await waitFor(() => expect(screen.getByTestId("mbx-rejections-row")).toBeTruthy());
    await fireEvent.press(screen.getByTestId("mbx-tab-calendar"));
    await waitFor(() => expect(screen.getByTestId("calendar-panel")).toBeTruthy());
    expect(screen.queryByTestId("mbx-rejections-row")).toBeNull();
  });

  test("un tap apre la schermata delle tenute fuori", async () => {
    const { navigate } = await renderScreen(makeClient({ rejections: rejections(3) }));
    await waitFor(() => expect(screen.getByTestId("mbx-rejections-row")).toBeTruthy());
    await fireEvent.press(screen.getByTestId("mbx-rejections-row"));
    expect(navigate).toHaveBeenCalledWith("MailRejections");
  });
});
