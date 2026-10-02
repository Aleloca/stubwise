import { ApiError, createStubwiseClient } from "@stubwise/api-client";
import type { StubwiseClient } from "@stubwise/api-client";
import NetInfo from "@react-native-community/netinfo";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import { useState } from "react";
import type { ReactNode } from "react";
import { Pressable, Text } from "react-native";
import { AuthContext } from "../../app/auth-context";
import type { AuthContextValue } from "../../app/providers";
import "../../i18n";
import { useRequestCorrection } from "../../lib/correction-mutations";
import { CorrectionSheet } from "./CorrectionSheet";
import type { CorrectionRequest, CorrectionTarget } from "./CorrectionSheet";

const TICKET_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_TICKET_ID = "66666666-6666-4666-8666-666666666666";
const REPO_A: CorrectionTarget = { repositoryId: "22222222-2222-4222-8222-222222222222", repositoryName: "Portale B2B" };
const REPO_B: CorrectionTarget = { repositoryId: "33333333-3333-4333-8333-333333333333", repositoryName: "API" };

/**
 * Un doppio TIPATO della mutazione di F3 (nessun cast): ha tutti i campi che
 * `useRequestCorrection` restituisce, così il compilatore segnala quello che
 * manca.
 */
function makeCorrection(overrides: Partial<CorrectionRequest> = {}): CorrectionRequest {
  return {
    request: jest.fn<void, Parameters<CorrectionRequest["request"]>>(),
    isPending: false,
    online: true,
    disabled: false,
    errorMessage: null,
    reset: jest.fn<void, []>(),
    ...overrides,
  };
}

async function renderSheet(overrides: Partial<CorrectionRequest> = {}, target: CorrectionTarget | null = REPO_A) {
  const correction = makeCorrection(overrides);
  const onClose = jest.fn<void, []>();
  const utils = await render(<CorrectionSheet ticketId={TICKET_ID} target={target} ticketNumber={247} correction={correction} onClose={onClose} />);
  return { correction, onClose, ...utils };
}

describe("CorrectionSheet", () => {
  test("sta nel foglio nativo e dice su quale ticket e repository si agisce", async () => {
    await renderSheet();
    expect(screen.getByTestId("true-sheet")).toBeTruthy();
    expect(screen.getByText("Chiedi modifiche · #247")).toBeTruthy();
    expect(screen.getByText("Portale B2B")).toBeTruthy();
  });

  test("chiuso: niente contenuto", async () => {
    await renderSheet({}, null);
    expect(screen.queryByTestId("correction-sheet-confirm")).toBeNull();
  });

  test("il campo ha il tetto del server, 4000 caratteri", async () => {
    await renderSheet();
    expect(screen.getByTestId("correction-sheet-note").props.maxLength).toBe(4000);
  });

  test("la nota viaggia ripulita, col repository del pannello", async () => {
    const { correction } = await renderSheet();
    await fireEvent.changeText(screen.getByTestId("correction-sheet-note"), "  Rinomina anche il test  ");
    await fireEvent.press(screen.getByTestId("correction-sheet-confirm"));
    expect(correction.request).toHaveBeenCalledWith(
      { repositoryId: REPO_A.repositoryId, note: "Rinomina anche il test" },
      expect.any(Function),
    );
  });

  test("nota vuota o di soli spazi: si conferma senza nota, non con una stringa vuota", async () => {
    const { correction } = await renderSheet();
    await fireEvent.changeText(screen.getByTestId("correction-sheet-note"), "   ");
    await fireEvent.press(screen.getByTestId("correction-sheet-confirm"));
    expect(correction.request).toHaveBeenCalledWith({ repositoryId: REPO_A.repositoryId, note: undefined }, expect.any(Function));
  });

  test("si chiude solo al SUCCESSO: confermare non chiude, l'onDone sì", async () => {
    const { correction, onClose } = await renderSheet();
    await fireEvent.press(screen.getByTestId("correction-sheet-confirm"));
    expect(onClose).not.toHaveBeenCalled();
    const onDone = (correction.request as jest.Mock).mock.calls[0][1] as () => void;
    onDone();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test("l'errore resta DENTRO il pannello, che non si chiude da sé", async () => {
    const { onClose } = await renderSheet({ errorMessage: "C'è già una correzione in corso su questa PR" });
    expect(screen.getByTestId("correction-sheet-error")).toBeTruthy();
    expect(screen.getByText("C'è già una correzione in corso su questa PR")).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
  });

  test("«Annulla» azzera l'errore della mutazione e chiude", async () => {
    const { correction, onClose } = await renderSheet({ errorMessage: "boom" });
    await fireEvent.press(screen.getByTestId("correction-sheet-cancel"));
    expect(correction.reset).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test("chiuderlo col dito azzera anche l'errore", async () => {
    const { correction, onClose } = await renderSheet({ errorMessage: "boom" });
    await fireEvent.press(screen.getByTestId("true-sheet-dismiss"));
    expect(correction.reset).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  test("in volo: campo, conferma e annulla spenti, e il pannello non si trascina via", async () => {
    const { onClose, correction } = await renderSheet({ isPending: true, disabled: true });
    expect(screen.getByTestId("correction-sheet-note").props.editable).toBe(false);
    expect(screen.getByTestId("correction-sheet-confirm").props.accessibilityState?.disabled).toBe(true);
    expect(screen.getByTestId("correction-sheet-cancel").props.accessibilityState?.disabled).toBe(true);
    // Il mock di true-sheet (jest.setup.ts) fa col bottone `true-sheet-dismiss`
    // quello che farebbe il dito, ma solo se `dismissible` non è false.
    await fireEvent.press(screen.getByTestId("true-sheet-dismiss"));
    expect(onClose).not.toHaveBeenCalled();
    expect(correction.reset).not.toHaveBeenCalled();
    expect(screen.getByTestId("correction-sheet-confirm")).toBeTruthy();
  });

  test("chiuso DA CODICE mentre è in volo: la mutazione non si azzera, l'esito non si perde", async () => {
    // Il foglio vero (e il mock) avvisa `onDidDismiss` anche quando si chiude
    // perché `open` torna falso: quel secondo avviso non deve buttare via una
    // richiesta ancora in corso.
    const correction = makeCorrection({ isPending: true, disabled: true });
    const onClose = jest.fn<void, []>();
    const { rerender } = await render(<CorrectionSheet ticketId={TICKET_ID} target={REPO_A} ticketNumber={247} correction={correction} onClose={onClose} />);
    await rerender(<CorrectionSheet ticketId={TICKET_ID} target={null} ticketNumber={247} correction={correction} onClose={onClose} />);
    expect(correction.reset).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  test("offline: la conferma è spenta e lo dice", async () => {
    const { correction } = await renderSheet({ online: false, disabled: true });
    expect(screen.getByTestId("correction-sheet-confirm").props.accessibilityState?.disabled).toBe(true);
    expect(screen.getByText("// senza rete non si chiede")).toBeTruthy();
    await fireEvent.press(screen.getByTestId("correction-sheet-confirm"));
    expect(correction.request).not.toHaveBeenCalled();
  });

  test("online: niente avviso di rete", async () => {
    await renderSheet();
    expect(screen.queryByText("// senza rete non si chiede")).toBeNull();
  });

  test("chiuso e riaperto su un'altra PR, la nota di prima non c'è più", async () => {
    const correction = makeCorrection();
    const onClose = jest.fn<void, []>();
    const { rerender } = await render(<CorrectionSheet ticketId={TICKET_ID} target={REPO_A} ticketNumber={247} correction={correction} onClose={onClose} />);
    await fireEvent.changeText(screen.getByTestId("correction-sheet-note"), "vecchia nota");
    await rerender(<CorrectionSheet ticketId={TICKET_ID} target={null} ticketNumber={247} correction={correction} onClose={onClose} />);
    await rerender(<CorrectionSheet ticketId={TICKET_ID} target={REPO_B} ticketNumber={247} correction={correction} onClose={onClose} />);
    expect(screen.getByText("API")).toBeTruthy();
    expect(screen.getByTestId("correction-sheet-note").props.value).toBe("");
  });

  test("la PR cambia mentre il pannello è aperto: la nota non passa da una PR all'altra", async () => {
    // Il mock del foglio smonta i figli quando si chiude, quindi il caso qui
    // sopra passerebbe anche senza azzeramento: questo, a pannello sempre
    // aperto, è quello che lo prova davvero.
    const correction = makeCorrection();
    const onClose = jest.fn<void, []>();
    const { rerender } = await render(<CorrectionSheet ticketId={TICKET_ID} target={REPO_A} ticketNumber={247} correction={correction} onClose={onClose} />);
    await fireEvent.changeText(screen.getByTestId("correction-sheet-note"), "nota per il portale");
    await rerender(<CorrectionSheet ticketId={TICKET_ID} target={REPO_B} ticketNumber={247} correction={correction} onClose={onClose} />);
    expect(screen.getByTestId("correction-sheet-note").props.value).toBe("");
  });

  test("un ALTRO ticket con lo stesso numero sullo stesso repository: la nota non passa", async () => {
    // I numeri dei ticket sono per progetto (`tickets_project_id_number_unique`):
    // due progetti che condividono un repository possono avere entrambi un #247.
    // Stesso numero, stesso repository, ticket diverso — è la collisione che una
    // chiave sul numero non vedrebbe.
    const correction = makeCorrection();
    const onClose = jest.fn<void, []>();
    const { rerender } = await render(<CorrectionSheet ticketId={TICKET_ID} target={REPO_A} ticketNumber={247} correction={correction} onClose={onClose} />);
    await fireEvent.changeText(screen.getByTestId("correction-sheet-note"), "nota del #247 del progetto A");
    await rerender(<CorrectionSheet ticketId={OTHER_TICKET_ID} target={REPO_A} ticketNumber={247} correction={correction} onClose={onClose} />);
    expect(screen.getByTestId("correction-sheet-note").props.value).toBe("");
  });

  test("il titolo è un'intestazione per il lettore di schermo", async () => {
    await renderSheet();
    expect(screen.getByText("Chiedi modifiche · #247").props.accessibilityRole).toBe("header");
  });
});

/**
 * Il `fetch` del client: una SPIA che rifiuta, come nei test di F3. Nessun test
 * deve arrivarci (lo verifica l'`afterEach`): se il pannello facesse chiamare un
 * metodo senza spia, un errore «di rete» farebbe passare per il motivo
 * sbagliato i test dell'errore.
 */
const fetchSpy = jest.fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>(() =>
  Promise.reject(new Error("fetch non previsto nei test del pannello")),
);

/**
 * Il CABLAGGIO con la mutazione vera di F3: un client tipato con una spia su
 * `tickets.requestCorrection` (l'unico metodo che il pannello fa chiamare) e
 * `fetchSpy` come trasporto.
 */
function makeClient(): { client: StubwiseClient; requestCorrection: jest.SpyInstance } {
  const client = createStubwiseClient({
    baseUrl: "https://stubwise.test",
    getAuthHeader: () => null,
    fetch: fetchSpy,
  });
  const requestCorrection = jest
    .spyOn(client.tickets, "requestCorrection")
    .mockResolvedValue({ correctionId: "55555555-5555-4555-8555-555555555555" });
  return { client, requestCorrection };
}

function Harness({ initial }: { initial: CorrectionTarget | null }) {
  const correction = useRequestCorrection(TICKET_ID);
  const [target, setTarget] = useState<CorrectionTarget | null>(initial);
  return (
    <>
      <Pressable testID="open-a" onPress={() => setTarget(REPO_A)}>
        <Text>A</Text>
      </Pressable>
      <Pressable testID="open-b" onPress={() => setTarget(REPO_B)}>
        <Text>B</Text>
      </Pressable>
      <Pressable testID="close-by-code" onPress={() => setTarget(null)}>
        <Text>chiudi</Text>
      </Pressable>
      <Text testID="harness-target">{target === null ? "none" : target.repositoryName}</Text>
      <CorrectionSheet ticketId={TICKET_ID} target={target} ticketNumber={247} correction={correction} onClose={() => setTarget(null)} />
    </>
  );
}

async function renderHarness(client: StubwiseClient) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const authValue: AuthContextValue = {
    status: "authenticated",
    client,
    user: { id: "u1", email: "op@example.com", role: "member", language: "it", avatarUrl: null, slackUserId: null },
    justLoggedIn: false,
    login: jest.fn(),
    completeOnboarding: jest.fn(),
    openSettings: jest.fn(),
    loggedOut: jest.fn(),
  };
  function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>
        <AuthContext.Provider value={authValue}>{children}</AuthContext.Provider>
      </QueryClientProvider>
    );
  }
  return render(
    <Wrapper>
      <Harness initial={REPO_A} />
    </Wrapper>,
  );
}

describe("CorrectionSheet con useRequestCorrection", () => {
  beforeEach(() => {
    (NetInfo.useNetInfo as jest.Mock).mockReturnValue({ isConnected: true, isInternetReachable: true });
    fetchSpy.mockClear();
  });

  afterEach(() => {
    // Nessun test va in rete: ogni chiamata passa dalla spia del client.
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("chiuso da codice in volo, poi la richiesta fallisce: riaprendo non c'è l'errore vecchio", async () => {
    const { client, requestCorrection } = makeClient();
    let fail: (error: unknown) => void = () => {};
    requestCorrection.mockReturnValue(
      new Promise((_resolve, reject) => {
        fail = reject;
      }),
    );
    await renderHarness(client);
    await fireEvent.press(screen.getByTestId("correction-sheet-confirm"));
    await waitFor(() =>
      expect(screen.getByTestId("correction-sheet-confirm").props.accessibilityState?.busy).toBe(true),
    );
    await fireEvent.press(screen.getByTestId("close-by-code"));
    expect(screen.queryByTestId("correction-sheet-confirm")).toBeNull();

    await act(async () => {
      fail(new ApiError(409, "…", "correction_in_flight"));
    });
    await fireEvent.press(screen.getByTestId("open-b"));
    await waitFor(() => expect(screen.getByTestId("correction-sheet-confirm")).toBeTruthy());
    expect(screen.queryByTestId("correction-sheet-error")).toBeNull();
    expect(screen.queryByText("C'è già una correzione in corso su questa PR")).toBeNull();
  });

  test("al successo il pannello si chiude, dopo aver mandato la nota", async () => {
    const { client, requestCorrection } = makeClient();
    await renderHarness(client);
    await fireEvent.changeText(screen.getByTestId("correction-sheet-note"), "Rinomina anche il test");
    await fireEvent.press(screen.getByTestId("correction-sheet-confirm"));
    await waitFor(() => expect(screen.getByTestId("harness-target").props.children).toBe("none"));
    expect(requestCorrection).toHaveBeenCalledWith(TICKET_ID, REPO_A.repositoryId, { note: "Rinomina anche il test" });
    expect(screen.queryByTestId("correction-sheet-confirm")).toBeNull();
  });

  test("su un rifiuto l'errore resta nel pannello aperto; «Annulla» lo azzera e alla riapertura non c'è", async () => {
    const { client, requestCorrection } = makeClient();
    requestCorrection.mockRejectedValue(new ApiError(409, "…", "correction_in_flight"));
    await renderHarness(client);
    await fireEvent.press(screen.getByTestId("correction-sheet-confirm"));
    await waitFor(() => expect(screen.getByTestId("correction-sheet-error")).toBeTruthy());
    expect(screen.getByText("C'è già una correzione in corso su questa PR")).toBeTruthy();
    expect(screen.getByTestId("harness-target").props.children).toBe("Portale B2B");

    await fireEvent.press(screen.getByTestId("correction-sheet-cancel"));
    expect(screen.getByTestId("harness-target").props.children).toBe("none");
    await fireEvent.press(screen.getByTestId("open-b"));
    expect(screen.getByTestId("correction-sheet-confirm")).toBeTruthy();
    expect(screen.getByTestId("harness-target").props.children).toBe("API");
    expect(screen.queryByTestId("correction-sheet-error")).toBeNull();
  });

  test("offline la mutazione vera spegne la conferma e il pannello lo dice", async () => {
    (NetInfo.useNetInfo as jest.Mock).mockReturnValue({ isConnected: false, isInternetReachable: false });
    const { client, requestCorrection } = makeClient();
    await renderHarness(client);
    expect(screen.getByText("// senza rete non si chiede")).toBeTruthy();
    expect(screen.getByTestId("correction-sheet-confirm").props.accessibilityState?.disabled).toBe(true);
    await fireEvent.press(screen.getByTestId("correction-sheet-confirm"));
    expect(requestCorrection).not.toHaveBeenCalled();
  });
});
