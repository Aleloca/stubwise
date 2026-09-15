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
    bodySource: "google",
    fetchedAt: new Date().toISOString(),
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

  test("l'oggetto sta nell'header, insieme all'avatar e all'indietro", async () => {
    // Prima l'oggetto stava nel corpo che scorre: bastavano due dita di
    // scorrimento per perdere di vista di cosa si stesse leggendo.
    await renderScreen(makeClient());
    // ⚠️ Si aspetta il TESTO, non `screen-header-back`: l'header esiste fin
    // dal primo render (con «(nessun oggetto)» come titolo), il subject
    // arriva solo quando la query si risolve. Aspettando l'header il test
    // guardava un istante in cui l'oggetto non c'era ancora — falliva sul
    // branch base, prima di questo lavoro, e non per il codice che dichiara
    // di verificare. Il test qui sotto («il tasto indietro chiama goBack»)
    // aspettava già la cosa giusta, ed è per quello che passava.
    await waitFor(() => expect(screen.getByText("Reso ordine #123")).toBeTruthy());
    expect(screen.getByTestId("screen-header-back")).toBeTruthy();
    expect(screen.getByTestId("settings-avatar-button")).toBeTruthy();
  });

  test("il tasto indietro chiama goBack", async () => {
    const { goBack } = await renderScreen(makeClient());
    await waitFor(() => expect(screen.getByText("Reso ordine #123")).toBeTruthy());
    await fireEvent.press(screen.getByTestId("screen-header-back"));
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

  test("nessun bottone «Apri su Gmail»: si legge qui", async () => {
    // Rimosso il 13 set 2026 su richiesta del maintainer. Il test resta, al
    // negativo: chi lo rimettesse lo farebbe di proposito, non per inerzia.
    await renderScreen(makeClient());
    await waitFor(() => expect(screen.getByTestId("mail-detail-show-original")).toBeTruthy());
    expect(screen.queryByTestId("mail-detail-open-gmail")).toBeNull();
  });

  test("i link dell'estratto si aprono, gli asterischi restano letterali", async () => {
    const openURL = jest.spyOn(Linking, "openURL").mockResolvedValue(undefined);
    const client = makeClient({
      get: jest.fn().mockResolvedValue(detail({ textExcerpt: "Il **modulo** sta su https://esempio.it/modulo." })),
    });
    await renderScreen(client);
    const link = await waitFor(() => screen.getByText("https://esempio.it/modulo"));
    await fireEvent.press(link);
    // Il punto che chiude la frase non entra nell'indirizzo.
    expect(openURL).toHaveBeenCalledWith("https://esempio.it/modulo");
    // E il grassetto di markdown non e' mai stato interpretato.
    expect(screen.getByText(/\*\*modulo\*\*/)).toBeTruthy();
  });

  test("uno schema ostile nel corpo non diventa un link", async () => {
    // `mockClear`: la spia e' sullo STESSO `Linking.openURL` del test qui
    // sopra, che l'ha gia' chiamata. Senza azzerarla questo test passerebbe
    // da solo e fallirebbe in gruppo — che e' il modo peggiore di fallire.
    const openURL = jest.spyOn(Linking, "openURL").mockResolvedValue(undefined);
    openURL.mockClear();
    const client = makeClient({
      get: jest.fn().mockResolvedValue(detail({ textExcerpt: "Clicca javascript:alert(1) subito" })),
    });
    await renderScreen(client);
    const testo = await waitFor(() => screen.getByText(/javascript:alert\(1\)/));
    await fireEvent.press(testo);
    expect(openURL).not.toHaveBeenCalled();
  });
});

describe("MailDetailScreen — l'originale (rilettura da Gmail, su richiesta)", () => {
  test("la nota sta accanto al bottone PRIMA del tap, non solo durante l'attesa", async () => {
    await renderScreen(makeClient());
    await waitFor(() => expect(screen.getByTestId("mail-detail-show-original")).toBeTruthy());
    // ⚠️ La frase è CAMBIATA con la cache (migrazione 0076), non aggiornata
    // per farla passare: quella di prima prometteva che il messaggio veniva
    // chiesto a Google *adesso* e che non si salvava nulla — due cose che
    // una risposta dalla cache rende false. Prima del tap la provenienza non
    // si sa, quindi qui si dice solo ciò che vale in entrambi i casi.
    expect(screen.getByText(/Il messaggio completo, com'è arrivato/)).toBeTruthy();
    expect(screen.queryByText(/Chiede il messaggio a Google adesso/)).toBeNull();
  });

  test("dopo il tap la nota che IPOTIZZA sparisce: resta una frase sola su Google", async () => {
    // Due frasi nello stesso riquadro — una che dice cosa succederà, una che
    // dice cos'è successo — si leggono come contraddittorie: è il difetto
    // che il maintainer ha visto per primo sul telefono.
    await renderScreen(makeClient());
    await waitFor(() => expect(screen.getByTestId("mail-detail-show-original")).toBeTruthy());
    expect(screen.getByText(/Il messaggio completo, com'è arrivato/)).toBeTruthy();

    await fireEvent.press(screen.getByTestId("mail-detail-show-original"));
    await waitFor(() => expect(screen.getByTestId("mail-detail-original-source")).toBeTruthy());

    expect(screen.queryByText(/Il messaggio completo, com'è arrivato/)).toBeNull();
  });

  test("servito dalla CACHE: dopo il tap la provenienza è dichiarata, senza promettere Google", async () => {
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
    const originalFn = jest
      .fn()
      .mockResolvedValue(original({ bodySource: "cache", fetchedAt: twoDaysAgo }));
    await renderScreen(makeClient({ original: originalFn }));
    await waitFor(() => expect(screen.getByTestId("mail-detail-show-original")).toBeTruthy());
    await fireEvent.press(screen.getByTestId("mail-detail-show-original"));

    await waitFor(() => expect(screen.getByTestId("mail-detail-original-source")).toBeTruthy());
    expect(screen.getByText(/Copia salvata da Stubwise, letta da Google 2 g fa/)).toBeTruthy();
    expect(screen.queryByText("Chiesto a Google adesso.")).toBeNull();
  });

  test("letto da Google adesso: lo dichiara altrettanto esplicitamente", async () => {
    await renderScreen(makeClient());
    await waitFor(() => expect(screen.getByTestId("mail-detail-show-original")).toBeTruthy());
    await fireEvent.press(screen.getByTestId("mail-detail-show-original"));

    await waitFor(() => expect(screen.getByTestId("mail-detail-original-source")).toBeTruthy());
    expect(screen.getByText("Chiesto a Google adesso.")).toBeTruthy();
  });

  test("un server pre-0076 (nessun fetchedAt) non inventa «adesso»", async () => {
    // `bodySource` ha il default `google`, ma `fetchedAt` può mancare: la
    // frase deve reggere l'assenza con una parola onesta.
    const originalFn = jest.fn().mockResolvedValue(original({ bodySource: "cache", fetchedAt: null }));
    await renderScreen(makeClient({ original: originalFn }));
    await waitFor(() => expect(screen.getByTestId("mail-detail-show-original")).toBeTruthy());
    await fireEvent.press(screen.getByTestId("mail-detail-show-original"));

    await waitFor(() => expect(screen.getByTestId("mail-detail-original-source")).toBeTruthy());
    expect(screen.getByText(/in precedenza/)).toBeTruthy();
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
