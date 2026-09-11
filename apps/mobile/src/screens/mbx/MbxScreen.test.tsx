import type { StubwiseClient } from "@stubwise/api-client";
import type { MailItem, MailPage, Reader } from "@stubwise/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import { AuthContext } from "../../app/auth-context";
import type { AuthContextValue } from "../../app/providers";
import "../../i18n";
import { MbxScreen } from "./MbxScreen";

const ID = "11111111-1111-4111-8111-111111111111";

function mailItem(overrides: Partial<Reader<MailItem>> = {}): Reader<MailItem> {
  return {
    id: ID,
    source: "email",
    kind: "proposal",
    accountId: "acc-1",
    accountEmail: "ops@example.com",
    projectId: "proj-1",
    projectName: "negozio-web",
    title: "Reso ordine #123",
    from: "Cliente <cliente@example.com>",
    date: "2026-09-11T09:00:00.000Z",
    status: "proposed",
    signal: "request",
    outcome: null,
    error: null,
    url: "https://mail.google.com/x",
    reproposable: false,
    ...overrides,
  } as Reader<MailItem>;
}

function page(items: Reader<MailItem>[]): Reader<MailPage> {
  return { items, nextCursor: null };
}

function makeClient(overrides: { list?: jest.Mock; repropose?: jest.Mock } = {}): StubwiseClient {
  return {
    mail: {
      list: overrides.list ?? jest.fn().mockResolvedValue(page([])),
      summary: jest.fn(),
      get: jest.fn(),
      original: jest.fn(),
      repropose: overrides.repropose ?? jest.fn().mockResolvedValue({ ok: true }),
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

  test("passando a Calendario si vede il segnaposto, non un errore o una griglia mancante", async () => {
    await renderScreen(makeClient());
    await waitFor(() => expect(screen.getByTestId("mbx-mail-empty")).toBeTruthy());
    await fireEvent.press(screen.getByTestId("mbx-tab-calendar"));
    expect(screen.getByTestId("mbx-calendar-placeholder")).toBeTruthy();
    expect(screen.queryByTestId("mbx-mail-empty")).toBeNull();
  });
});

describe("MbxScreen — lista", () => {
  test("caricamento: skeleton", async () => {
    const client = makeClient({ list: jest.fn(() => new Promise(() => {})) });
    await renderScreen(client);
    expect(screen.getByTestId("mbx-mail-skeleton")).toBeTruthy();
  });

  test("errore di caricamento: Riprova ricarica", async () => {
    const list = jest.fn().mockRejectedValueOnce(new Error("down")).mockResolvedValueOnce(page([mailItem()]));
    await renderScreen(makeClient({ list }));
    await waitFor(() => expect(screen.getByTestId("mbx-mail-retry")).toBeTruthy());
    await fireEvent.press(screen.getByTestId("mbx-mail-retry"));
    await waitFor(() => expect(screen.getByText("Reso ordine #123")).toBeTruthy());
  });

  test("vuota: lo stato si spiega da solo", async () => {
    await renderScreen(makeClient());
    await waitFor(() => expect(screen.getByTestId("mbx-mail-empty")).toBeTruthy());
    expect(screen.getByText("Nessuna posta qui")).toBeTruthy();
  });

  test("riga email: un tap naviga al dettaglio con source 'email'", async () => {
    const client = makeClient({ list: jest.fn().mockResolvedValue(page([mailItem()])) });
    const { navigate } = await renderScreen(client);
    await waitFor(() => expect(screen.getByTestId(`mbx-mail-row-${ID}`)).toBeTruthy());
    await fireEvent.press(screen.getByTestId(`mbx-mail-row-${ID}`));
    expect(navigate).toHaveBeenCalledWith("MailDetail", { source: "email", id: ID });
  });

  test("riga di SMISTAMENTO (kind: triage): un tap naviga con source 'email_triage'", async () => {
    const client = makeClient({ list: jest.fn().mockResolvedValue(page([mailItem({ kind: "triage", projectName: null })])) });
    const { navigate } = await renderScreen(client);
    await waitFor(() => expect(screen.getByTestId(`mbx-mail-row-${ID}`)).toBeTruthy());
    await fireEvent.press(screen.getByTestId(`mbx-mail-row-${ID}`));
    expect(navigate).toHaveBeenCalledWith("MailDetail", { source: "email_triage", id: ID });
  });

  test("riga di CALENDARIO: nessun dettaglio da raggiungere, il tap non naviga", async () => {
    const client = makeClient({
      list: jest.fn().mockResolvedValue(page([mailItem({ source: "calendar", kind: "calendar", projectName: null })])),
    });
    const { navigate } = await renderScreen(client);
    await waitFor(() => expect(screen.getByTestId(`mbx-mail-row-${ID}`)).toBeTruthy());
    await fireEvent.press(screen.getByTestId(`mbx-mail-row-${ID}`));
    expect(navigate).not.toHaveBeenCalled();
  });

  test("riga riproponibile: il bottone Riproponi chiama repropose col source giusto", async () => {
    const repropose = jest.fn().mockResolvedValue({ ok: true });
    const client = makeClient({
      list: jest.fn().mockResolvedValue(page([mailItem({ status: "failed", reproposable: true })])),
      repropose,
    });
    await renderScreen(client);
    await waitFor(() => expect(screen.getByTestId(`mbx-mail-repropose-${ID}`)).toBeTruthy());
    await fireEvent.press(screen.getByTestId(`mbx-mail-repropose-${ID}`));
    await waitFor(() => expect(repropose).toHaveBeenCalledWith("email", ID));
  });

  test("riga NON riproponibile: nessun bottone Riproponi", async () => {
    const client = makeClient({ list: jest.fn().mockResolvedValue(page([mailItem({ reproposable: false })])) });
    await renderScreen(client);
    await waitFor(() => expect(screen.getByTestId(`mbx-mail-row-${ID}`)).toBeTruthy());
    expect(screen.queryByTestId(`mbx-mail-repropose-${ID}`)).toBeNull();
  });
});
