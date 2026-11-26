import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "../api";
import { ViewerProvider } from "../viewer";
import { useProductUpdatesWaiting } from "./productDocs";

// Revisione di R11-5, 14: la riga «riprende quando…» nella build app non ha
// un evento che la rinfreschi (una sezione presa che si libera, un lavoro che
// riparte): si rilegge a intervallo. Nel prototipo bastano gli eventi.

const LAURA = "p-laura";

const wrapper = (client: QueryClient) =>
  function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={client}>
        <ViewerProvider initialPersonId={LAURA}>{children}</ViewerProvider>
      </QueryClientProvider>
    );
  };

beforeEach(() => {
  api.resetApi();
  api.setLatency(0);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("useProductUpdatesWaiting", () => {
  it("nella build app si rilegge a intervallo", async () => {
    vi.stubEnv("VITE_STUBWISE_BUILD", "app");
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const spy = vi.spyOn(api.productDocs, "productUpdatesWaiting").mockResolvedValue(null);
    // Nella build app il cancello è acceso solo con `product-docs`: lo è (F5).
    renderHook(() => useProductUpdatesWaiting("prj-acq"), { wrapper: wrapper(new QueryClient()) });
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(31_000);
    });
    expect(spy.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("nel prototipo no: bastano gli eventi", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const spy = vi.spyOn(api.productDocs, "productUpdatesWaiting").mockResolvedValue(null);
    renderHook(() => useProductUpdatesWaiting("prj-acq"), { wrapper: wrapper(new QueryClient()) });
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(31_000);
    });
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
