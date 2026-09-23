import { focusManager, QueryClient, QueryObserver } from "@tanstack/react-query";
import { waitFor } from "@testing-library/react-native";
import { AppState } from "react-native";
import { queryClient as appQueryClient, subscribeAppFocus } from "../app/providers";
import { canRefreshNow, refreshStaleQueries } from "./refresh";

/**
 * Le regole del ricaricamento GLOBALE (23 set 2026, «l'app non resta
 * indietro»). Le query sono MONTATE con un `QueryObserver` vero — «montata»
 * è metà della condizione — e il server è un `jest.fn()` che si conta.
 */

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function mount(queryClient: QueryClient, key: string, staleTime: number, fn: jest.Mock) {
  const observer = new QueryObserver(queryClient, { queryKey: [key], queryFn: fn, staleTime, retry: false });
  const unsubscribe = observer.subscribe(() => undefined);
  return unsubscribe;
}

describe("refreshStaleQueries — il ritorno su una schermata", () => {
  test("ricarica una query montata e SCADUTA", async () => {
    const queryClient = new QueryClient();
    const fetch = jest.fn().mockResolvedValue(1);
    const unmount = mount(queryClient, "scaduta", 0, fetch);
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));

    await refreshStaleQueries(queryClient);
    expect(fetch).toHaveBeenCalledTimes(2);
    unmount();
  });

  test("NON ricarica una query ancora fresca", async () => {
    const queryClient = new QueryClient();
    const fetch = jest.fn().mockResolvedValue(1);
    const unmount = mount(queryClient, "fresca", 60_000, fetch);
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));

    await refreshStaleQueries(queryClient);
    expect(fetch).toHaveBeenCalledTimes(1);
    unmount();
  });

  test("NON ricarica una query non montata: nessuno la sta guardando", async () => {
    const queryClient = new QueryClient();
    const fetch = jest.fn().mockResolvedValue(1);
    await queryClient.fetchQuery({ queryKey: ["smontata"], queryFn: fetch });

    await refreshStaleQueries(queryClient);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  /**
   * ⚠️ Una query con dati che si sta GIÀ ricaricando (il suo intervallo, o
   * un'invalidazione appena partita), e nello stesso istante cambia la
   * navigazione. Col default di `refetchQueries` quella richiesta verrebbe
   * annullata e rifatta.
   *
   * La query deve avere GIÀ dei dati: senza, TanStack riusa comunque la
   * richiesta in volo, e il test passerebbe anche senza la regola — era la
   * prima versione di questo test, verde per il motivo sbagliato.
   */
  test("riusa la richiesta già in volo invece di rifarla", async () => {
    const queryClient = new QueryClient();
    const pending = deferred<number>();
    const fetch = jest.fn().mockResolvedValueOnce(1).mockReturnValueOnce(pending.promise).mockResolvedValue(3);
    const observer = new QueryObserver(queryClient, { queryKey: ["in-volo"], queryFn: fetch, staleTime: 0, retry: false });
    const unmount = observer.subscribe(() => undefined);
    await waitFor(() => expect(observer.getCurrentResult().data).toBe(1));

    const refetching = observer.refetch();
    expect(fetch).toHaveBeenCalledTimes(2);

    const refreshing = refreshStaleQueries(queryClient);
    pending.resolve(2);
    await Promise.all([refetching, refreshing]);
    expect(fetch).toHaveBeenCalledTimes(2);
    unmount();
  });

  /**
   * ⚠️ Il caso del §6 del design: una mutazione è in corso (un «Fatto»
   * ottimistico che aspetta il server). Un ricaricamento adesso chiederebbe la
   * lista a un server che il «Fatto» non l'ha ancora visto, e la riga tolta
   * ricomparirebbe. La mutazione invaliderà da sé quando finisce.
   */
  test("NON ricarica mentre una mutazione è in corso", async () => {
    const queryClient = new QueryClient();
    const fetch = jest.fn().mockResolvedValue(1);
    const unmount = mount(queryClient, "durante-mutazione", 0, fetch);
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));

    const mutation = deferred<void>();
    void queryClient
      .getMutationCache()
      .build(queryClient, { mutationFn: () => mutation.promise })
      .execute(undefined);
    await waitFor(() => expect(canRefreshNow(queryClient)).toBe(false));

    await refreshStaleQueries(queryClient);
    expect(fetch).toHaveBeenCalledTimes(1);

    mutation.resolve();
    await waitFor(() => expect(canRefreshNow(queryClient)).toBe(true));
    await refreshStaleQueries(queryClient);
    expect(fetch).toHaveBeenCalledTimes(2);
    unmount();
  });
});

/**
 * IL RITORNO IN PRIMO PIANO: `subscribeAppFocus` collega `focusManager` ad
 * `AppState`. Si fa scattare il listener `AppState` vero che registra, e si
 * guarda cosa succede alle query.
 */
describe("subscribeAppFocus — il ritorno in primo piano", () => {
  const mockAddEventListener = AppState.addEventListener as jest.Mock;

  function appStateListener(): (status: string) => void {
    const call = [...mockAddEventListener.mock.calls].reverse().find(([event]) => event === "change");
    return call![1] as (status: string) => void;
  }

  beforeEach(() => {
    mockAddEventListener.mockReturnValue({ remove: jest.fn() });
    focusManager.setEventListener(subscribeAppFocus);
  });

  test("background → attiva: una query scaduta si ricarica, una fresca no", async () => {
    const queryClient = new QueryClient();
    queryClient.mount();
    const stale = jest.fn().mockResolvedValue(1);
    const fresh = jest.fn().mockResolvedValue(1);
    const unmountStale = mount(queryClient, "fg-scaduta", 0, stale);
    const unmountFresh = mount(queryClient, "fg-fresca", 60_000, fresh);
    await waitFor(() => expect(stale).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(fresh).toHaveBeenCalledTimes(1));

    const listener = appStateListener();
    listener("background");
    listener("active");

    await waitFor(() => expect(stale).toHaveBeenCalledTimes(2));
    expect(fresh).toHaveBeenCalledTimes(1);
    unmountStale();
    unmountFresh();
    queryClient.unmount();
  });

  /**
   * ⚠️ Lo stesso gate del ritorno su una schermata, sul `QueryClient` VERO
   * dell'app (`refetchOnWindowFocus` nei suoi default): tornare in primo
   * piano mentre un «Fatto» aspetta il server non deve riportare la riga.
   */
  test("sul client dell'app: niente ricarica al ritorno mentre una mutazione è in corso", async () => {
    appQueryClient.mount();
    const stale = jest.fn().mockResolvedValue(1);
    const unmount = mount(appQueryClient, "fg-durante-mutazione", 0, stale);
    await waitFor(() => expect(stale).toHaveBeenCalledTimes(1));

    const mutation = deferred<void>();
    void appQueryClient
      .getMutationCache()
      .build(appQueryClient, { mutationFn: () => mutation.promise })
      .execute(undefined);
    await waitFor(() => expect(canRefreshNow(appQueryClient)).toBe(false));

    const listener = appStateListener();
    listener("background");
    listener("active");
    await Promise.resolve();
    expect(stale).toHaveBeenCalledTimes(1);

    mutation.resolve();
    await waitFor(() => expect(canRefreshNow(appQueryClient)).toBe(true));
    listener("background");
    listener("active");
    await waitFor(() => expect(stale).toHaveBeenCalledTimes(2));
    unmount();
    appQueryClient.unmount();
  });

  test("andare in background NON ricarica niente", async () => {
    const queryClient = new QueryClient();
    queryClient.mount();
    const stale = jest.fn().mockResolvedValue(1);
    const unmount = mount(queryClient, "bg-scaduta", 0, stale);
    await waitFor(() => expect(stale).toHaveBeenCalledTimes(1));

    appStateListener()("background");
    await Promise.resolve();
    expect(stale).toHaveBeenCalledTimes(1);
    unmount();
    queryClient.unmount();
  });
});
