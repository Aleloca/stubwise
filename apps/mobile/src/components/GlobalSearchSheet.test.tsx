import type { StubwiseClient } from "@stubwise/api-client";
import type { Reader, SearchResults } from "@stubwise/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, waitFor } from "@testing-library/react-native";
import { AuthContext } from "../app/auth-context";
import type { AuthContextValue } from "../app/providers";
import "../i18n";
import { GlobalSearchSheet } from "./GlobalSearchSheet";

/**
 * La ricerca globale dell'app (15 set 2026, design §3, Task 10).
 *
 * Le due proprietà che questo file presidia più delle altre:
 *  - **un risultato di posta porta alla CONVERSAZIONE**, col messaggio che ha
 *    combaciato, non al messaggio sciolto;
 *  - **i repository NON compaiono**: l'app non ha una schermata dei
 *    repository, e una riga che non porta da nessuna parte è peggio di una
 *    riga assente.
 */

// `mock…` nel nome: jest permette solo a queste variabili di essere
// referenziate dentro una factory di `jest.mock`.
const mockNavigate = jest.fn();
/** Condiviso: `renderSheet` restituisce il risultato di `render` NUDO (vedi lì). */
const onRequestClose = jest.fn();
// ⚠️ `...actual` NON è di troppo: l'albero renderizzato tira dentro
// `app/providers`, che da questo stesso modulo usa altro — sostituirlo per
// intero lascerebbe `undefined` al posto di quelle export e l'albero non
// monterebbe affatto (sintomo fuorviante: `render` torna senza query, come
// se non fosse mai stato chiamato). Si sostituisce SOLO `useNavigation`.
jest.mock("@react-navigation/native", () => {
  const actual = jest.requireActual("@react-navigation/native");
  return { ...actual, useNavigation: () => ({ navigate: mockNavigate }) };
});

function results(overrides: Partial<Reader<SearchResults>> = {}): Reader<SearchResults> {
  return {
    tickets: {
      items: [
        {
          id: "t1",
          number: 42,
          title: "Login rotto",
          status: "open",
          snippet: "il login è rotto",
          projectId: "p1",
          projectName: "Acme",
        },
      ],
      hasMore: false,
    },
    projects: { items: [{ id: "p1", name: "Acme", slug: "acme", snippet: null }], hasMore: false },
    repositories: {
      items: [{ id: "r1", name: "Web", slug: "web", projectId: "p1", repoUrl: "https://git.test/web" }],
      hasMore: false,
    },
    docs: { items: [], hasMore: false },
    mail: {
      items: [
        {
          threadId: "thread-1",
          accountId: "acc-1",
          accountEmail: "mailbox@acme.test",
          subject: "Fattura da rivedere",
          from: "cliente@acme.test",
          snippet: "la fattura di settembre",
          matchedMessageId: "msg-9",
          receivedAt: "2026-09-15T09:00:00.000Z",
        },
      ],
      hasMore: false,
    },
    ...overrides,
  } as Reader<SearchResults>;
}

function makeClient(global: jest.Mock) {
  return { search: { global } } as unknown as StubwiseClient;
}

function authValue(client: StubwiseClient): AuthContextValue {
  return {
    status: "authenticated",
    client,
    user: { id: "u1", email: "giulia@acme.test", role: "member", language: "it", avatarUrl: null, slackUserId: null },
    justLoggedIn: false,
    login: jest.fn(),
    completeOnboarding: jest.fn(),
    openSettings: jest.fn(),
    loggedOut: jest.fn(),
  };
}

/**
 * Nessun `NavigationContainer`: `useNavigation` è mockato per intero, quindi
 * un navigatore vero aggiungerebbe solo un pezzo da far funzionare — e i test
 * qui guardano COSA viene chiesto alla navigazione, non che la navigazione
 * funzioni (quella ha i suoi test in `navigation.test.tsx`).
 */
async function renderSheet(global: jest.Mock) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  // Le query tornano da `render`, non dal singleton `screen`: mockando
  // `@react-navigation/native` il registro dei moduli di jest ricarica la
  // testing-library e il suo `screen` resta vuoto. Le query dell'istanza non
  // hanno quel problema.
  const view = await render(
    <QueryClientProvider client={queryClient}>
      <AuthContext.Provider value={authValue(makeClient(global))}>
        <GlobalSearchSheet visible onRequestClose={onRequestClose} />
      </AuthContext.Provider>
    </QueryClientProvider>,
  );
  return view;
}

beforeEach(() => {
  mockNavigate.mockClear();
  onRequestClose.mockClear();
});

describe("GlobalSearchSheet", () => {
  it("a query vuota non chiama il server e spiega cosa fare", async () => {
    const global = jest.fn();
    const view = await renderSheet(global);
    expect(view.getByText("Scrivi per cercare in tutto Stubwise.")).toBeTruthy();
    expect(global).not.toHaveBeenCalled();
  });

  it("digitando cerca, e mostra i gruppi", async () => {
    const global = jest.fn().mockResolvedValue(results());
    const view = await renderSheet(global);

    fireEvent.changeText(view.getByTestId("global-search-input"), "fattura");

    expect(await view.findByTestId("global-search-ticket-t1")).toBeTruthy();
    expect(view.getByTestId("global-search-project-p1")).toBeTruthy();
    expect(view.getByTestId("global-search-mail-thread-1")).toBeTruthy();
    await waitFor(() => expect(global).toHaveBeenCalledWith("fattura"));
  });

  it("le schede filtrano per tipo, e «tutto» le rimette insieme", async () => {
    // Richiesta del maintainer (16 set 2026). È un filtro sul RISULTATO: il
    // server cerca sempre ovunque, quindi cambiare scheda non deve produrre
    // una seconda chiamata — la riga finale lo verifica.
    const global = jest.fn().mockResolvedValue(results());
    const view = await renderSheet(global);
    fireEvent.changeText(view.getByTestId("global-search-input"), "fattura");
    await view.findByTestId("global-search-ticket-t1");

    await fireEvent.press(view.getByTestId("global-search-filter-mail"));
    expect(view.getByTestId("global-search-mail-thread-1")).toBeTruthy();
    // Il NEGATIVO: se il filtro non filtrasse, questa riga troverebbe il
    // ticket lo stesso.
    expect(view.queryByTestId("global-search-ticket-t1")).toBeNull();

    await fireEvent.press(view.getByTestId("global-search-filter-all"));
    expect(view.getByTestId("global-search-ticket-t1")).toBeTruthy();
    expect(view.getByTestId("global-search-mail-thread-1")).toBeTruthy();

    // Una sola chiamata per l'intera sequenza.
    await waitFor(() => expect(global).toHaveBeenCalledTimes(1));
  });

  it("una scheda senza risultati NON si mostra", async () => {
    // Richiesta del maintainer: «Ticket · 0» è rumore. La mia obiezione
    // («la riga ballerebbe a ogni tasto») era sbagliata: i conteggi cambiano
    // solo quando la ricerca si assesta.
    const global = jest.fn().mockResolvedValue(results({ docs: { items: [], hasMore: false } }));
    const view = await renderSheet(global);
    fireEvent.changeText(view.getByTestId("global-search-input"), "fattura");
    await view.findByTestId("global-search-ticket-t1");
    expect(view.queryByTestId("global-search-filter-docs")).toBeNull();
    // «Tutto» c'è sempre, anche quando è l'unica.
    expect(view.getByTestId("global-search-filter-all")).toBeTruthy();
  });

  it("se la scheda ATTIVA si svuota, si torna su «tutto» invece di restare a schermo vuoto", async () => {
    // Il caso vero che nascondere le schede introduce: la scheda sotto il
    // dito sparisce, e senza questo ripiego resterebbe un filtro applicato
    // senza nessuna scheda accesa.
    const conPosta = results();
    const senzaPosta = results({ mail: { items: [], hasMore: false } });
    const global = jest.fn().mockResolvedValueOnce(conPosta).mockResolvedValue(senzaPosta);
    const view = await renderSheet(global);

    fireEvent.changeText(view.getByTestId("global-search-input"), "fattura");
    await view.findByTestId("global-search-filter-mail");
    await fireEvent.press(view.getByTestId("global-search-filter-mail"));
    expect(view.queryByTestId("global-search-ticket-t1")).toBeNull();

    // Ora la posta sparisce dai risultati: la scheda non c'è più, e il
    // filtro NON deve restare appeso a un tipo che non esiste.
    fireEvent.changeText(view.getByTestId("global-search-input"), "fatturazione");
    await waitFor(() => expect(view.queryByTestId("global-search-filter-mail")).toBeNull());
    await waitFor(() => expect(view.getByTestId("global-search-ticket-t1")).toBeTruthy());
  });

  it("⚠️ i REPOSITORY non compaiono: l'app non ha dove portarli", async () => {
    // Una riga che non porta da nessuna parte è peggio di una riga assente —
    // chi la tocca pensa che l'app sia rotta. Stessa regola di `EventRow`.
    const global = jest.fn().mockResolvedValue(results());
    const view = await renderSheet(global);
    fireEvent.changeText(view.getByTestId("global-search-input"), "web");

    await view.findByTestId("global-search-ticket-t1");
    expect(view.queryByText("Web")).toBeNull();
  });

  it("⚠️ un risultato di POSTA porta alla CONVERSAZIONE, col messaggio che ha combaciato", async () => {
    const global = jest.fn().mockResolvedValue(results());
    const view = await renderSheet(global);
    fireEvent.changeText(view.getByTestId("global-search-input"), "fattura");

    fireEvent.press(await view.findByTestId("global-search-mail-thread-1"));

    expect(mockNavigate).toHaveBeenCalledWith("Main", {
      screen: "Mbx",
      params: {
        screen: "ThreadDetail",
        params: { threadId: "thread-1", highlightMessageId: "msg-9" },
      },
    });
    // E il foglio si chiude: restare aperti sopra la schermata appena aperta
    // vorrebbe dire non vedere dove si è andati.
    expect(onRequestClose).toHaveBeenCalled();
  });

  it("un ticket porta al ticket, dentro la scheda Progetti", async () => {
    const global = jest.fn().mockResolvedValue(results());
    const view = await renderSheet(global);
    fireEvent.changeText(view.getByTestId("global-search-input"), "login");

    fireEvent.press(await view.findByTestId("global-search-ticket-t1"));
    expect(mockNavigate).toHaveBeenCalledWith("Main", {
      screen: "Projects",
      params: { screen: "Ticket", params: { id: "t1" } },
    });
  });

  it("nessun risultato lo dice, invece di restare vuoto", async () => {
    const global = jest.fn().mockResolvedValue(
      results({
        tickets: { items: [], hasMore: false },
        projects: { items: [], hasMore: false },
        mail: { items: [], hasMore: false },
      }),
    );
    const view = await renderSheet(global);
    fireEvent.changeText(view.getByTestId("global-search-input"), "niente");

    expect(await view.findByText("Nessun risultato.")).toBeTruthy();
  });

  it("una risposta SENZA il gruppo mail non fa saltare il foglio", async () => {
    // Fixture volutamente incompleta: l'app parsa davvero (i `.default()`
    // girano), ma la difesa `?? []` nel punto di lettura costa nulla e regge
    // anche dietro un percorso che non parsasse.
    const bare = results();
    delete (bare as Record<string, unknown>).mail;
    const global = jest.fn().mockResolvedValue(bare);
    const view = await renderSheet(global);
    fireEvent.changeText(view.getByTestId("global-search-input"), "login");

    expect(await view.findByTestId("global-search-ticket-t1")).toBeTruthy();
  });
});
