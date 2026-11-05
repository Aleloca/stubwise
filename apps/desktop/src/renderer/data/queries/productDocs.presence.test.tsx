import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it } from "vitest";
import { productDocs, resetApi, setLatency } from "../api";
import { useJoinProductPage, useProductPresence } from "../queries";
import { METER_IDS } from "../seed/productDocs/acq";
import { state } from "../store";
import { ViewerProvider, useViewer } from "../viewer";

// Gli hook della presenza (area 11a, Task 5): entrare, uscire, e uscire a
// nome della persona di prima quando si cambia col «vedi come».

const METER = METER_IDS.pageId;
const presentOn = () =>
  state.productPresence.filter((p) => p.pageId === METER).map((p) => p.personId);

beforeEach(() => {
  resetApi();
  setLatency(0);
});

function wrapperFor(personId: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>
      <ViewerProvider initialPersonId={personId}>{children}</ViewerProvider>
    </QueryClientProvider>
  );
}

describe("useJoinProductPage", () => {
  it("entra al montaggio, esce allo smontaggio", async () => {
    const { unmount } = renderHook(() => useJoinProductPage(METER), {
      wrapper: wrapperFor("p-sara"),
    });
    await waitFor(() => expect(presentOn()).toContain("p-sara"));
    unmount();
    expect(presentOn()).not.toContain("p-sara");
    await productDocs.whenProductIdle();
  });

  it("al cambio di persona esce chi c'era, entra la persona nuova", async () => {
    const { result } = renderHook(
      () => {
        useJoinProductPage(METER);
        return useViewer();
      },
      { wrapper: wrapperFor("p-laura") },
    );
    await waitFor(() => expect(presentOn()).toContain("p-laura"));
    act(() => result.current.setPersona("p-sara"));
    await waitFor(() => expect(presentOn()).toContain("p-sara"));
    expect(presentOn()).not.toContain("p-laura");
    await productDocs.whenProductIdle();
  });

  it("chi non legge la pagina non entra, e nessun errore esce dal hook", async () => {
    renderHook(() => useJoinProductPage(METER), { wrapper: wrapperFor("p-giulia") });
    await productDocs.whenProductIdle();
    expect(presentOn()).toEqual([]);
  });
});

describe("useProductPresence", () => {
  it("ricarica quando qualcuno entra", async () => {
    const { result } = renderHook(() => useProductPresence(METER), {
      wrapper: wrapperFor("p-laura"),
    });
    await waitFor(() => expect(result.current.data).toEqual([]));
    state.productPresence.push({
      pageId: METER,
      personId: "p-federico",
      anchorId: null,
      offset: 0,
      selection: null,
      seq: 1,
    });
    // Una presenza vera dice `presence` agli iscritti: qui la porta quella di chi guarda.
    await act(async () => {
      await productDocs.setProductPresence(METER, null);
    });
    await waitFor(() =>
      expect(result.current.data?.map((p) => p.personId)).toContain("p-federico"),
    );
    await productDocs.whenProductIdle();
  });
});
