import { ApiError, createStubwiseClient } from "@stubwise/api-client";
import type { StubwiseClient } from "@stubwise/api-client";
import NetInfo from "@react-native-community/netinfo";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react-native";
import type { TFunction } from "i18next";
import type { ReactNode } from "react";
import { AuthContext } from "../app/auth-context";
import type { AuthContextValue } from "../app/providers";
import i18n from "../i18n";
import { settleMutations } from "../test-utils/settle-mutations";
import { describeCorrectionError, useRequestCorrection, useResumeCorrection } from "./correction-mutations";
import { projectsPulseKey, ticketKeys, workKeys } from "./query-keys";

const TICKET_ID = "11111111-1111-4111-8111-111111111111";
const REPO_ID = "22222222-2222-4222-8222-222222222222";
const HELD_JOB_ID = "44444444-4444-4444-8444-444444444444";
const CORRECTION_ID = "55555555-5555-4555-8555-555555555555";
const t = i18n.t.bind(i18n) as TFunction;

/**
 * Il `fetch` del client: una SPIA che rifiuta. Nessun test deve arrivarci —
 * lo verifica l'`afterEach` qui sotto. Senza quella verifica, un metodo che
 * una mutazione chiamasse senza spia rifiuterebbe come una rete assente, e un
 * test che si aspetta «Stubwise non risponde» passerebbe per il motivo
 * sbagliato.
 */
const fetchSpy = jest.fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>(() =>
  Promise.reject(new Error("fetch non previsto nei test delle correzioni")),
);

/**
 * ⚠️ Il doppio è un client VERO (tipato, niente cast) con una spia su OGNI
 * metodo che queste mutazioni chiamano: `tickets.requestCorrection` e
 * `tickets.runAi`. Il `fetch` iniettato è `fetchSpy`: un metodo che una
 * mutazione chiamasse senza spia lo raggiungerebbe, e l'`afterEach` lo
 * segnala — vedi CLAUDE.md, «il DOPPIO del client nei test dell'app».
 */
function makeClient() {
  const client = createStubwiseClient({
    baseUrl: "https://stubwise.test",
    getAuthHeader: () => null,
    fetch: fetchSpy,
  });
  const requestCorrection = jest
    .spyOn(client.tickets, "requestCorrection")
    .mockResolvedValue({ correctionId: CORRECTION_ID });
  const runAi = jest.spyOn(client.tickets, "runAi").mockResolvedValue({ jobId: HELD_JOB_ID, status: "queued" });
  return { client, requestCorrection, runAi };
}

describe("describeCorrectionError: ogni rifiuto ha la sua frase, decisa dal `code`", () => {
  // La prima colonna è solo il titolo del caso: senza, `%s` stamperebbe lo
  // stack dell'errore.
  test.each([
    ["409 correction_in_flight", new ApiError(409, "…", "correction_in_flight"), "C'è già una correzione in corso su questa PR"],
    ["409 job_in_flight", new ApiError(409, "…", "job_in_flight"), "C'è già un job in corso su questo ticket"],
    ["409 pr_not_open", new ApiError(409, "…", "pr_not_open"), "Questa PR non è più aperta"],
    ["409 not_stubwise_pr", new ApiError(409, "…", "not_stubwise_pr"), "Si possono correggere solo le PR aperte da Stubwise"],
    ["404 pr_not_found", new ApiError(404, "…", "pr_not_found"), "Non c'è una PR di questo ticket su questo repository"],
    [
      "403 needs_maintainer",
      new ApiError(403, "…", "needs_maintainer"),
      "Questa correzione è ferma per budget esaurito: solo un maintainer può riprenderla, chiedilo a uno di loro",
    ],
    [
      "409 correction_not_held",
      new ApiError(409, "…", "correction_not_held"),
      "Questa correzione non è più ferma: il ticket è stato ricaricato",
    ],
    [
      "0 network_error",
      new ApiError(0, "Unable to reach the server", "network_error"),
      "Stubwise non risponde, controlla la connessione e riprova",
    ],
    ["TypeError (non ApiError)", new TypeError("Network request failed"), "Stubwise non risponde, controlla la connessione e riprova"],
    ["500 internal", new ApiError(500, "…", "internal"), "La richiesta non è andata a buon fine, riprova"],
    // Lo status NON decide: un 409 con un `code` che l'app non conosce non
    // diventa «correzione in corso» né «job in corso».
    ["409 something_new", new ApiError(409, "…", "something_new"), "La richiesta non è andata a buon fine, riprova"],
  ])("%s", (_title, error, expected) => {
    expect(describeCorrectionError(error, t)).toBe(expected);
  });
});

function makeWrapper(client: StubwiseClient, queryClient: QueryClient) {
  const authValue: AuthContextValue = {
    status: "authenticated",
    client,
    user: { id: "u1", email: "op@example.com", role: "member", language: "it", avatarUrl: null, slackUserId: null },
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

function makeQueryClient() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const invalidate = jest.spyOn(queryClient, "invalidateQueries");
  const invalidatedKeys = () => invalidate.mock.calls.map(([filters]) => filters?.queryKey);
  return { queryClient, invalidatedKeys };
}


beforeEach(() => {
  (NetInfo.useNetInfo as jest.Mock).mockReturnValue({ isConnected: true, isInternetReachable: true });
  fetchSpy.mockClear();
});

afterEach(() => {
  // Nessun test va in rete: ogni chiamata passa da una spia del client.
  expect(fetchSpy).not.toHaveBeenCalled();
});

describe("useRequestCorrection", () => {
  test("chiama la rotta con ticket, repository e nota; al successo ricarica lavoro, ticket e polso, poi onDone", async () => {
    const { client, requestCorrection, runAi } = makeClient();
    const { queryClient, invalidatedKeys } = makeQueryClient();
    const onDone = jest.fn();

    const rendered = await renderHook(() => useRequestCorrection(TICKET_ID), { wrapper: makeWrapper(client, queryClient) });
    await act(async () => {
      rendered.result.current.request({ repositoryId: REPO_ID, note: "Rinomina anche il test" }, onDone);
    });

    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
    expect(requestCorrection).toHaveBeenCalledWith(TICKET_ID, REPO_ID, { note: "Rinomina anche il test" });
    expect(runAi).not.toHaveBeenCalled();
    expect(invalidatedKeys()).toEqual(
      expect.arrayContaining([workKeys.all(TICKET_ID), ticketKeys.all, projectsPulseKey]),
    );
    await settleMutations(queryClient);
    expect(rendered.result.current.errorMessage).toBeNull();
  });

  test("senza nota non manda `note`", async () => {
    const { client, requestCorrection } = makeClient();
    const { queryClient } = makeQueryClient();

    const rendered = await renderHook(() => useRequestCorrection(TICKET_ID), { wrapper: makeWrapper(client, queryClient) });
    await act(async () => {
      rendered.result.current.request({ repositoryId: REPO_ID }, jest.fn());
    });

    await waitFor(() => expect(requestCorrection).toHaveBeenCalledWith(TICKET_ID, REPO_ID, {}));
    await settleMutations(queryClient);
  });

  test("409 `correction_in_flight`: errore MOSTRATO, onDone NON chiamato, e il lavoro si rilegge", async () => {
    const { client, requestCorrection } = makeClient();
    requestCorrection.mockRejectedValue(new ApiError(409, "…", "correction_in_flight"));
    const { queryClient, invalidatedKeys } = makeQueryClient();
    const onDone = jest.fn();

    const rendered = await renderHook(() => useRequestCorrection(TICKET_ID), { wrapper: makeWrapper(client, queryClient) });
    await act(async () => {
      rendered.result.current.request({ repositoryId: REPO_ID }, onDone);
    });

    await waitFor(() =>
      expect(rendered.result.current.errorMessage).toBe("C'è già una correzione in corso su questa PR"),
    );
    expect(onDone).not.toHaveBeenCalled();
    expect(invalidatedKeys()).toContainEqual(workKeys.all(TICKET_ID));
    await settleMutations(queryClient);
  });

  test("errore di rete (status 0): il testo è quello dell'app, e niente da rileggere", async () => {
    const { client, requestCorrection } = makeClient();
    requestCorrection.mockRejectedValue(new ApiError(0, "Unable to reach the server", "network_error"));
    const { queryClient, invalidatedKeys } = makeQueryClient();

    const rendered = await renderHook(() => useRequestCorrection(TICKET_ID), { wrapper: makeWrapper(client, queryClient) });
    await act(async () => {
      rendered.result.current.request({ repositoryId: REPO_ID }, jest.fn());
    });

    await waitFor(() =>
      expect(rendered.result.current.errorMessage).toBe("Stubwise non risponde, controlla la connessione e riprova"),
    );
    expect(invalidatedKeys()).not.toContainEqual(workKeys.all(TICKET_ID));
    await settleMutations(queryClient);
  });

  test.each([
    ["500 internal", new ApiError(500, "…", "internal")],
    ["409 something_new", new ApiError(409, "…", "something_new")],
  ])("%s: un rifiuto che non dice «schermata vecchia» NON rilegge il lavoro", async (_title, error) => {
    const { client, requestCorrection } = makeClient();
    requestCorrection.mockRejectedValue(error);
    const { queryClient, invalidatedKeys } = makeQueryClient();

    const rendered = await renderHook(() => useRequestCorrection(TICKET_ID), { wrapper: makeWrapper(client, queryClient) });
    await act(async () => {
      rendered.result.current.request({ repositoryId: REPO_ID }, jest.fn());
    });

    await waitFor(() =>
      expect(rendered.result.current.errorMessage).toBe("La richiesta non è andata a buon fine, riprova"),
    );
    expect(invalidatedKeys()).not.toContainEqual(workKeys.all(TICKET_ID));
    await settleMutations(queryClient);
  });

  test("doppio tap nello stesso frame: UNA sola richiesta, e il pannello si chiude una volta", async () => {
    const { client, requestCorrection } = makeClient();
    const { queryClient } = makeQueryClient();
    const onDone = jest.fn();

    const rendered = await renderHook(() => useRequestCorrection(TICKET_ID), { wrapper: makeWrapper(client, queryClient) });
    await act(async () => {
      rendered.result.current.request({ repositoryId: REPO_ID }, onDone);
      rendered.result.current.request({ repositoryId: REPO_ID }, onDone);
    });

    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
    expect(requestCorrection).toHaveBeenCalledTimes(1);
    await settleMutations(queryClient);
  });

  test("dopo un errore la guardia si rilascia: riprovare manda la richiesta", async () => {
    const { client, requestCorrection } = makeClient();
    requestCorrection.mockRejectedValueOnce(new ApiError(500, "…", "internal"));
    const { queryClient } = makeQueryClient();
    const onDone = jest.fn();

    const rendered = await renderHook(() => useRequestCorrection(TICKET_ID), { wrapper: makeWrapper(client, queryClient) });
    await act(async () => {
      rendered.result.current.request({ repositoryId: REPO_ID }, onDone);
    });
    await waitFor(() => expect(rendered.result.current.errorMessage).not.toBeNull());

    await act(async () => {
      rendered.result.current.request({ repositoryId: REPO_ID }, onDone);
    });

    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
    expect(requestCorrection).toHaveBeenCalledTimes(2);
    await settleMutations(queryClient);
    // Riuscito il secondo tentativo, l'errore del primo non resta sotto la riga.
    expect(rendered.result.current.errorMessage).toBeNull();
  });

  test("offline: disabled e online=false", async () => {
    (NetInfo.useNetInfo as jest.Mock).mockReturnValue({ isConnected: false, isInternetReachable: false });
    const { client } = makeClient();
    const { queryClient } = makeQueryClient();

    const rendered = await renderHook(() => useRequestCorrection(TICKET_ID), { wrapper: makeWrapper(client, queryClient) });
    expect(rendered.result.current.disabled).toBe(true);
    expect(rendered.result.current.online).toBe(false);
  });
});

describe("useResumeCorrection: «Riprendi» dice QUALE correzione (G5)", () => {
  test("manda run-ai con `resumeCorrectionJobId`; al successo ricarica lavoro, ticket e polso, poi onDone", async () => {
    const { client, runAi, requestCorrection } = makeClient();
    const { queryClient, invalidatedKeys } = makeQueryClient();
    const onDone = jest.fn();

    const rendered = await renderHook(() => useResumeCorrection(TICKET_ID), { wrapper: makeWrapper(client, queryClient) });
    await act(async () => {
      rendered.result.current.resume(HELD_JOB_ID, onDone);
    });

    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
    expect(runAi).toHaveBeenCalledWith(TICKET_ID, { resumeCorrectionJobId: HELD_JOB_ID });
    expect(requestCorrection).not.toHaveBeenCalled();
    expect(invalidatedKeys()).toEqual(
      expect.arrayContaining([workKeys.all(TICKET_ID), ticketKeys.all, projectsPulseKey]),
    );
    await settleMutations(queryClient);
    expect(rendered.result.current.errorMessage).toBeNull();
  });

  test("doppio tap nello stesso frame: UN solo run-ai", async () => {
    const { client, runAi } = makeClient();
    const { queryClient } = makeQueryClient();
    const onDone = jest.fn();

    const rendered = await renderHook(() => useResumeCorrection(TICKET_ID), { wrapper: makeWrapper(client, queryClient) });
    const started: boolean[] = [];
    await act(async () => {
      started.push(rendered.result.current.resume(HELD_JOB_ID, onDone));
      started.push(rendered.result.current.resume(HELD_JOB_ID, onDone));
    });

    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
    expect(runAi).toHaveBeenCalledTimes(1);
    // Dice a chi chiama quale dei due è partito: la sezione PR ci ricorda la riga.
    expect(started).toEqual([true, false]);
    await settleMutations(queryClient);
  });

  test("409 `correction_not_held`: il ticket si ricarica, e la frase lo dice", async () => {
    const { client, runAi } = makeClient();
    runAi.mockRejectedValue(new ApiError(409, "…", "correction_not_held"));
    const { queryClient, invalidatedKeys } = makeQueryClient();
    const onDone = jest.fn();

    const rendered = await renderHook(() => useResumeCorrection(TICKET_ID), { wrapper: makeWrapper(client, queryClient) });
    await act(async () => {
      rendered.result.current.resume(HELD_JOB_ID, onDone);
    });

    await waitFor(() =>
      expect(rendered.result.current.errorMessage).toBe(
        "Questa correzione non è più ferma: il ticket è stato ricaricato",
      ),
    );
    expect(invalidatedKeys()).toContainEqual(workKeys.all(TICKET_ID));
    expect(onDone).not.toHaveBeenCalled();
    await settleMutations(queryClient);
  });

  test("409 `job_in_flight`: STESSO status, ma il ticket NON si ricarica — decide il `code`", async () => {
    const { client, runAi } = makeClient();
    runAi.mockRejectedValue(new ApiError(409, "…", "job_in_flight"));
    const { queryClient, invalidatedKeys } = makeQueryClient();

    const rendered = await renderHook(() => useResumeCorrection(TICKET_ID), { wrapper: makeWrapper(client, queryClient) });
    await act(async () => {
      rendered.result.current.resume(HELD_JOB_ID, jest.fn());
    });

    await waitFor(() =>
      expect(rendered.result.current.errorMessage).toBe("C'è già un job in corso su questo ticket"),
    );
    expect(invalidatedKeys()).not.toContainEqual(workKeys.all(TICKET_ID));
    await settleMutations(queryClient);
  });

  test("403 `needs_maintainer`: la frase del maintainer, e onDone non parte", async () => {
    const { client, runAi } = makeClient();
    runAi.mockRejectedValue(new ApiError(403, "…", "needs_maintainer"));
    const { queryClient } = makeQueryClient();
    const onDone = jest.fn();

    const rendered = await renderHook(() => useResumeCorrection(TICKET_ID), { wrapper: makeWrapper(client, queryClient) });
    await act(async () => {
      rendered.result.current.resume(HELD_JOB_ID, onDone);
    });

    await waitFor(() =>
      expect(rendered.result.current.errorMessage).toBe(
        "Questa correzione è ferma per budget esaurito: solo un maintainer può riprenderla, chiedilo a uno di loro",
      ),
    );
    expect(onDone).not.toHaveBeenCalled();
    await settleMutations(queryClient);
  });

  test("errore di rete (status 0): il testo è quello dell'app", async () => {
    const { client, runAi } = makeClient();
    runAi.mockRejectedValue(new ApiError(0, "Unable to reach the server", "network_error"));
    const { queryClient } = makeQueryClient();

    const rendered = await renderHook(() => useResumeCorrection(TICKET_ID), { wrapper: makeWrapper(client, queryClient) });
    await act(async () => {
      rendered.result.current.resume(HELD_JOB_ID, jest.fn());
    });

    await waitFor(() =>
      expect(rendered.result.current.errorMessage).toBe("Stubwise non risponde, controlla la connessione e riprova"),
    );
    await settleMutations(queryClient);
  });

  test("offline: disabled e online=false", async () => {
    (NetInfo.useNetInfo as jest.Mock).mockReturnValue({ isConnected: false, isInternetReachable: false });
    const { client } = makeClient();
    const { queryClient } = makeQueryClient();

    const rendered = await renderHook(() => useResumeCorrection(TICKET_ID), { wrapper: makeWrapper(client, queryClient) });
    expect(rendered.result.current.disabled).toBe(true);
    expect(rendered.result.current.online).toBe(false);
  });
});
