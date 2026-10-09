import AsyncStorage from "@react-native-async-storage/async-storage";
import { onlineManager, type Query } from "@tanstack/react-query";
import { waitFor } from "@testing-library/react-native";
import { agentSessionKeys } from "../lib/query-keys";
import { queryClient, shouldPersistQuery } from "./providers";

function query(queryKey: readonly unknown[], status: "success" | "error" | "pending" = "success"): Query {
  return { queryKey, state: { status }, isDisabled: () => false } as unknown as Query;
}

describe("shouldPersistQuery", () => {
  test("le sessioni degli agenti non si persistono (contengono email e output dei tool)", () => {
    expect(shouldPersistQuery(query(["agent-sessions", "detail", "x"]))).toBe(false);
    expect(shouldPersistQuery(query(["agent-sessions", "list", {}]))).toBe(false);
    expect(shouldPersistQuery(query(["agent-sessions", "events", "x"]))).toBe(false);
  });

  test("le altre query riuscite si persistono", () => {
    expect(shouldPersistQuery(query(["work", "ticket", "x"]))).toBe(true);
  });

  test("le altre query non riuscite no (default di TanStack)", () => {
    expect(shouldPersistQuery(query(["work", "ticket", "x"], "error"))).toBe(false);
  });
});

/**
 * Il collegamento VERO: il `queryClient` dell'app, persistito da
 * `persistQueryClient` sull'AsyncStorage finto di Jest. Si legge ciò che è
 * stato SCRITTO, non ciò che una funzione direbbe: è la prova che il filtro
 * arriva davvero al persister (un `dehydrateOptions` dimenticato lascerebbe
 * verdi i test qui sopra).
 */
describe("persistQueryClient sul client vero", () => {
  const STORAGE_KEY = "stubwise-query-cache";
  const SESSION_ID = "11111111-1111-4111-8111-111111111111";

  type Persisted = {
    clientState: {
      queries: { queryKey: unknown[] }[];
      mutations: { mutationKey?: unknown[] }[];
    };
  };

  async function written(): Promise<Persisted> {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    if (raw === null) throw new Error("niente ancora su AsyncStorage");
    return JSON.parse(raw) as Persisted;
  }

  afterEach(async () => {
    // Una per una: `MutationCache.clear()` avvisa il persister PRIMA di
    // svuotarsi, e l'ultima scrittura conterrebbe ancora le mutazioni.
    const mutations = queryClient.getMutationCache();
    for (const mutation of mutations.getAll()) mutations.remove(mutation);
    queryClient.clear();
    onlineManager.setOnline(true);
    // Lo svuotamento passa anch'esso dal persister (con la sua attesa di
    // 1 s): si aspetta che sia scritto, così nessun timer resta aperto.
    await waitFor(
      async () => {
        const { clientState } = await written();
        expect(clientState.queries.length + clientState.mutations.length).toBe(0);
      },
      { timeout: 5_000 },
    );
    await AsyncStorage.clear();
  });

  test("una sessione in cache non finisce su AsyncStorage; un ticket sì", async () => {
    queryClient.setQueryData(agentSessionKeys.detail(SESSION_ID), { id: SESSION_ID, title: "testo di un'email" });
    queryClient.setQueryData(["work", "ticket", "t1"], { id: "t1" });
    await waitFor(
      async () => {
        const keys = (await written()).clientState.queries.map((q) => q.queryKey);
        expect(keys).toContainEqual(["work", "ticket", "t1"]);
      },
      { timeout: 5_000 },
    );
    const keys = (await written()).clientState.queries.map((q) => q.queryKey[0]);
    expect(keys).not.toContain(agentSessionKeys.all[0]);
    expect(JSON.stringify(await written())).not.toContain("testo di un'email");
  });

  test("un invio a una sessione fermo offline non finisce su AsyncStorage; un'altra mutazione ferma sì", async () => {
    onlineManager.setOnline(false);
    const cache = queryClient.getMutationCache();
    const typed = cache.build<void, Error, boolean, unknown>(queryClient, {
      mutationKey: agentSessionKeys.send(SESSION_ID),
      // Nessun timer di raccolta (5 minuti): Jest resterebbe aperto.
      gcTime: Infinity,
      mutationFn: async () => undefined,
    });
    const other = cache.build<void, Error, { id: string }, unknown>(queryClient, {
      mutationKey: ["inbox", "handle"],
      gcTime: Infinity,
      mutationFn: async () => undefined,
    });
    void typed.execute(false).catch(() => undefined);
    void other.execute({ id: "n1" }).catch(() => undefined);
    await waitFor(() => expect(typed.state.isPaused && other.state.isPaused).toBe(true));
    await waitFor(
      async () => {
        const keys = (await written()).clientState.mutations.map((m) => m.mutationKey);
        expect(keys).toContainEqual(["inbox", "handle"]);
      },
      { timeout: 5_000 },
    );
    const persisted = await written();
    expect(persisted.clientState.mutations.map((m) => m.mutationKey)).not.toContainEqual(
      agentSessionKeys.send(SESSION_ID),
    );
  });
});
