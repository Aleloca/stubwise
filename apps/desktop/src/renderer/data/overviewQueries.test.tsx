import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { usePortfolioActivity, useProjectPulse, useProjectPulses, useTimeline } from "./queries";
import { ViewerProvider } from "./viewer";

// Il costo delle letture del polso e delle cronologie (review della fetta 4,
// punti 4 e 8): sul server vero un polso sono sei letture, una cronologia una
// pagina di 28 giorni. Restano fresche un minuto, e le cronologie non si
// rileggono al ritorno sulla finestra.
function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>
      <ViewerProvider>{children}</ViewerProvider>
    </QueryClientProvider>
  );
  const optionsOf = (area: string, id: string) => {
    const query = client
      .getQueryCache()
      .getAll()
      .find((q) => q.queryKey[2] === area && q.queryKey[3] === id);
    return query?.options as { staleTime?: number; refetchOnWindowFocus?: boolean; enabled?: boolean } | undefined;
  };
  return { client, wrapper, optionsOf };
}

describe("letture del polso e delle cronologie", () => {
  it("il polso resta fresco un minuto; senza progetto non si legge", async () => {
    const { wrapper, optionsOf } = setup();
    const { result } = renderHook(() => ({ one: useProjectPulse("prj-aud"), all: useProjectPulses(), none: useProjectPulse("") }), {
      wrapper,
    });
    await waitFor(() => expect(result.current.one.isSuccess && result.current.all.isSuccess).toBe(true));
    expect(optionsOf("pulse", "prj-aud")?.staleTime).toBe(60_000);
    expect(optionsOf("pulse", "*all")?.staleTime).toBe(60_000);
    expect(result.current.none.fetchStatus).toBe("idle");
    expect(result.current.none.data).toBeUndefined();
  });

  it("le cronologie restano fresche un minuto e non si rileggono al focus", async () => {
    const { wrapper, optionsOf } = setup();
    const { result } = renderHook(() => ({ timeline: useTimeline("prj-aud"), activity: usePortfolioActivity() }), {
      wrapper,
    });
    await waitFor(() => expect(result.current.timeline.data && result.current.activity.data).toBeTruthy());
    for (const id of ["prj-aud", "*portfolio"]) {
      expect(optionsOf("timeline", id)).toMatchObject({ staleTime: 60_000, refetchOnWindowFocus: false });
    }
  });
});
