import type { StubwiseClient } from "@stubwise/api-client";
import { ApiError } from "@stubwise/api-client";
import type { MailDetail, MailOriginal, Reader } from "@stubwise/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import { Linking } from "react-native";
import { AuthContext } from "../../app/auth-context";
import type { AuthContextValue } from "../../app/providers";
import "../../i18n";
import { MailDetailScreen } from "./MailDetailScreen";

const ID = "22222222-2222-4222-8222-222222222222";

function detail(overrides: Partial<Reader<MailDetail>> = {}): Reader<MailDetail> {
  return {
    id: ID,
    source: "email",
    accountId: "acc-1",
    accountEmail: "ops@example.com",
    from: "Cliente <cliente@example.com>",
    to: ["ops@example.com"],
    subject: "Reso ordine #123",
    receivedAt: "2026-09-11T09:00:00.000Z",
    labels: [],
    textExcerpt: "Vorrei restituire l'articolo, è arrivato rotto.",
    url: "https://mail.google.com/mail/u/0/#inbox/thread-1",
    ...overrides,
  } as Reader<MailDetail>;
}

function original(overrides: Partial<Reader<MailOriginal>> = {}): Reader<MailOriginal> {
  return {
    subject: "Reso ordine #123",
    from: "cliente@example.com",
    to: ["ops@example.com"],
    cc: [],
    bodyText: "Vorrei restituire l'articolo, è arrivato rotto.",
    bodyHtml: null,
    attachments: [],
    ...overrides,
  } as Reader<MailOriginal>;
}

function makeClient(overrides: { get?: jest.Mock; original?: jest.Mock } = {}): StubwiseClient {
  return {
    mail: {
      list: jest.fn(),
      summary: jest.fn(),
      get: overrides.get ?? jest.fn().mockResolvedValue(detail()),
      original: overrides.original ?? jest.fn().mockResolvedValue(original()),
      repropose: jest.fn(),
    },
  } as unknown as StubwiseClient;
}

async function renderScreen(client: StubwiseClient, source: "email" | "email_triage" = "email") {
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
  };
  const navigation = { goBack } as never;
  await render(
    <QueryClientProvider client={queryClient}>
      <AuthContext.Provider value={authValue}>
        <MailDetailScreen navigation={navigation} route={{ key: "MailDetail", name: "MailDetail", params: { source, id: ID } }} />
      </AuthContext.Provider>
    </QueryClientProvider>,
  );
  return { goBack };
}

describe("MailDetailScreen — caricamento ed errori", () => {
  test("caricamento: skeleton", async () => {
    const client = makeClient({ get: jest.fn(() => new Promise(() => {})) });
    await renderScreen(client);
    expect(screen.getByTestId("mail-detail-skeleton")).toBeTruthy();
  });

  test("404: stato 'non c'è più'", async () => {
    const client = makeClient({ get: jest.fn().mockRejectedValue(new ApiError(404, "Not found", "not_found")) });
    await renderScreen(client);
    await waitFor(() => expect(screen.getByTestId("mail-detail-not-found")).toBeTruthy());
  });

  test("errore di rete: Riprova ricarica", async () => {
    const get = jest.fn().mockRejectedValueOnce(new Error("down")).mockResolvedValueOnce(detail());
    await renderScreen(makeClient({ get }));
    await waitFor(() => expect(screen.getByTestId("mail-detail-retry")).toBeTruthy());
    await fireEvent.press(screen.getByTestId("mail-detail-retry"));
    await waitFor(() => expect(screen.getByText("Reso ordine #123")).toBeTruthy());
  });

  test("il tasto indietro chiama goBack", async () => {
    const { goBack } = await renderScreen(makeClient());
    await waitFor(() => expect(screen.getByText("Reso ordine #123")).toBeTruthy());
    await fireEvent.press(screen.getByTestId("mail-detail-back"));
    expect(goBack).toHaveBeenCalled();
  });
});

describe("MailDetailScreen — l'estratto è testo, mai markdown", () => {
  test("estratto presente: dichiara di essere un estratto, e si vede il testo esatto", async () => {
    await renderScreen(makeClient());
    await waitFor(() => expect(screen.getByText("Vorrei restituire l'articolo, è arrivato rotto.")).toBeTruthy());
    expect(screen.getByText(/Solo un estratto/)).toBeTruthy();
  });

  test("estratto ASSENTE (messaggio anteriore alla fase 6): lo dichiara, non mostra un campo vuoto", async () => {
    const client = makeClient({ get: jest.fn().mockResolvedValue(detail({ textExcerpt: null })) });
    await renderScreen(client);
    await waitFor(() => expect(screen.getByText(/Nessun estratto salvato/)).toBeTruthy());
    expect(screen.queryByText(/Solo un estratto/)).toBeNull();
  });

  test("apri su Gmail: apre l'URL del thread", async () => {
    const openURL = jest.spyOn(Linking, "openURL").mockResolvedValue(undefined);
    await renderScreen(makeClient());
    await waitFor(() => expect(screen.getByTestId("mail-detail-open-gmail")).toBeTruthy());
    await fireEvent.press(screen.getByTestId("mail-detail-open-gmail"));
    expect(openURL).toHaveBeenCalledWith("https://mail.google.com/mail/u/0/#inbox/thread-1");
  });
});

describe("MailDetailScreen — l'originale (rilettura da Gmail, su richiesta)", () => {
  test("la nota sta accanto al bottone PRIMA del tap, non solo durante l'attesa", async () => {
    await renderScreen(makeClient());
    await waitFor(() => expect(screen.getByTestId("mail-detail-show-original")).toBeTruthy());
    expect(screen.getByText(/Chiede il messaggio a Google adesso/)).toBeTruthy();
  });

  test("successo: mostra il corpo dell'originale", async () => {
    await renderScreen(makeClient());
    await waitFor(() => expect(screen.getByTestId("mail-detail-show-original")).toBeTruthy());
    await fireEvent.press(screen.getByTestId("mail-detail-show-original"));
    await waitFor(() => expect(screen.getByTestId("mail-detail-original-body")).toBeTruthy());
  });

  test("409 message_gone: il messaggio non esiste più su Gmail — l'estratto resta leggibile", async () => {
    const original = jest.fn().mockRejectedValue(new ApiError(409, "gone", "message_gone"));
    await renderScreen(makeClient({ original }));
    await waitFor(() => expect(screen.getByTestId("mail-detail-show-original")).toBeTruthy());
    await fireEvent.press(screen.getByTestId("mail-detail-show-original"));
    await waitFor(() => expect(screen.getByTestId("mail-detail-original-error")).toBeTruthy());
    expect(screen.getByText("Questo messaggio non esiste più su Gmail.")).toBeTruthy();
    // L'estratto, mostrato PRIMA di chiedere l'originale, resta visibile:
    // l'errore è un supplemento, mai una sostituzione della card.
    expect(screen.getByText("Vorrei restituire l'articolo, è arrivato rotto.")).toBeTruthy();
  });

  test("409 token_expired: la casella va ricollegata", async () => {
    const original = jest.fn().mockRejectedValue(new ApiError(409, "expired", "token_expired"));
    await renderScreen(makeClient({ original }));
    await waitFor(() => expect(screen.getByTestId("mail-detail-show-original")).toBeTruthy());
    await fireEvent.press(screen.getByTestId("mail-detail-show-original"));
    await waitFor(() => expect(screen.getByText("La casella va ricollegata per rileggere l'originale.")).toBeTruthy());
  });

  test("502 google_unavailable: Google non risponde", async () => {
    const original = jest.fn().mockRejectedValue(new ApiError(502, "down", "google_unavailable"));
    await renderScreen(makeClient({ original }));
    await waitFor(() => expect(screen.getByTestId("mail-detail-show-original")).toBeTruthy());
    await fireEvent.press(screen.getByTestId("mail-detail-show-original"));
    await waitFor(() => expect(screen.getByText("Google non risponde in questo momento. Riprova.")).toBeTruthy());
  });
});
