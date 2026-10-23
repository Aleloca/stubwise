import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it } from "vitest";
import { failNext, resetApi, setLatency } from "./api";
import {
  useDayArrangements,
  usePinnedFilters,
  usePlanTask,
  useSetFilterPinned,
  useTask,
  useUpdateTask,
} from "./queries";
import { getSessionPersonId } from "./session";
import { ViewerProvider, useViewer } from "./viewer";

beforeEach(() => {
  setLatency(0);
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

describe("query per persona", () => {
  it("useTask: cambiando persona la query riparte sotto la chiave nuova e non dà i dati vecchi", async () => {
    // Ogni valore visto dal componente, per provare che nessun render della
    // persona nuova riceve la task della precedente.
    const seen: { personId: string; code: string | null | undefined }[] = [];
    const { result } = renderHook(
      () => {
        const viewer = useViewer();
        const task = useTask("MKX-2");
        seen.push({
          personId: viewer.viewer.personId,
          code: task.data === null ? null : task.data?.code,
        });
        return { viewer, task };
      },
      { wrapper },
    );

    await waitFor(() => expect(result.current.task.data?.code).toBe("MKX-2"));
    expect(result.current.viewer.viewer.personId).toBe("p-giulia");

    // Sara non è membro di MKX.
    act(() => result.current.viewer.setPersona("p-sara"));
    expect(getSessionPersonId()).toBe("p-sara");
    await waitFor(() => expect(result.current.task.data).toBeNull());

    const asSara = seen.filter((s) => s.personId === "p-sara");
    expect(asSara.length).toBeGreaterThan(0);
    // Prima `undefined` (pending sotto la chiave nuova), poi `null`: mai MKX-2.
    for (const s of asSara) expect(s.code).not.toBe("MKX-2");
    expect(asSara.at(-1)!.code).toBeNull();
  });
});

describe("mutazioni ottimistiche", () => {
  it("useUpdateTask: la task cambia subito, e un errore la ripristina", async () => {
    const { result } = renderHook(() => ({ task: useTask("MKX-2"), update: useUpdateTask() }), {
      wrapper,
    });
    await waitFor(() => expect(result.current.task.data?.code).toBe("MKX-2"));
    const original = result.current.task.data!;

    // L'errore arriva dopo la latenza: nel frattempo il dato è già quello nuovo.
    setLatency(400);
    failNext("updateTask");
    act(() => result.current.update.mutate({ id: original.id, patch: { title: "Optimistic" } }));
    await waitFor(() => expect(result.current.task.data?.title).toBe("Optimistic"));
    await waitFor(() => expect(result.current.update.isError).toBe(true));
    expect(result.current.update.error?.message).toMatch(/Simulated/);
    await waitFor(() => expect(result.current.task.data?.title).toBe(original.title));
    setLatency(0);

    // Senza errore resta cambiato.
    act(() => result.current.update.mutate({ id: original.id, patch: { title: "Kept" } }));
    await waitFor(() => expect(result.current.update.isSuccess).toBe(true));
    await waitFor(() => expect(result.current.task.data?.title).toBe("Kept"));
  });

  it("usePinnedFilters / useSetFilterPinned: fissare un filtro si vede", async () => {
    const { result } = renderHook(
      () => ({ pinned: usePinnedFilters(), pin: useSetFilterPinned() }),
      { wrapper },
    );
    // Giulia (la persona di default) ha due filtri fissati nel seed.
    const seeded = ["flt-giulia-week", "flt-no-estimate"];
    await waitFor(() => expect(result.current.pinned.data).toEqual(seeded));
    act(() => result.current.pin.mutate({ filterId: "flt-open", pinned: true }));
    await waitFor(() => expect(result.current.pinned.data).toEqual([...seeded, "flt-open"]));
    await waitFor(() => expect(result.current.pin.isSuccess).toBe(true));
  });

  it("usePlanTask: cambiare settimana ricarica anche le disposizioni del giorno", async () => {
    const { result } = renderHook(
      () => ({
        viewer: useViewer(),
        days: useDayArrangements("2026-W43"),
        plan: usePlanTask(),
      }),
      { wrapper },
    );
    act(() => result.current.viewer.setPersona("p-marco"));
    await waitFor(() =>
      expect(result.current.days.data?.some((a) => a.taskId === "t-aud-3")).toBe(true),
    );
    act(() =>
      result.current.plan.mutate({ id: "t-aud-3", assigneeId: "p-marco", week: "2026-W45" }),
    );
    await waitFor(() => expect(result.current.plan.isSuccess).toBe(true));
    await waitFor(() =>
      expect(result.current.days.data?.some((a) => a.taskId === "t-aud-3")).toBe(false),
    );
  });
});
