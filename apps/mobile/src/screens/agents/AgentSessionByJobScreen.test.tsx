import { ApiError, type StubwiseClient } from "@stubwise/api-client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react-native";
import { AuthContext } from "../../app/auth-context";
import type { AuthContextValue } from "../../app/providers";
import "../../i18n";
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

async function renderScreen(client: StubwiseClient | null, params: { jobId: string; ticketId?: string }) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  clients.push(queryClient);
  const replace = jest.fn();
  const goBack = jest.fn();
  const navigate = jest.fn();
  const pop = jest.fn();
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
        <AgentSessionByJobScreen
          navigation={{ replace, goBack, navigate, pop } as never}
          route={{ key: "AgentSessionByJob", name: "AgentSessionByJob", params } as never}
        />
      </AuthContext.Provider>
    </QueryClientProvider>,
  );
  return { replace, goBack, navigate, pop };
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
    await waitFor(() => expect(r.navigate).toHaveBeenCalledWith("AgentSession", { id: "s-live", focus: "question" }));
    expect(r.pop).toHaveBeenCalledTimes(1);
    expect(r.replace).not.toHaveBeenCalled();
    expect(list).toHaveBeenCalledWith({ aiJobId: JOB_ID });
  });

  test("solo una conclusa: quella", async () => {
    const list = jest.fn().mockResolvedValue({ live: [], recent: [{ id: "s-old" }] });
    const r = await renderScreen(makeClient(list), { jobId: JOB_ID, ticketId: TICKET_ID });
    // La sessione sta sul ROOT stack (Task A1): si apre lassù e questa
    // schermata esce dal suo stack — un `replace` qui sostituirebbe `Main`.
    await waitFor(() => expect(r.navigate).toHaveBeenCalledWith("AgentSession", { id: "s-old", focus: "question" }));
    expect(r.pop).toHaveBeenCalledTimes(1);
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
    const { replace, goBack, navigate, pop } = await renderScreen(makeClient(list), { jobId: JOB_ID });
    await waitFor(() => expect(goBack).toHaveBeenCalledTimes(1));
    expect(replace).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
    expect(pop).not.toHaveBeenCalled();
  });
});
