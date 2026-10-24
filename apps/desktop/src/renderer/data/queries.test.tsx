import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it } from "vitest";
import { failNext, resetApi, runScript, setLatency, simulateDisconnect } from "./api";
import {
  useConversation,
  useConversationStream,
  useConversations,
  useDayArrangements,
  usePinnedFilters,
  usePlanTask,
  useSetFilterPinned,
  useTask,
  useUpdateTask,
} from "./queries";
import { getSessionPersonId } from "./session";
import { state as storeState } from "./store";
import type { ConversationEvent } from "./types";
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

describe("useConversationStream", () => {
  const ID = "cv-run-aud-5";
  // Marco è sviluppatore su AUD: vede la sessione (Giulia no).
  function wrapper({ children }: { children: ReactNode }) {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return (
      <QueryClientProvider client={client}>
        <ViewerProvider initialPersonId="p-marco">{children}</ViewerProvider>
      </QueryClientProvider>
    );
  }
  const isDone = (events: ConversationEvent[]) => {
    const last = events.at(-1);
    return (
      last?.type === "action" && last.state === "done" && last.label === "Runs the full test suite"
    );
  };

  it("arriva fino in fondo, cade, si riconnette senza doppi", async () => {
    const { result } = renderHook(() => useConversationStream(ID), { wrapper });
    await waitFor(() => expect(isDone(result.current.events)).toBe(true));
    expect(result.current.connection).toBe("live");
    expect(result.current.events).toEqual(storeState.conversationEvents.get(ID));

    act(() => simulateDisconnect(ID));
    expect(result.current.connection).toBe("reconnecting");
    await waitFor(() => expect(result.current.connection).toBe("live"));
    const ids = result.current.events.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(result.current.events).toEqual(storeState.conversationEvents.get(ID));
  });

  it("cambiando persona il flusso della precedente sparisce; una conversazione invisibile è `not_found`", async () => {
    const seen: { personId: string; count: number }[] = [];
    const { result } = renderHook(
      () => {
        const viewer = useViewer();
        const stream = useConversationStream(ID);
        seen.push({ personId: viewer.viewer.personId, count: stream.events.length });
        return { viewer, stream };
      },
      { wrapper },
    );
    await waitFor(() => expect(result.current.stream.events.length).toBeGreaterThan(0));

    // Sara non è membro di AUD.
    act(() => result.current.viewer.setPersona("p-sara"));
    await waitFor(() => expect(result.current.stream.error).toBe("not_found"));
    expect(result.current.stream.connection).toBe("closed");
    for (const s of seen.filter((x) => x.personId === "p-sara")) expect(s.count).toBe(0);
  });
});

describe("conversazioni: lo stato si vede dal vivo (R-E5)", () => {
  it("un passo `state` rilegge dettaglio, elenco e task senza ricaricare a mano", async () => {
    const { result } = renderHook(
      () => ({
        detail: useConversation("cv-run-mkx-11"),
        live: useConversations({ scope: "live" }),
        task: useTask("MKX-11"),
      }),
      { wrapper },
    );
    await waitFor(() => expect(result.current.detail.data?.state).toBe("working"));
    await waitFor(() => expect(result.current.task.data?.claude).toBe("working"));
    expect(result.current.live.data?.map((c) => c.id)).toContain("cv-run-mkx-11");

    await act(() => runScript("cv-run-mkx-11", [{ step: "state", state: "finished" }]));
    await waitFor(() => expect(result.current.detail.data?.state).toBe("finished"));
    await waitFor(() =>
      expect(result.current.live.data?.map((c) => c.id)).not.toContain("cv-run-mkx-11"),
    );
    await waitFor(() => expect(result.current.task.data?.claude).toBe("done"));
  });
});
