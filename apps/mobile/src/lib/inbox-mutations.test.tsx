import type { StubwiseClient } from "@stubwise/api-client";
import type { InboxItem, InboxPage, Reader } from "@stubwise/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react-native";
import type { ReactNode } from "react";
import { AuthContext } from "../app/auth-context";
import type { AuthContextValue } from "../app/providers";
import { inboxKeys, useHandled, useSnooze } from "./inbox-mutations";

/**
 * Copertura dedicata di `useSnooze`/`useHandled` (Step 1 del piano: "snooze
 * ottimistico: la card sparisce subito e torna se la mutazione fallisce").
 *
 * Vive a livello di HOOK — non dentro `InboxScreen.test.tsx` — di proposito:
 * `InboxScreen` monta un `useQuery` ATTIVO sulla stessa chiave
 * (`inboxKeys.list()`), e `onSettled` invalida quella chiave a ogni esito
 * (successo O fallimento). Su una query con un observer attivo, invalidare fa
 * scattare un REFETCH automatico — che con un `client.inbox.list()` mockato a
 * mano tornerebbe a mostrare (o nascondere) la riga indipendentemente dal
 * rollback vero, mascherando esattamente il comportamento che questo test
 * deve provare. Qui non c'è nessun `useQuery` montato sulla lista — solo la
 * mutazione — quindi `invalidateQueries` marca la chiave stale ma non
 * rifetcha nulla (nessun observer attivo da soddisfare): l'unica cosa che
 * può cambiare `queryClient.getQueryData(inboxKeys.list())` fra un
 * `mutate()` e la sua risoluzione è `onMutate`/`onError`, cioè esattamente la
 * logica sotto esame.
 */

function item(overrides: Partial<Reader<InboxItem>> & Pick<InboxItem, "id" | "kind">): Reader<InboxItem> {
  return {
    status: "open",
    text: "Testo dell'evento",
    actions: [],
    projectId: null,
    ticketId: null,
    jobId: null,
    createdAt: "2026-09-02T09:48:00.000Z",
    readAt: null,
    snoozedUntil: null,
    handledAt: null,
    handledBy: null,
    ...overrides,
  } as Reader<InboxItem>;
}

const ITEM_A = item({ id: "a", kind: "job.failed", text: "Riga A", actions: ["relaunch", "snooze", "handled"] });
const ITEM_B = item({ id: "b", kind: "ticket.created", text: "Riga B", actions: ["open", "snooze", "handled"] });

/** Una promise controllata a mano: cattura lo stato INTERMEDIO fra `onMutate` e la risoluzione, non solo l'esito finale. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (reason?: unknown) => void } {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function idsOf(queryClient: QueryClient): string[] | undefined {
  return queryClient.getQueryData<Reader<InboxPage>>(inboxKeys.list())?.items.map((row) => row.id);
}

function makeWrapper(client: StubwiseClient, queryClient: QueryClient) {
  const authValue: AuthContextValue = {
    status: "authenticated",
    client,
    user: null,
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

describe("useSnooze — ottimismo con rollback", () => {
  test("rimuove SUBITO la riga dalla cache (prima che il server risponda), e la ripristina se la mutazione fallisce", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    queryClient.setQueryData(inboxKeys.list(), { items: [ITEM_A, ITEM_B], nextCursor: null });

    const { promise, reject } = deferred<{ snoozedUntil: string | null }>();
    const snooze = jest.fn().mockReturnValue(promise);
    const client = { inbox: { snooze } } as unknown as StubwiseClient;

    const rendered = await renderHook(() => useSnooze(), { wrapper: makeWrapper(client, queryClient) });

    await act(async () => {
      rendered.result.current.mutate({ id: "a", until: "1h" });
    });

    // OTTIMISTICO: la riga "a" sparisce SUBITO — la promise del server è
    // ancora appesa, `reject`/`resolve` non sono stati chiamati.
    await waitFor(() => expect(idsOf(queryClient)).toEqual(["b"]));
    expect(snooze).toHaveBeenCalledWith("a", "1h");

    // Ora il server rifiuta davvero: ROLLBACK, la riga torna.
    await act(async () => {
      reject(new Error("network down"));
      await promise.catch(() => {});
    });
    await waitFor(() => expect(idsOf(queryClient)).toEqual(["a", "b"]));

    await rendered.unmount();
  });

  test("al successo la riga resta rimossa (nessun rollback)", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    queryClient.setQueryData(inboxKeys.list(), { items: [ITEM_A, ITEM_B], nextCursor: null });

    const client = { inbox: { snooze: jest.fn().mockResolvedValue({ snoozedUntil: "2026-09-02T10:48:00.000Z" }) } } as unknown as StubwiseClient;
    const rendered = await renderHook(() => useSnooze(), { wrapper: makeWrapper(client, queryClient) });

    await act(async () => {
      rendered.result.current.mutate({ id: "a", until: "1h" });
    });

    await waitFor(() => expect(rendered.result.current.isSuccess).toBe(true));
    expect(idsOf(queryClient)).toEqual(["b"]);

    await rendered.unmount();
  });
});

describe("useHandled — ottimismo con rollback", () => {
  test("rimuove SUBITO la riga dalla cache, e la ripristina se la mutazione fallisce", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    queryClient.setQueryData(inboxKeys.list(), { items: [ITEM_A, ITEM_B], nextCursor: null });

    const { promise, reject } = deferred<void>();
    const handled = jest.fn().mockReturnValue(promise);
    const client = { inbox: { handled } } as unknown as StubwiseClient;

    const rendered = await renderHook(() => useHandled(), { wrapper: makeWrapper(client, queryClient) });

    await act(async () => {
      rendered.result.current.mutate({ id: "b" });
    });

    await waitFor(() => expect(idsOf(queryClient)).toEqual(["a"]));
    expect(handled).toHaveBeenCalledWith("b");

    await act(async () => {
      reject(new Error("network down"));
      await promise.catch(() => {});
    });
    await waitFor(() => expect(idsOf(queryClient)).toEqual(["a", "b"]));

    await rendered.unmount();
  });
});
