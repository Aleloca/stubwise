import type { StubwiseClient } from "@stubwise/api-client";
import { ApiError } from "@stubwise/api-client";
import NetInfo from "@react-native-community/netinfo";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react-native";
import type { ReactNode } from "react";
import { AuthContext } from "../app/auth-context";
import type { AuthContextValue } from "../app/providers";
import "../i18n";
import { useApprovePlan, useRejectPlan, workKeys } from "./work-mutations";

const TICKET_ID = "11111111-1111-4111-8111-111111111111";

function makeClient(overrides: { approvePlan?: jest.Mock; rejectPlan?: jest.Mock } = {}): StubwiseClient {
  return {
    tickets: {
      approvePlan: overrides.approvePlan ?? jest.fn().mockResolvedValue({ jobId: "job-1" }),
      rejectPlan: overrides.rejectPlan ?? jest.fn().mockResolvedValue({ jobId: "job-1" }),
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
