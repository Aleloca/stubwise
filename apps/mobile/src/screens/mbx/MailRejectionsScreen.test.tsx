import type { StubwiseClient } from "@stubwise/api-client";
import { UNKNOWN, type MailRejections, type Reader } from "@stubwise/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import { AuthContext } from "../../app/auth-context";
import type { AuthContextValue } from "../../app/providers";
import "../../i18n";
import { MailRejectionsScreen } from "./MailRejectionsScreen";

/**
 * LE MAIL TENUTE FUORI (25 set 2026, design §5): per casella e per motivo,
 * con una riga che spiega il motivo e i domini sotto. Le righe dei domini non
 * sono premibili: non c'è un dettaglio da aprire.
 */
const ACC_1 = "11111111-1111-4111-8111-111111111111";
const ACC_2 = "22222222-2222-4222-8222-222222222222";

function account(accountId: string, email: string, reasons: Reader<MailRejections>["accounts"][number]["reasons"]) {
  return { accountId, email, total: reasons.reduce((sum, r) => sum + r.count, 0), reasons };
}

function data(accounts: Reader<MailRejections>["accounts"]): Reader<MailRejections> {
  return { days: 7, total: accounts.reduce((sum, a) => sum + a.total, 0), accounts };
}

function makeClient(rejections: jest.Mock): StubwiseClient {
  return { mail: { rejections } } as unknown as StubwiseClient;
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
        <MailRejectionsScreen
          navigation={{ goBack } as never}
          route={{ key: "MailRejections", name: "MailRejections", params: undefined }}
        />
      </AuthContext.Provider>
    </QueryClientProvider>,
  );
  return { goBack };
}

describe("MailRejectionsScreen", () => {
  test("un gruppo per motivo, col conteggio, la spiegazione e i domini", async () => {
    const rejections = jest.fn().mockResolvedValue(
      data([
        account(ACC_1, "ops@example.com", [
          {
            reason: "automated",
            count: 12,
            domains: [
              { domain: "github.com", count: 9 },
              { domain: null, count: 1 },
            ],
            otherDomains: 2,
          },
          { reason: "no_match", count: 3, domains: [{ domain: "cliente.test", count: 3 }], otherDomains: 0 },
        ]),
      ]),
    );
    await renderScreen(makeClient(rejections));

    await waitFor(() => expect(screen.getByTestId("rejections-reason-automated")).toBeTruthy());
    expect(rejections).toHaveBeenCalledWith(7);
    expect(screen.getByText("Automatiche")).toBeTruthy();
    expect(screen.getByText("12 email")).toBeTruthy();
    expect(screen.getByText("Notifiche, newsletter e risposte automatiche.")).toBeTruthy();
    expect(screen.getByText("github.com")).toBeTruthy();
    expect(screen.getByText("9")).toBeTruthy();
    // Il mittente illeggibile si dichiara, non resta una riga vuota.
    expect(screen.getByText("mittente non leggibile")).toBeTruthy();
    expect(screen.getByText("+2 da altri domini")).toBeTruthy();

    expect(screen.getByTestId("rejections-reason-no_match")).toBeTruthy();
    expect(screen.getByText("Nessuna regola")).toBeTruthy();
    expect(screen.getByText("cliente.test")).toBeTruthy();
    // Nessun «+0»: senza altri domini la riga non c'è.
    expect(screen.queryByText("+0 da altri domini")).toBeNull();
  });

  test("un motivo che l'app non conosce si mostra come «Altro», senza spiegazione inventata", async () => {
    const rejections = jest.fn().mockResolvedValue(
      data([account(ACC_1, "ops@example.com", [{ reason: UNKNOWN, count: 4, domains: [], otherDomains: 0 }])]),
    );
    await renderScreen(makeClient(rejections));

    await waitFor(() => expect(screen.getByText("Altro")).toBeTruthy());
    expect(screen.getByText("4 email")).toBeTruthy();
    // Nessuna spiegazione, e soprattutto nessuna chiave di traduzione grezza.
    expect(screen.queryByText(/mobile\.mbx/)).toBeNull();
  });

  test("con UNA casella l'indirizzo non si ripete come intestazione", async () => {
    const rejections = jest.fn().mockResolvedValue(
      data([account(ACC_1, "ops@example.com", [{ reason: "automated", count: 1, domains: [], otherDomains: 0 }])]),
    );
    await renderScreen(makeClient(rejections));

    await waitFor(() => expect(screen.getByText("Automatiche")).toBeTruthy());
    expect(screen.queryByTestId(`rejections-account-${ACC_1}`)).toBeNull();
  });

  test("con più caselle ognuna ha la sua intestazione", async () => {
    const rejections = jest.fn().mockResolvedValue(
      data([
        account(ACC_1, "ops@example.com", [{ reason: "automated", count: 2, domains: [], otherDomains: 0 }]),
        account(ACC_2, "io@example.com", [{ reason: "denied_label", count: 1, domains: [], otherDomains: 0 }]),
      ]),
    );
    await renderScreen(makeClient(rejections));

    await waitFor(() => expect(screen.getByTestId(`rejections-account-${ACC_1}`)).toBeTruthy());
    expect(screen.getByTestId(`rejections-account-${ACC_2}`)).toBeTruthy();
    expect(screen.getByText("ops@example.com")).toBeTruthy();
    expect(screen.getByText("io@example.com")).toBeTruthy();
    expect(screen.getByText("Etichetta esclusa")).toBeTruthy();
  });

  test("nessuno scarto: lo stato vuoto si spiega", async () => {
    await renderScreen(makeClient(jest.fn().mockResolvedValue(data([]))));
    await waitFor(() => expect(screen.getByTestId("rejections-empty")).toBeTruthy());
    expect(screen.getByText("Nessuna email tenuta fuori")).toBeTruthy();
  });

  test("errore: si può riprovare", async () => {
    const rejections = jest
      .fn()
      .mockRejectedValueOnce(new Error("down"))
      .mockResolvedValueOnce(
        data([account(ACC_1, "ops@example.com", [{ reason: "automated", count: 1, domains: [], otherDomains: 0 }])]),
      );
    await renderScreen(makeClient(rejections));
    await waitFor(() => expect(screen.getByTestId("rejections-retry")).toBeTruthy());
    await fireEvent.press(screen.getByTestId("rejections-retry"));
    await waitFor(() => expect(screen.getByText("Automatiche")).toBeTruthy());
  });

  test("indietro torna alla Posta", async () => {
    const { goBack } = await renderScreen(makeClient(jest.fn().mockResolvedValue(data([]))));
    await waitFor(() => expect(screen.getByTestId("rejections-empty")).toBeTruthy());
    await fireEvent.press(screen.getByText("‹ Posta"));
    expect(goBack).toHaveBeenCalled();
  });
});
