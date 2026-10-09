import { ApiError, type StubwiseClient } from "@stubwise/api-client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { NavigationContext } from "@react-navigation/native";
import { act, render, screen, waitFor } from "@testing-library/react-native";
import { AuthContext } from "../../app/auth-context";
import type { AuthContextValue } from "../../app/providers";
import "../../i18n";
import { settleQueries } from "../../test-utils/settle-queries";
import { AgentSessionByJobScreen } from "./AgentSessionByJobScreen";

const JOB_ID = "88888888-8888-4888-8888-888888888888";
const TICKET_ID = "77777777-7777-4777-8777-777777777777";

/** Doppio del client: il metodo che la schermata usa c'è PRIMA del test (la terza trappola). */
function makeClient(list: jest.Mock): StubwiseClient {
  return {
    agentSessions: { list, get: jest.fn(), events: jest.fn(), send: jest.fn(), streamPath: jest.fn() },
  } as unknown as StubwiseClient;
}

const clients: QueryClient[] = [];
afterEach(() => {
  clients.splice(0).forEach((c) => c.clear());
});

async function renderScreen(
  client: StubwiseClient | null,
  params: { jobId: string; ticketId?: string },
  options: { focused?: boolean } = {},
) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  clients.push(queryClient);
  const replace = jest.fn();
  const goBack = jest.fn();
  const navigate = jest.fn();
  const pop = jest.fn();
  const dispatch = jest.fn();
  // Il fuoco come lo dà react-navigation: `isFocused()` più gli eventi
  // `focus`/`blur`, letti da `useScreenFocused` dal `NavigationContext`.
  let focused = options.focused ?? true;
  const listeners: Record<string, (() => void)[]> = {};
  const isFocused = jest.fn(() => focused);
  const addListener = jest.fn((event: string, cb: () => void) => {
    (listeners[event] ??= []).push(cb);
    return () => {};
  });
  const getState = jest.fn(() => ({ key: "stack-inbox" }));
  const navigation = { replace, goBack, navigate, pop, dispatch, isFocused, addListener, getState };
  const setFocused = async (value: boolean) => {
    focused = value;
    await act(async () => {
      (listeners[value ? "focus" : "blur"] ?? []).forEach((cb) => cb());
    });
  };
  const authValue: AuthContextValue = {
    status: "authenticated",
    client: client as StubwiseClient,
    user: null,
    justLoggedIn: false,
    login: jest.fn(),
    completeOnboarding: jest.fn(),
    openSettings: jest.fn(),
    loggedOut: jest.fn(),
  };
  await render(
    <QueryClientProvider client={queryClient}>
      <AuthContext.Provider value={authValue}>
        <NavigationContext.Provider value={navigation as never}>
          <AgentSessionByJobScreen
            navigation={navigation as never}
            route={{ key: "AgentSessionByJob", name: "AgentSessionByJob", params } as never}
          />
        </NavigationContext.Provider>
      </AuthContext.Provider>
    </QueryClientProvider>,
  );
  return { replace, goBack, navigate, pop, dispatch, setFocused, queryClient };
}

/**
 * Dal job alla sua sessione (piano C, Task 8; gemello di
 * `apps/web/src/routes/agents/by-job.tsx`): «Apri» di una domanda
 * dell'agente arriva qui. Sessione trovata → la sessione, sulla domanda;
 * altrimenti il ticket; senza nemmeno quello, indietro. Sempre `replace`.
 */
describe("AgentSessionByJobScreen", () => {
  test("mentre cerca: uno skeleton, nessuna navigazione", async () => {
    const list = jest.fn(() => new Promise(() => {}));
    const { replace, navigate } = await renderScreen(makeClient(list), { jobId: JOB_ID, ticketId: TICKET_ID });
    expect(screen.getByTestId("agent-session-by-job-skeleton")).toBeTruthy();
    expect(replace).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
  });

  test("sessione viva trovata: la sessione, aperta sulla domanda", async () => {
    const list = jest.fn().mockResolvedValue({ live: [{ id: "s-live" }], recent: [{ id: "s-old" }] });
    const r = await renderScreen(makeClient(list), { jobId: JOB_ID, ticketId: TICKET_ID });
    // La sessione sta sul ROOT stack (Task A1): si apre lassù e questa
    // schermata esce dal suo stack — un `replace` qui sostituirebbe `Main`.
    await waitFor(() => expect(r.navigate).toHaveBeenCalledWith("AgentSession", { id: "s-live", focus: "question" }, { pop: true }));
    expect(r.dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: "POP", target: "stack-inbox" }));
    expect(r.replace).not.toHaveBeenCalled();
    expect(list).toHaveBeenCalledWith({ aiJobId: JOB_ID });
  });

  test("solo una conclusa: quella", async () => {
    const list = jest.fn().mockResolvedValue({ live: [], recent: [{ id: "s-old" }] });
    const r = await renderScreen(makeClient(list), { jobId: JOB_ID, ticketId: TICKET_ID });
    // La sessione sta sul ROOT stack (Task A1): si apre lassù e questa
    // schermata esce dal suo stack — un `replace` qui sostituirebbe `Main`.
    await waitFor(() => expect(r.navigate).toHaveBeenCalledWith("AgentSession", { id: "s-old", focus: "question" }, { pop: true }));
    expect(r.dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: "POP", target: "stack-inbox" }));
    expect(r.replace).not.toHaveBeenCalled();
  });

  test("nessuna sessione: il ticket, su Stato", async () => {
    const list = jest.fn().mockResolvedValue({ live: [], recent: [] });
    const { replace } = await renderScreen(makeClient(list), { jobId: JOB_ID, ticketId: TICKET_ID });
    await waitFor(() => expect(replace).toHaveBeenCalledWith("Ticket", { id: TICKET_ID, tab: "status" }));
  });

  test("server senza le rotte (404 senza code): il ticket, UNA sola richiesta", async () => {
    const list = jest.fn().mockRejectedValue(new ApiError(404, "not found"));
    const { replace } = await renderScreen(makeClient(list), { jobId: JOB_ID, ticketId: TICKET_ID });
    await waitFor(() => expect(replace).toHaveBeenCalledWith("Ticket", { id: TICKET_ID, tab: "status" }));
    expect(list).toHaveBeenCalledTimes(1);
  });

  test("errore qualunque: il ticket", async () => {
    const list = jest.fn().mockRejectedValue(new Error("network down"));
    const { replace } = await renderScreen(makeClient(list), { jobId: JOB_ID, ticketId: TICKET_ID });
    await waitFor(() => expect(replace).toHaveBeenCalledWith("Ticket", { id: TICKET_ID, tab: "status" }));
  });

  test("senza client (sessione appena chiusa): niente skeleton infinito, il ticket", async () => {
    const { replace } = await renderScreen(null, { jobId: JOB_ID, ticketId: TICKET_ID });
    await waitFor(() => expect(replace).toHaveBeenCalledWith("Ticket", { id: TICKET_ID, tab: "status" }));
  });

  test("nessuna sessione e nessun ticket: indietro", async () => {
    const list = jest.fn().mockResolvedValue({ live: [], recent: [] });
    const { replace, goBack, navigate, dispatch } = await renderScreen(makeClient(list), { jobId: JOB_ID });
    await waitFor(() => expect(goBack).toHaveBeenCalledTimes(1));
    expect(replace).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
  });

  /**
   * Fix round 1 (review A1, Minor 2): come la card, si decide solo a schermata
   * a fuoco. Chi cambia scheda mentre la ricerca è in corso non si ritrova la
   * sessione aperta sopra l'altra scheda; al ritorno, la decisione si prende.
   */
  /**
   * La ricerca che risponde DOPO l'apertura, a schermata a fuoco o no. Le due
   * varianti fanno la STESSA sequenza e lo stesso passo di sincronizzazione
   * (`settleQueries`): quella a fuoco prova che al ritorno di quel passo la
   * navigazione, se deve partire, è GIÀ partita — senza, il negativo qui sotto
   * passerebbe anche guardando troppo presto.
   */
  async function lateLookup(focused: boolean) {
    let resolve: (value: unknown) => void = () => {};
    const list = jest.fn(() => new Promise((r) => (resolve = r)));
    const r = await renderScreen(makeClient(list), { jobId: JOB_ID, ticketId: TICKET_ID });
    await waitFor(() => expect(list).toHaveBeenCalledTimes(1));
    if (!focused) await r.setFocused(false);
    await act(async () => {
      resolve({ live: [{ id: "s-live" }], recent: [] });
    });
    await settleQueries(r.queryClient);
    return r;
  }

  test("controllo: la ricerca risponde a schermata a fuoco → la sessione, già al ritorno di settleQueries", async () => {
    const r = await lateLookup(true);
    expect(r.navigate).toHaveBeenCalledWith("AgentSession", { id: "s-live", focus: "question" }, { pop: true });
  });

  test("ricerca conclusa a schermata NON a fuoco: nessuna navigazione; al ritorno del fuoco, la sessione", async () => {
    const r = await lateLookup(false);
    expect(r.navigate).not.toHaveBeenCalled();
    expect(r.dispatch).not.toHaveBeenCalled();
    expect(r.replace).not.toHaveBeenCalled();

    await r.setFocused(true);
    await waitFor(() => expect(r.navigate).toHaveBeenCalledWith("AgentSession", { id: "s-live", focus: "question" }, { pop: true }));
    expect(r.navigate).toHaveBeenCalledTimes(1);
  });

  test("lo stesso per il ripiego sul ticket: niente replace finché la schermata non torna a fuoco", async () => {
    const list = jest.fn().mockResolvedValue({ live: [], recent: [] });
    const r = await renderScreen(makeClient(list), { jobId: JOB_ID, ticketId: TICKET_ID }, { focused: false });
    await waitFor(() => expect(list).toHaveBeenCalledTimes(1));
    await settleQueries(r.queryClient);
    expect(r.replace).not.toHaveBeenCalled();
    await r.setFocused(true);
    await waitFor(() => expect(r.replace).toHaveBeenCalledWith("Ticket", { id: TICKET_ID, tab: "status" }));
    expect(r.replace).toHaveBeenCalledTimes(1);
  });
});
