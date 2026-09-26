import type { StubwiseClient } from "@stubwise/api-client";
import type { InboxItem, Reader } from "@stubwise/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import NetInfo from "@react-native-community/netinfo";
import { AuthContext } from "../../app/auth-context";
import type { AuthContextValue } from "../../app/providers";
import "../../i18n";
import { GoogleProposalScreen } from "./GoogleProposalScreen";

// ⚠️ LO SPREAD DI `requireActual` NON È OPZIONALE (CLAUDE.md): sostituire il
// modulo per intero lascia `undefined` al posto delle altre export e l'albero
// non monta, con un sintomo che non dice niente. Qui serve perché il blocco
// «cosa ha letto Stubwise» usa `useNavigation` per passare la mano a MBX, e
// questa schermata nei test è renderizzata SENZA un NavigationContainer.
// Il prefisso `mock` non è stilistico: `jest.mock` viene issato in cima al
// file e la sua factory può riferirsi SOLO a variabili che iniziano così.
const mockNavigate = jest.fn();
jest.mock("@react-navigation/native", () => ({
  ...jest.requireActual("@react-navigation/native"),
  useNavigation: () => ({ navigate: mockNavigate }),
}));

const ID = "gp1";

/** L'id della FONTE: `email_proposals.id`, derivato a lettura dal server. */
const SOURCE_ID = "ep-1";

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
      multiSelectIndices: [],
    },
    ...overrides,
  } as Reader<InboxItem>;
}

function makeClient(
  overrides: { list?: jest.Mock; act?: jest.Mock; mailGet?: jest.Mock } = {},
): StubwiseClient {
  return {
    inbox: {
      list: overrides.list ?? jest.fn().mockResolvedValue({ items: [proposal()], nextCursor: null }),
      act: overrides.act ?? jest.fn().mockResolvedValue({ changedNotificationIds: [] }),
    },
    mail: {
      get: overrides.mailGet ?? jest.fn().mockRejectedValue(new Error("non chiamata")),
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

/**
 * «Cosa ha letto Stubwise» (18 set 2026): la FONTE della proposta.
 *
 * Una proposta senza la sua fonte è un'affermazione che non si può verificare
 * — ed è il motivo per cui il blocco esiste. Ma il degrado conta quanto il
 * caso felice: non sapere cosa ha letto il modello è un peccato, non poter
 * decidere è un guasto.
 */
describe("GoogleProposalScreen — la fonte della proposta", () => {
  beforeEach(() => {
    mockNavigate.mockClear();
  });

  /** Una proposta che porta l'id della fonte, come lo deriva il server. */
  function withSource(): Reader<InboxItem> {
    const base = proposal();
    return {
      ...base,
      google: { ...base.google!, sourceProposalId: SOURCE_ID },
    } as Reader<InboxItem>;
  }

  it("mostra l'ESTRATTO che la classificazione ha letto, chiesto con l'id derivato", async () => {
    const mailGet = jest.fn().mockResolvedValue({
      textExcerpt: "Ci servirebbe rinviare il rilascio di una settimana.",
    });
    await renderScreen(
      makeClient({
        list: jest.fn().mockResolvedValue({ items: [withSource()], nextCursor: null }),
        mailGet,
      }),
    );

    expect(await screen.findByTestId("google-proposal-source-text")).toHaveTextContent(
      "Ci servirebbe rinviare il rilascio di una settimana.",
    );
    // ⚠️ `source: "email"` con l'id della PROPOSTA: la rotta di dettaglio
    // risolve il messaggio a partire da `email_proposals.id`, non dall'id del
    // messaggio. Passarle l'id sbagliato darebbe 404.
    expect(mailGet).toHaveBeenCalledWith("email", SOURCE_ID);
  });

  it("«apri la conversazione» passa la mano a MBX invece di duplicare la lettura", async () => {
    await renderScreen(
      makeClient({
        list: jest.fn().mockResolvedValue({ items: [withSource()], nextCursor: null }),
        mailGet: jest.fn().mockResolvedValue({ textExcerpt: "Testo." }),
      }),
    );

    fireEvent.press(await screen.findByTestId("google-proposal-source-open"));
    expect(mockNavigate).toHaveBeenCalledWith("Main", {
      screen: "Mbx",
      params: { screen: "MailDetail", params: { source: "email", id: SOURCE_ID } },
    });
  });

  it("⚠️ la rotta fallisce: niente blocco, e le scelte restano premibili", async () => {
    const act = jest.fn().mockResolvedValue({ changedNotificationIds: [] });
    await renderScreen(
      makeClient({
        list: jest.fn().mockResolvedValue({ items: [withSource()], nextCursor: null }),
        mailGet: jest.fn().mockRejectedValue(new Error("boom")),
        act,
      }),
    );

    await screen.findByTestId("google-action-0");
    await waitFor(() => expect(screen.queryByTestId("google-proposal-source-text")).toBeNull());
    // Il guasto che questo test esclude non è «manca un blocco»: è una
    // schermata che non si può più usare.
    fireEvent.press(screen.getByTestId("google-action-0"));
    await waitFor(() => expect(act).toHaveBeenCalled());
  });

  it("senza id della fonte non si chiede niente: nessuna richiesta, nessun blocco", async () => {
    // È il caso del calendario, dello smistamento e di un server più vecchio.
    const mailGet = jest.fn();
    await renderScreen(makeClient({ mailGet }));

    await screen.findByTestId("google-action-0");
    expect(screen.queryByTestId("google-proposal-source-text")).toBeNull();
    expect(mailGet).not.toHaveBeenCalled();
  });
});
