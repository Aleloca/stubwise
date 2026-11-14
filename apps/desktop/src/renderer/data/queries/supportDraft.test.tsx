import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetApi, setLatency, setStreamLatency, support } from "../api";
import { setSessionPersonId } from "../session";
import { useSupportClaudeDraft } from "../queries";
import { ViewerProvider } from "../viewer";

// «Ask Claude» nella casella di Support (area 8, F3, R6): nella build app il
// server ACCODA la bozza (la vista con `claudeDraftPending`); la casella resta
// «Claude sta scrivendo» e rilegge la conversazione finché la bozza nuova non
// arriva, poi la scrive. Non invia niente.

beforeEach(() => {
  resetApi();
  setLatency(0);
  setStreamLatency(0);
  setSessionPersonId("p-matteo");
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  setStreamLatency(null);
  resetApi();
});

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={client}>
      <ViewerProvider>{children}</ViewerProvider>
    </QueryClientProvider>
  );
}

describe("«Ask Claude» con la bozza accodata dal server", () => {
  it("resta «writing» finché la conversazione riletta non porta la bozza, poi la scrive", async () => {
    const real = await support.getSupportConversation("ACQ-S2");
    vi.spyOn(support, "draftReply").mockResolvedValue({
      ...real!,
      claudeDraft: null,
      claudeDraftPending: true,
    });
    const read = vi
      .spyOn(support, "getSupportConversation")
      .mockResolvedValueOnce({ ...real!, claudeDraft: null, claudeDraftPending: true })
      .mockResolvedValue({
        ...real!,
        claudeDraft: "Hi Lucia, a new draft.",
        claudeDraftPending: false,
      });
    const { result } = renderHook(() => useSupportClaudeDraft(), { wrapper });
    act(() => result.current.start("ACQ-S2"));
    expect(result.current.state.status).toBe("writing");
    await waitFor(
      () =>
        expect(result.current.state).toEqual({ status: "done", text: "Hi Lucia, a new draft." }),
      {
        timeout: 8000,
      },
    );
    expect(read.mock.calls.length).toBeGreaterThanOrEqual(2);
  }, 10_000);

  it("il budget di Claude finito: fallisce subito, senza rileggere", async () => {
    vi.spyOn(support, "draftReply").mockRejectedValue(new Error("budget_exhausted"));
    const read = vi.spyOn(support, "getSupportConversation");
    const { result } = renderHook(() => useSupportClaudeDraft(), { wrapper });
    act(() => result.current.start("ACQ-S2"));
    await waitFor(() => expect(result.current.state).toEqual({ status: "failed" }));
    expect(read).not.toHaveBeenCalled();
  });
});
