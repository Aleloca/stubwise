import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it } from "vitest";
import { resetApi, setLatency } from "./api";
import { useTask } from "./queries";
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
