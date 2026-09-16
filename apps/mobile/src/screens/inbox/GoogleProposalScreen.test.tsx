import type { StubwiseClient } from "@stubwise/api-client";
import type { InboxItem, Reader } from "@stubwise/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import NetInfo from "@react-native-community/netinfo";
import { AuthContext } from "../../app/auth-context";
import type { AuthContextValue } from "../../app/providers";
import "../../i18n";
import { GoogleProposalScreen } from "./GoogleProposalScreen";

const ID = "gp1";

function proposal(overrides: Partial<Reader<InboxItem>> = {}): Reader<InboxItem> {
  return {
    id: ID,
    kind: "google.proposal",
    status: "open",
    text: "Laura chiede a proposito di «Rinviamo il rilascio?». Come diamo seguito?",
    actions: ["answer", "snooze", "handled"],
    projectId: null,
    ticketId: null,
    jobId: null,
    createdAt: "2026-09-02T09:48:00.000Z",
    readAt: null,
    snoozedUntil: null,
    handledAt: null,
    handledBy: null,
    question: {
      questionId: ID,
      question: "Come diamo seguito?",
      options: [
        { label: "Aggiungi al backlog", consequence: "Nuova voce su Portale B2B" },
        { label: "Ignora", consequence: "Nessuna azione" },
      ],
      recommendedIndex: 0,
      allowFreeText: false,
    },
    google: {
      source: "email",
      from: "laura@cliente.test",
      subject: "Rinviamo il rilascio?",
      signal: "decision",
      actions: [{ type: "create_backlog_item" }, { type: "ignore" }],
      auto: false,
    },
    ...overrides,
  } as Reader<InboxItem>;
}

function makeClient(overrides: { list?: jest.Mock; act?: jest.Mock } = {}): StubwiseClient {
  return {
    inbox: {
      list: overrides.list ?? jest.fn().mockResolvedValue({ items: [proposal()], nextCursor: null }),
      act: overrides.act ?? jest.fn().mockResolvedValue({ changedNotificationIds: [] }),
    },
  } as unknown as StubwiseClient;
}

// ⚠️ `await render(...)`: in questo progetto va atteso, o l'albero non viene
// montato e `screen` resta vuoto.
async function renderScreen(client: StubwiseClient) {
  // Le decisioni sono disabilitate offline (vedi `useDecision`): senza dire a
  // NetInfo che c'è rete, ogni bottone di questa pagina resta inerte e i test
  // fallirebbero per il motivo sbagliato.
  (NetInfo.useNetInfo as jest.Mock).mockReturnValue({ isConnected: true, isInternetReachable: true });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const goBack = jest.fn();
  const authValue: AuthContextValue = {
    status: "authenticated",
    client,
    user: null,
    justLoggedIn: false,
    login: jest.fn(),
    completeOnboarding: jest.fn(),
    openSettings: jest.fn(),
    loggedOut: jest.fn(),
  };
  const rendered = await render(
    <QueryClientProvider client={queryClient}>
      <AuthContext.Provider value={authValue}>
        <GoogleProposalScreen
          navigation={{ goBack } as never}
          route={{ key: "k", name: "Proposal", params: { id: ID } } as never}
        />
      </AuthContext.Provider>
    </QueryClientProvider>,
  );
  return { ...rendered, goBack };
}

describe("GoogleProposalScreen", () => {
  test("mostra chi scrive, cosa chiede e le scelte con la loro conseguenza", async () => {
    await renderScreen(makeClient());
    await waitFor(() => expect(screen.getByText("Aggiungi al backlog")).toBeTruthy());
    expect(screen.getByText(/laura@cliente.test/)).toBeTruthy();
    // La CONSEGUENZA, non solo l'etichetta: è ciò che permette di decidere
    // senza conoscere il prodotto.
    expect(screen.getByText("Nuova voce su Portale B2B")).toBeTruthy();
    expect(screen.getByText("Ignora")).toBeTruthy();
  });

  test("scegliere manda l'INDICE, non il contenuto della scelta", async () => {
    // Il payload di un'azione non lascia mai il server (vedi
    // `inboxGoogleActionSchema`): se un giorno questa pagina cominciasse a
    // mandare altro, questo test lo direbbe.
    const act = jest.fn().mockResolvedValue({ changedNotificationIds: [ID] });
    await renderScreen(makeClient({ act }));
    await waitFor(() => expect(screen.getByTestId("google-action-1")).toBeTruthy());
    await fireEvent.press(screen.getByTestId("google-action-1"));
    await waitFor(() => expect(act).toHaveBeenCalledWith(ID, "answer", { optionIndex: 1 }));
  });

  test("proposta sparita dalla lista: lo dice, non un errore", async () => {
    const list = jest.fn().mockResolvedValue({ items: [], nextCursor: null });
    await renderScreen(makeClient({ list }));
    await waitFor(() => expect(screen.getByTestId("google-proposal-gone")).toBeTruthy());
  });

  test("proposta già decisa: nessuna scelta da premere", async () => {
    const decisa = proposal({ question: undefined, google: { ...proposal().google!, actions: [] } as never });
    const list = jest.fn().mockResolvedValue({ items: [decisa], nextCursor: null });
    await renderScreen(makeClient({ list }));
    await waitFor(() => expect(screen.getByTestId("google-proposal-decided")).toBeTruthy());
    expect(screen.queryByTestId("google-action-0")).toBeNull();
  });
});
