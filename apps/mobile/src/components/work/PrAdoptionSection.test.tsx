import { ApiError, createStubwiseClient } from "@stubwise/api-client";
import type { StubwiseClient } from "@stubwise/api-client";
import { UNKNOWN } from "@stubwise/shared";
import type { PrAdoption, Reader } from "@stubwise/shared";
import NetInfo from "@react-native-community/netinfo";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import { AuthContext } from "../../app/auth-context";
import type { AuthContextValue } from "../../app/providers";
import "../../i18n";
import { settleMutations } from "../../test-utils/settle-mutations";
import { PrAdoptionSection } from "./PrAdoptionSection";

const TICKET_ID = "11111111-1111-4111-8111-111111111111";
const REPO_ID = "22222222-2222-4222-8222-222222222222";

/**
 * Adozione COMPLETA (trappola delle fixture dell'app, CLAUDE.md): nei test il
 * client è un doppio e `readerSchema` non gira, quindi ogni campo dello schema
 * c'è, anche quelli che in produzione arriverebbero dai `.default()`.
 */
function adoption(overrides: Partial<Reader<PrAdoption>> = {}): Reader<PrAdoption> {
  return {
    repositoryId: REPO_ID,
    prNumber: 7,
    prUrl: "https://github.com/acme/repo/pull/7",
    branch: "feature/login",
    state: "available",
    unavailableReason: null,
    adoptedAt: null,
    adoptedBy: null,
    canManage: false,
    ...overrides,
  };
}

const fetchSpy = jest.fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>(() =>
  Promise.reject(new Error("fetch non previsto nei test della sezione adozione")),
);

/**
 * Il doppio è un client VERO con una spia su OGNI metodo che la sezione chiama
 * (`tickets.adoptPr`, `tickets.releasePrAdoption`): vedi CLAUDE.md, «il
 * DOPPIO del client nei test dell'app».
 */
function makeClient() {
  const client = createStubwiseClient({ baseUrl: "https://stubwise.test", getAuthHeader: () => null, fetch: fetchSpy });
  const adoptPr = jest.spyOn(client.tickets, "adoptPr").mockResolvedValue({ correctionId: null });
  const releasePrAdoption = jest.spyOn(client.tickets, "releasePrAdoption").mockResolvedValue(undefined);
  return { client, adoptPr, releasePrAdoption };
}

async function renderSection(client: StubwiseClient, a: Reader<PrAdoption>) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
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
        <PrAdoptionSection ticketId={TICKET_ID} ticketNumber={12} adoption={a} />
      </AuthContext.Provider>
    </QueryClientProvider>,
  );
  return { queryClient };
}

beforeEach(() => {
  (NetInfo.useNetInfo as jest.Mock).mockReturnValue({ isConnected: true, isInternetReachable: true });
  fetchSpy.mockClear();
});

afterEach(() => {
  expect(fetchSpy).not.toHaveBeenCalled();
  jest.restoreAllMocks();
});

describe("PrAdoptionSection", () => {
  test("canManage falso (un operatore): nessun bottone, nemmeno spento", async () => {
    const { client } = makeClient();
    await renderSection(client, adoption());
    expect(screen.queryByTestId("pr-adoption")).toBeNull();
    expect(screen.queryByTestId("pr-adoption-adopt")).toBeNull();
  });

  test("adottata e canManage falso: si legge che Stubwise la corregge, senza «Smetti»", async () => {
    const { client } = makeClient();
    await renderSection(client, adoption({ state: "adopted", adoptedBy: "mario@acme.test" }));
    expect(screen.getByTestId("pr-adoption-adopted")).toHaveTextContent(
      "Stubwise corregge questa PR · affidata da mario@acme.test",
    );
    expect(screen.queryByTestId("pr-adoption-release")).toBeNull();
  });

  test("un maintainer affida la PR con la nota: adoptPr con ticket, repository e nota", async () => {
    const { client, adoptPr } = makeClient();
    const { queryClient } = await renderSection(client, adoption({ canManage: true }));

    await fireEvent.press(screen.getByTestId("pr-adoption-adopt"));
    await waitFor(() => expect(screen.getByTestId("pr-adoption-sheet-note")).toBeTruthy());
    expect(screen.getByText(/pusherà i suoi commit su feature\/login/)).toBeTruthy();
    await fireEvent.changeText(screen.getByTestId("pr-adoption-sheet-note"), "  segui la review  ");
    await fireEvent.press(screen.getByTestId("pr-adoption-sheet-confirm"));

    await waitFor(() => expect(adoptPr).toHaveBeenCalledWith(TICKET_ID, REPO_ID, { note: "segui la review" }));
    await waitFor(() => expect(screen.queryByTestId("pr-adoption-sheet-note")).toBeNull());
    await settleMutations(queryClient);
  });

  test("un rifiuto del server si legge nel pannello, che resta aperto", async () => {
    const { client, adoptPr } = makeClient();
    adoptPr.mockRejectedValue(new ApiError(422, "raw", "pr_from_fork"));
    const { queryClient } = await renderSection(client, adoption({ canManage: true }));

    await fireEvent.press(screen.getByTestId("pr-adoption-adopt"));
    await waitFor(() => expect(screen.getByTestId("pr-adoption-sheet-confirm")).toBeTruthy());
    await fireEvent.press(screen.getByTestId("pr-adoption-sheet-confirm"));

    await waitFor(() =>
      expect(screen.getByText("Questa PR viene da un fork: Stubwise non può pushare sul suo branch")).toBeTruthy(),
    );
    expect(screen.getByTestId("pr-adoption-sheet-note")).toBeTruthy();
    await settleMutations(queryClient);
  });

  test("non disponibile: il bottone c'è ma è spento, col motivo", async () => {
    const { client } = makeClient();
    await renderSection(client, adoption({ canManage: true, state: "unavailable", unavailableReason: "base_branch" }));
    expect(screen.getByTestId("pr-adoption-note")).toHaveTextContent("Non disponibile: il branch della PR è quello base.");
    expect(screen.getByTestId("pr-adoption-adopt")).toBeDisabled();
  });

  test("uno stato che questa app non conosce: nessuna azione offerta", async () => {
    const { client } = makeClient();
    await renderSection(client, adoption({ canManage: true, state: UNKNOWN }));
    expect(screen.queryByTestId("pr-adoption-adopt")).toBeNull();
  });

  test("un motivo che questa app non conosce: testo generico, mai la chiave", async () => {
    const { client } = makeClient();
    await renderSection(client, adoption({ canManage: true, state: "unavailable", unavailableReason: UNKNOWN }));
    expect(screen.getByTestId("pr-adoption-note")).toHaveTextContent("Non disponibile.");
  });

  test("adottata, maintainer: «Smetti di correggere» in due passi → releasePrAdoption", async () => {
    const { client, releasePrAdoption } = makeClient();
    const { queryClient } = await renderSection(client, adoption({ canManage: true, state: "adopted" }));

    expect(screen.getByTestId("pr-adoption-adopted")).toHaveTextContent("Stubwise corregge questa PR");
    await fireEvent.press(screen.getByTestId("pr-adoption-release"));
    expect(releasePrAdoption).not.toHaveBeenCalled();
    await fireEvent.press(screen.getByTestId("pr-adoption-release-confirm"));

    await waitFor(() => expect(releasePrAdoption).toHaveBeenCalledWith(TICKET_ID, REPO_ID));
    await settleMutations(queryClient);
  });
});
