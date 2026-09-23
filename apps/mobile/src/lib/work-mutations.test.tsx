import type { StubwiseClient } from "@stubwise/api-client";
import { ApiError } from "@stubwise/api-client";
import NetInfo from "@react-native-community/netinfo";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react-native";
import type { ReactNode } from "react";
import { AuthContext } from "../app/auth-context";
import type { AuthContextValue } from "../app/providers";
import "../i18n";
import { milestoneKeys, ticketKeys } from "./query-keys";
import { useApprovePlan, usePatchTicket, useRejectPlan, workKeys } from "./work-mutations";

const TICKET_ID = "11111111-1111-4111-8111-111111111111";

function makeClient(
  overrides: { approvePlan?: jest.Mock; rejectPlan?: jest.Mock; patch?: jest.Mock } = {},
): StubwiseClient {
  return {
    tickets: {
      approvePlan: overrides.approvePlan ?? jest.fn().mockResolvedValue({ jobId: "job-1" }),
      rejectPlan: overrides.rejectPlan ?? jest.fn().mockResolvedValue({ jobId: "job-1" }),
      patch: overrides.patch ?? jest.fn().mockResolvedValue({ id: TICKET_ID }),
    },
  } as unknown as StubwiseClient;
}

function makeWrapper(client: StubwiseClient, queryClient: QueryClient) {
  const authValue: AuthContextValue = {
    status: "authenticated",
    client,
    user: { id: "u1", email: "a@example.com", role: "admin", language: "it", avatarUrl: null, slackUserId: null },
    justLoggedIn: false,
    login: jest.fn(),
    completeOnboarding: jest.fn(),
    openSettings: jest.fn(),
    loggedOut: jest.fn(),
  };
  return function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>
        <AuthContext.Provider value={authValue}>{children}</AuthContext.Provider>
      </QueryClientProvider>
    );
  };
}

beforeEach(() => {
  (NetInfo.useNetInfo as jest.Mock).mockReturnValue({ isConnected: true, isInternetReachable: true });
});

describe("useApprovePlan", () => {
  test("chiama client.tickets.approvePlan col ticketId e invalida le query del lavoro", async () => {
    const approvePlan = jest.fn().mockResolvedValue({ jobId: "job-1" });
    const client = makeClient({ approvePlan });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidateSpy = jest.spyOn(queryClient, "invalidateQueries");

    const rendered = await renderHook(() => useApprovePlan(TICKET_ID), { wrapper: makeWrapper(client, queryClient) });
    await act(async () => {
      rendered.result.current.mutate();
    });

    await waitFor(() => expect(approvePlan).toHaveBeenCalledWith(TICKET_ID));
    await waitFor(() => expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: workKeys.all(TICKET_ID) }));
  });

  test("errore plan_not_pending: messaggio localizzato", async () => {
    const approvePlan = jest.fn().mockRejectedValue(new ApiError(409, "No plan pending", "plan_not_pending"));
    const client = makeClient({ approvePlan });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    const rendered = await renderHook(() => useApprovePlan(TICKET_ID), { wrapper: makeWrapper(client, queryClient) });
    await act(async () => {
      rendered.result.current.mutate();
    });

    await waitFor(() =>
      expect(rendered.result.current.errorMessage).toBe("Il piano non è più in attesa di approvazione."),
    );
  });

  test("409 (un altro maintainer ha già deciso): invalida workKeys.all, non lascia la UI su uno stato stantio", async () => {
    const approvePlan = jest.fn().mockRejectedValue(new ApiError(409, "No plan pending", "plan_not_pending"));
    const client = makeClient({ approvePlan });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidateSpy = jest.spyOn(queryClient, "invalidateQueries");
    // Seme nella cache, così `invalidateQueries` ha una query VERA da marcare
    // (senza una entry preesistente non c'è nulla da invalidare, e il test
    // non proverebbe niente): stessa chiave che `WorkScreen` popola davvero.
    queryClient.setQueryData(workKeys.ticket(TICKET_ID), { status: "awaiting_plan_approval" });

    const rendered = await renderHook(() => useApprovePlan(TICKET_ID), { wrapper: makeWrapper(client, queryClient) });
    await act(async () => {
      rendered.result.current.mutate();
    });

    await waitFor(() => expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: workKeys.all(TICKET_ID) }));
    await waitFor(() =>
      expect(queryClient.getQueryState(workKeys.ticket(TICKET_ID))?.isInvalidated).toBe(true),
    );
    await waitFor(() => expect(rendered.result.current.isPending).toBe(false));
  });

  test("offline: disabled è true", async () => {
    (NetInfo.useNetInfo as jest.Mock).mockReturnValue({ isConnected: false, isInternetReachable: false });
    const client = makeClient();
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    const rendered = await renderHook(() => useApprovePlan(TICKET_ID), { wrapper: makeWrapper(client, queryClient) });
    expect(rendered.result.current.disabled).toBe(true);
    expect(rendered.result.current.online).toBe(false);
  });
});

describe("useRejectPlan", () => {
  test("chiama client.tickets.rejectPlan con le istruzioni opzionali", async () => {
    const rejectPlan = jest.fn().mockResolvedValue({ jobId: "job-1" });
    const client = makeClient({ rejectPlan });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    const rendered = await renderHook(() => useRejectPlan(TICKET_ID), { wrapper: makeWrapper(client, queryClient) });
    await act(async () => {
      rendered.result.current.mutate("Usa la CDN che abbiamo già");
    });

    await waitFor(() =>
      expect(rejectPlan).toHaveBeenCalledWith(TICKET_ID, { instructions: "Usa la CDN che abbiamo già" }),
    );
    // Aspetta che la mutazione si assesti del tutto (onSuccess incluso) prima
    // che il test finisca: altrimenti l'`invalidateQueries` schedulato può
    // scattare durante il RENDER DEL FILE DI TEST SUCCESSIVO nello stesso
    // worker Jest, con un warning "update… not wrapped in act" fuori contesto.
    await waitFor(() => expect(rendered.result.current.isPending).toBe(false));
  });

  test("409 (un altro maintainer ha già deciso): invalida workKeys.all anche sul rifiuto", async () => {
    const rejectPlan = jest.fn().mockRejectedValue(new ApiError(409, "No plan pending", "plan_not_pending"));
    const client = makeClient({ rejectPlan });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    queryClient.setQueryData(workKeys.ticket(TICKET_ID), { status: "awaiting_plan_approval" });

    const rendered = await renderHook(() => useRejectPlan(TICKET_ID), { wrapper: makeWrapper(client, queryClient) });
    await act(async () => {
      rendered.result.current.mutate(undefined);
    });

    await waitFor(() =>
      expect(queryClient.getQueryState(workKeys.ticket(TICKET_ID))?.isInvalidated).toBe(true),
    );
    await waitFor(() => expect(rendered.result.current.isPending).toBe(false));
  });

  test("senza istruzioni: il corpo è undefined", async () => {
    const rejectPlan = jest.fn().mockResolvedValue({ jobId: "job-1" });
    const client = makeClient({ rejectPlan });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    const rendered = await renderHook(() => useRejectPlan(TICKET_ID), { wrapper: makeWrapper(client, queryClient) });
    await act(async () => {
      rendered.result.current.mutate(undefined);
    });

    await waitFor(() => expect(rejectPlan).toHaveBeenCalledWith(TICKET_ID, undefined));
    await waitFor(() => expect(rendered.result.current.isPending).toBe(false));
  });
});

/**
 * ⚠️ OGNI azione su un ticket CAMBIA un ticket, e finché non lo diceva
 * nessun ELENCO se ne accorgeva (22 set 2026, tappa 2 dell'hub).
 * `workKeys.all(ticketId)` è per-ticket (`["work", id]`): non raggiunge
 * l'anteprima dell'hub né la schermata dei ticket del progetto, che vivono
 * sotto `["tickets"]` — e quelle schermate restano MONTATE sotto nello stack
 * nativo mentre si è sul Lavoro.
 *
 * Le asserzioni sono sulle query SEMINATE e non su «`invalidateQueries` è
 * stata chiamata»: quella passerebbe senza raggiungere niente.
 */
describe("le mutazioni sul ticket dichiarano cosa hanno cambiato", () => {
  test("un'azione sul ticket invalida anche le viste dei ticket", async () => {
    const client = makeClient();
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const hubKey = ticketKeys.hub("22222222-2222-4222-8222-222222222222");
    queryClient.setQueryData(hubKey, { items: [], nextCursor: null, total: 3 });

    const rendered = await renderHook(() => useApprovePlan(TICKET_ID), { wrapper: makeWrapper(client, queryClient) });
    await act(async () => {
      rendered.result.current.mutate(undefined);
    });

    await waitFor(() => expect(queryClient.getQueryState(hubKey)?.isInvalidated).toBe(true));
  });

  /**
   * ⚠️ Spostare un ticket da una milestone a un'altra ne cambia i CONTEGGI,
   * che la roadmap mostra come avanzamento — e la roadmap non sa niente di
   * questa mutazione, né deve.
   */
  test("cambiare la milestone di un ticket invalida anche le milestone", async () => {
    const client = makeClient();
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const roadmapKey = milestoneKeys.forProject("22222222-2222-4222-8222-222222222222");
    queryClient.setQueryData(roadmapKey, []);

    const rendered = await renderHook(() => usePatchTicket(TICKET_ID), { wrapper: makeWrapper(client, queryClient) });
    await act(async () => {
      rendered.result.current.mutate({ milestoneId: "33333333-3333-4333-8333-333333333333" });
    });

    await waitFor(() => expect(queryClient.getQueryState(roadmapKey)?.isInvalidated).toBe(true));
  });

  /**
   * ⚠️ E SOLO quando le tocca: cambiare un'etichetta non sposta nessun
   * ticket fra milestone, e rileggerle a ogni modifica sarebbe lavoro che
   * nessuno ha chiesto. Senza questa asserzione l'invalidazione potrebbe
   * diventare incondizionata senza che niente lo dica.
   */
  test("una patch che NON tocca la milestone non le invalida", async () => {
    const client = makeClient();
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const roadmapKey = milestoneKeys.forProject("22222222-2222-4222-8222-222222222222");
    queryClient.setQueryData(roadmapKey, []);

    const rendered = await renderHook(() => usePatchTicket(TICKET_ID), { wrapper: makeWrapper(client, queryClient) });
    await act(async () => {
      rendered.result.current.mutate({ labels: ["urgente"] });
    });

    await waitFor(() => expect(rendered.result.current.isPending).toBe(false));
    expect(queryClient.getQueryState(roadmapKey)?.isInvalidated).toBe(false);
  });
});
