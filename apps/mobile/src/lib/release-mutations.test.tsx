import type { StubwiseClient } from "@stubwise/api-client";
import { ApiError } from "@stubwise/api-client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react-native";
import type { TFunction } from "i18next";
import type { ReactNode } from "react";
import { AuthContext } from "../app/auth-context";
import type { AuthContextValue } from "../app/providers";
import i18n from "../i18n";
import { projectsPulseKey, ticketKeys, workKeys } from "./query-keys";
import { describeReleaseError, useRelease } from "./release-mutations";

const TICKET_ID = "11111111-1111-4111-8111-111111111111";
const REPO_ID = "22222222-2222-4222-8222-222222222222";
const t = i18n.t.bind(i18n) as TFunction;

describe("describeReleaseError: ogni errore della rotta ha la sua frase", () => {
  test.each([
    [new ApiError(409, "…", "checks_failed"), "I controlli del provider falliscono"],
    [new ApiError(409, "…", "already_closed"), "Questa PR non è più aperta"],
    [new ApiError(409, "…", "checks_unreadable"), "Il provider non risponde, riprova"],
    [new ApiError(502, "…", "merge_failed"), "Il provider non risponde, riprova"],
    [new ApiError(403, "…", "forbidden"), "Solo un maintainer può mergiare"],
    [new ApiError(404, "…", "not_found"), "Questa PR non è più sul ticket"],
    [new ApiError(409, "…", "not_mergeable"), "Il provider ha rifiutato il merge: conflitti o regole del branch"],
    [new ApiError(403, "…", "merge_forbidden"), "Le credenziali git non hanno il permesso di mergiare"],
    [new TypeError("Network request failed"), "Stubwise non risponde, controlla la connessione e riprova"],
    [new ApiError(500, "…", "internal"), "Il merge non è andato a buon fine, riprova"],
  ])("%s", (error, expected) => {
    expect(describeReleaseError(error, t)).toBe(expected);
  });
});

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

describe("useRelease", () => {
  test("chiama la rotta di rilascio e, al successo, ricarica polso, ticket e lavoro", async () => {
    const release = jest.fn().mockResolvedValue({ merged: true, sha: "abc" });
    const client = { tickets: { release } } as unknown as StubwiseClient;
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidate = jest.spyOn(queryClient, "invalidateQueries");
    const onDone = jest.fn();

    const rendered = await renderHook(() => useRelease(), { wrapper: makeWrapper(client, queryClient) });
    await act(async () => {
      rendered.result.current.release({ ticketId: TICKET_ID, repositoryId: REPO_ID }, onDone);
    });

    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
    expect(release).toHaveBeenCalledWith(TICKET_ID, REPO_ID);
    const keys = invalidate.mock.calls.map(([filters]) => filters?.queryKey);
    expect(keys).toEqual(expect.arrayContaining([projectsPulseKey, ticketKeys.all, workKeys.all(TICKET_ID)]));
    expect(rendered.result.current.errorMessage).toBeNull();
  });

  test("un errore si MOSTRA: il messaggio c'è, e onDone non parte", async () => {
    const release = jest.fn().mockRejectedValue(new ApiError(409, "…", "checks_failed"));
    const client = { tickets: { release } } as unknown as StubwiseClient;
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const onDone = jest.fn();

    const rendered = await renderHook(() => useRelease(), { wrapper: makeWrapper(client, queryClient) });
    await act(async () => {
      rendered.result.current.release({ ticketId: TICKET_ID, repositoryId: REPO_ID }, onDone);
    });

    await waitFor(() => expect(rendered.result.current.errorMessage).toBe("I controlli del provider falliscono"));
    expect(onDone).not.toHaveBeenCalled();
  });
});
