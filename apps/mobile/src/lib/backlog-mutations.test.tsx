import type { StubwiseClient } from "@stubwise/api-client";
import { ApiError } from "@stubwise/api-client";
import type { BacklogItem, Reader } from "@stubwise/shared";
import NetInfo from "@react-native-community/netinfo";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react-native";
import type { ReactNode } from "react";
import { AuthContext } from "../app/auth-context";
import type { AuthContextValue } from "../app/providers";
import "../i18n";
import { backlogKeys, mergeBacklogPages, useConvertBacklogItem } from "./backlog-mutations";

const ITEM_ID = "22222222-2222-4222-8222-222222222222";
const TICKET_ID = "33333333-3333-4333-8333-333333333333";

function makeClient(overrides: { convert?: jest.Mock } = {}): StubwiseClient {
  return {
    backlog: {
      convert: overrides.convert ?? jest.fn().mockResolvedValue({ ticketId: TICKET_ID, ticketNumber: 42 }),
      list: jest.fn(),
      get: jest.fn(),
      create: jest.fn(),
      chat: jest.fn(),
      chatText: jest.fn(),
    },
  } as unknown as StubwiseClient;
}

function makeWrapper(client: StubwiseClient, queryClient: QueryClient) {
  const authValue: AuthContextValue = {
    status: "authenticated",
    client,
    user: { id: "u1", email: "a@example.com", role: "member", language: "it", avatarUrl: null, slackUserId: null },
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

describe("useConvertBacklogItem", () => {
  test("chiama client.backlog.convert con l'id e invalida backlogKeys.all al successo", async () => {
    const convert = jest.fn().mockResolvedValue({ ticketId: TICKET_ID, ticketNumber: 42 });
    const client = makeClient({ convert });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidateSpy = jest.spyOn(queryClient, "invalidateQueries");

    const rendered = await renderHook(() => useConvertBacklogItem(), { wrapper: makeWrapper(client, queryClient) });
    await act(async () => {
      rendered.result.current.mutate(ITEM_ID);
    });

    await waitFor(() => expect(convert).toHaveBeenCalledWith(ITEM_ID));
    await waitFor(() => expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: backlogKeys.all }));
  });

  // Il caso reale: "Procedi" su una voce che un altro utente ha appena
  // convertito/archiviato mentre la card era ancora ferma su `ready` in
  // questo device — il server risponde 409 (`not_convertible`/
  // `already_converted`), e la lista/il dettaglio in cache vanno invalidati
  // così la card stantia sparisce/aggiorna al prossimo refetch invece di
  // restare bloccata con "Procedi" ancora attivo (stesso principio di
  // `usePlanDecision` in `work-mutations.ts` — vedi il test gemello lì).
  test("409 (already_converted): invalida backlogKeys.all, non lascia la UI su uno stato stantio", async () => {
    const convert = jest.fn().mockRejectedValue(new ApiError(409, "Already converted", "already_converted"));
    const client = makeClient({ convert });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidateSpy = jest.spyOn(queryClient, "invalidateQueries");
    // Seme nella cache, così `invalidateQueries` ha una query VERA da
    // marcare — senza una entry preesistente non ci sarebbe nulla da
    // invalidare, e il test non proverebbe niente.
    queryClient.setQueryData(backlogKeys.list("ready", undefined), [{ id: ITEM_ID, status: "ready" }]);

    const rendered = await renderHook(() => useConvertBacklogItem(), { wrapper: makeWrapper(client, queryClient) });
    await act(async () => {
      rendered.result.current.mutate(ITEM_ID);
    });

    await waitFor(() => expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: backlogKeys.all }));
    await waitFor(() =>
      expect(queryClient.getQueryState(backlogKeys.list("ready", undefined))?.isInvalidated).toBe(true),
    );
    await waitFor(() => expect(rendered.result.current.errorMessage).toBe("Questa voce è già stata convertita."));
    await waitFor(() => expect(rendered.result.current.isPending).toBe(false));
  });

  test("409 (not_convertible): messaggio localizzato dedicato", async () => {
    const convert = jest.fn().mockRejectedValue(new ApiError(409, "Not convertible", "not_convertible"));
    const client = makeClient({ convert });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    const rendered = await renderHook(() => useConvertBacklogItem(), { wrapper: makeWrapper(client, queryClient) });
    await act(async () => {
      rendered.result.current.mutate(ITEM_ID);
    });

    await waitFor(() => expect(rendered.result.current.errorMessage).toBe("Questa voce non può essere convertita."));
  });

  test("offline: disabled è true, convert non viene chiamato", async () => {
    (NetInfo.useNetInfo as jest.Mock).mockReturnValue({ isConnected: false, isInternetReachable: false });
    const convert = jest.fn();
    const client = makeClient({ convert });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    const rendered = await renderHook(() => useConvertBacklogItem(), { wrapper: makeWrapper(client, queryClient) });
    expect(rendered.result.current.disabled).toBe(true);
    expect(rendered.result.current.online).toBe(false);
    expect(convert).not.toHaveBeenCalled();
  });

  test("onSuccess per-call: riceve il risultato (ticketId/ticketNumber) per la navigazione al Lavoro", async () => {
    const convert = jest.fn().mockResolvedValue({ ticketId: TICKET_ID, ticketNumber: 42 });
    const client = makeClient({ convert });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const onSuccess = jest.fn();

    const rendered = await renderHook(() => useConvertBacklogItem(), { wrapper: makeWrapper(client, queryClient) });
    await act(async () => {
      rendered.result.current.mutate(ITEM_ID, { onSuccess });
    });

    // react-query passa (data, variables, context) all'onSuccess per-call:
    // ci interessa solo il primo argomento (il risultato del server).
    await waitFor(() => expect(onSuccess.mock.calls[0]?.[0]).toEqual({ ticketId: TICKET_ID, ticketNumber: 42 }));
  });
});

function item(overrides: Partial<Reader<BacklogItem>> = {}): Reader<BacklogItem> {
  return {
    id: "item-1",
    projectId: "proj-1",
    title: "Voce",
    status: "ready",
    effort: 3,
    risk: "low",
    riskNote: null,
    urgency: "high",
    requestCount: 1,
    source: "manual",
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    similarTo: null,
    ticketCount: 0,
    ...overrides,
  } as Reader<BacklogItem>;
}

describe("mergeBacklogPages — chip 'Tutti' (nessun filtro server equivalente, unione client-side)", () => {
  test("dedup: la STESSA voce in due pagine (finestra della Promise.all: cambia stato durante le 3 chiamate) compare una sola volta", () => {
    const activePage = [item({ id: "a", title: "Attiva", status: "ready", updatedAt: "2026-08-01T00:00:00.000Z" })];
    // Stessa voce "a" appena convertita: arriva ANCHE nella risposta
    // `status=converted`, con un `updatedAt` più recente (la conversione
    // tocca la riga) — la versione da tenere è quella più fresca.
    const convertedPage = [item({ id: "a", title: "Attiva", status: "converted", updatedAt: "2026-08-01T00:05:00.000Z" })];

    const merged = mergeBacklogPages([activePage, convertedPage]);

    expect(merged).toHaveLength(1);
    expect(merged[0]!.status).toBe("converted");
  });

  test("ordina per updatedAt DECRESCENTE, indipendentemente da quale pagina arriva prima", () => {
    const older = item({ id: "old", updatedAt: "2026-08-01T00:00:00.000Z" });
    const newer = item({ id: "new", updatedAt: "2026-08-03T00:00:00.000Z" });
    const middle = item({ id: "mid", updatedAt: "2026-08-02T00:00:00.000Z" });

    const merged = mergeBacklogPages([[older], [newer], [middle]]);

    expect(merged.map((i) => i.id)).toEqual(["new", "mid", "old"]);
  });

  test("pagine vuote non producono voci fantasma", () => {
    expect(mergeBacklogPages([[], [], []])).toEqual([]);
  });
});
