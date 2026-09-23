import type { StubwiseClient } from "@stubwise/api-client";
import type { InboxItem, InboxPage, Reader } from "@stubwise/shared";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react-native";
import type { ReactNode } from "react";
import { AuthContext } from "../app/auth-context";
import type { AuthContextValue } from "../app/providers";
import "../i18n";
import NetInfo from "@react-native-community/netinfo";
import { inboxKeys, useAnswer, useApprove, useHandled, useSnooze } from "./inbox-mutations";
import { refreshStaleQueries } from "./refresh";
import { backlogKeys, mailKeys, milestoneKeys, projectKeys, projectsPulseKey, ticketKeys, workKeys } from "./query-keys";

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
    // Nessun errore ancora: il rifiuto non è arrivato.
    expect(rendered.result.current.errorMessage).toBeNull();

    // Ora il server rifiuta davvero: ROLLBACK, la riga torna, E l'errore
    // diventa visibile — a differenza di prima del fix del Task 14 (revisione
    // di qualità), dove il rollback avveniva ma nessuna card poteva mostrare
    // perché: sembrava un misclick, non un errore di rete.
    await act(async () => {
      reject(new Error("network down"));
      await promise.catch(() => {});
    });
    await waitFor(() => expect(idsOf(queryClient)).toEqual(["a", "b"]));
    await waitFor(() => expect(rendered.result.current.errorMessage).toBe("Qualcosa è andato storto. Riprova."));

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

    await waitFor(() => expect(idsOf(queryClient)).toEqual(["b"]));
    // Errore assente al successo: `errorMessage` resta `null` per tutto il ciclo.
    expect(rendered.result.current.errorMessage).toBeNull();

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
    expect(rendered.result.current.errorMessage).toBeNull();

    await act(async () => {
      reject(new Error("network down"));
      await promise.catch(() => {});
    });
    await waitFor(() => expect(idsOf(queryClient)).toEqual(["a", "b"]));
    await waitFor(() => expect(rendered.result.current.errorMessage).toBe("Qualcosa è andato storto. Riprova."));

    await rendered.unmount();
  });
});

/**
 * COSA DICHIARANO LE MUTAZIONI DELL'INBOX (23 set 2026, «l'app non resta
 * indietro», design §4). Asserzioni sulle query SEMINATE, non su
 * «`invalidateQueries` è stata chiamata» — quella passerebbe senza
 * raggiungere niente.
 */
describe("le mutazioni dell'inbox dichiarano cosa hanno cambiato", () => {
  function decisionClient(
    inboxAct: jest.Mock = jest.fn().mockResolvedValue({ kind: "job.plan_review", changedNotificationIds: ["a"] }),
  ) {
    return {
      inbox: {
        act: inboxAct,
        answer: jest.fn(),
        handled: jest.fn().mockResolvedValue(undefined),
        snooze: jest.fn().mockResolvedValue({ id: "a", snoozedUntil: "2026-09-24T09:00:00.000Z" }),
      },
    } as unknown as StubwiseClient;
  }

  beforeEach(() => {
    (NetInfo.useNetInfo as jest.Mock).mockReturnValue({ isConnected: true, isInternetReachable: true });
  });

  test("«Fatto» segna scaduto il polso: `waitingForYou` esclude le notifiche gestite", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    queryClient.setQueryData(projectsPulseKey, []);

    const rendered = await renderHook(() => useHandled(), { wrapper: makeWrapper(decisionClient(), queryClient) });
    await act(async () => {
      rendered.result.current.mutate({ id: "a" });
    });

    await waitFor(() => expect(queryClient.getQueryState(projectsPulseKey)?.isInvalidated).toBe(true));
  });

  test("«Rimanda» segna scaduto il polso", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    queryClient.setQueryData(projectsPulseKey, []);

    const rendered = await renderHook(() => useSnooze(), { wrapper: makeWrapper(decisionClient(), queryClient) });
    await act(async () => {
      rendered.result.current.mutate({ id: "a", until: "1h" });
    });

    await waitFor(() => expect(queryClient.getQueryState(projectsPulseKey)?.isInvalidated).toBe(true));
  });

  /**
   * Una decisione è il caso più largo: una conferma può creare un ticket,
   * una voce di backlog o una milestone, e agisce su una NOTIFICA senza
   * sapere quale ticket sia aperto. Tutte e sei le cose si segnano.
   */
  test("una decisione segna scaduti polso, ticket, backlog, milestone, posta e il ticket aperto", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const seeded = [
      projectsPulseKey,
      ticketKeys.hub("p1"),
      backlogKeys.item("b1"),
      milestoneKeys.forProject("p1"),
      mailKeys.threads(),
      workKeys.ticket("t1"),
    ] as const;
    for (const key of seeded) queryClient.setQueryData(key, {});

    const rendered = await renderHook(() => useApprove(), { wrapper: makeWrapper(decisionClient(), queryClient) });
    await act(async () => {
      rendered.result.current.mutate({ id: "a" });
    });

    for (const key of seeded) {
      await waitFor(() => expect(queryClient.getQueryState(key)?.isInvalidated).toBe(true));
    }
  });

  test("anche «Procedi» e le risposte passano di lì: stesso involucro", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    queryClient.setQueryData(projectsPulseKey, []);

    const rendered = await renderHook(() => useAnswer(), { wrapper: makeWrapper(decisionClient(), queryClient) });
    await act(async () => {
      rendered.result.current.mutate({ id: "a", body: { optionIndex: 0 } });
    });

    await waitFor(() => expect(queryClient.getQueryState(projectsPulseKey)?.isInvalidated).toBe(true));
  });

  /** ⚠️ La chiave vera del polso, non tutto `["projects"]`. */
  test("una decisione NON invalida il dettaglio dei progetti", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    queryClient.setQueryData(projectsPulseKey, []);
    queryClient.setQueryData(projectKeys.detail("p1"), {});

    const rendered = await renderHook(() => useApprove(), { wrapper: makeWrapper(decisionClient(), queryClient) });
    await act(async () => {
      rendered.result.current.mutate({ id: "a" });
    });

    await waitFor(() => expect(queryClient.getQueryState(projectsPulseKey)?.isInvalidated).toBe(true));
    expect(queryClient.getQueryState(projectKeys.detail("p1"))?.isInvalidated).toBe(false);
  });
});

/**
 * ⚠️ IL RICARICAMENTO AL RITORNO NON ANNULLA UN «FATTO» IN CORSO (23 set
 * 2026, design §6).
 *
 * `onMutate` chiama `cancelQueries` sulla lista — ma quella annulla solo le
 * richieste GIÀ in volo in quel momento. Qui il ricaricamento parte DOPO,
 * mentre il server non ha ancora risposto al «Fatto» (il caso di chi preme e
 * torna subito indietro): la lista montata è scaduta, e il server finto
 * risponde ancora con la riga — come farebbe quello vero, che il «Fatto» non
 * l'ha ancora visto. Senza il gate in `refreshStaleQueries` la riga
 * ricomparirebbe.
 */
describe("un «Fatto» ottimistico resiste al ricaricamento globale", () => {
  test("tornando indietro mentre il server risponde, la riga resta tolta", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const handled = deferred<void>();
    const client = {
      inbox: {
        // Il server che non ha ancora visto il «Fatto»: la riga c'è ancora.
        list: jest.fn().mockResolvedValue({ items: [ITEM_A, ITEM_B], nextCursor: null }),
        handled: jest.fn().mockReturnValue(handled.promise),
      },
    } as unknown as StubwiseClient;

    const rendered = await renderHook(
      () => {
        // La lista MONTATA, come sulla schermata dell'inbox.
        useQuery({ queryKey: inboxKeys.list(), queryFn: () => client.inbox.list() });
        return useHandled();
      },
      { wrapper: makeWrapper(client, queryClient) },
    );
    await waitFor(() => expect(idsOf(queryClient)).toEqual(["a", "b"]));

    await act(async () => {
      rendered.result.current.mutate({ id: "a" });
    });
    await waitFor(() => expect(idsOf(queryClient)).toEqual(["b"]));

    // Il ricaricamento del ritorno su una schermata, mentre il server tace.
    await act(async () => {
      await refreshStaleQueries(queryClient);
    });
    expect(idsOf(queryClient)).toEqual(["b"]);
    expect(client.inbox.list).toHaveBeenCalledTimes(1);

    // Il server risponde: la mutazione invalida da sé, e il ricaricamento
    // avviene adesso — al momento giusto.
    (client.inbox.list as jest.Mock).mockResolvedValue({ items: [ITEM_B], nextCursor: null });
    await act(async () => {
      handled.resolve();
    });
    await waitFor(() => expect(client.inbox.list).toHaveBeenCalledTimes(2));
    expect(idsOf(queryClient)).toEqual(["b"]);
  });
});
