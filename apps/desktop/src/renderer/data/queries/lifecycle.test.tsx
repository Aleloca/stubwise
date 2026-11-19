import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it } from "vitest";
import { resetApi, setLatency } from "../api";
import { markReauthenticated } from "../auth/reauth";
import { ViewerProvider } from "../viewer";
import { useArchiveProject, useDeleteProject, useReopenProject } from "../queries";

// Review F6 renderer, I1: archiviare, riaprire ed eliminare cambiano i
// permessi di chi guarda (`/api/auth/me` esclude gli archiviati). Il viewer
// (`["viewer", personId]`, staleTime Infinity) va riletto, o un Project Lead
// che riapre ACQ resta senza permessi lì fino al riavvio (e il contrario
// dopo l'archiviazione). Giulia non è full admin: per lei conta davvero.

const GIULIA = "p-giulia";

beforeEach(() => {
  resetApi();
  setLatency(0);
});

const HOOKS: Record<string, [() => { mutateAsync: (v: never) => Promise<unknown> }, unknown]> = {
  useArchiveProject: [() => useArchiveProject(), "prj-acq"],
  useReopenProject: [() => useReopenProject(), "prj-rnc"],
  useDeleteProject: [() => useDeleteProject(), { projectId: "prj-rnc", confirmCode: "RNC" }],
};

describe("dopo archivia, riapri, elimina il viewer si rilegge", () => {
  for (const [name, [hook, vars]] of Object.entries(HOOKS)) {
    it(`${name}: ["viewer", personId] invalidata`, async () => {
      markReauthenticated(GIULIA);
      const client = new QueryClient();
      client.setQueryData(["viewer", GIULIA], { personId: GIULIA });
      const wrapper = ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={client}>
          <ViewerProvider initialPersonId={GIULIA}>{children}</ViewerProvider>
        </QueryClientProvider>
      );
      const { result } = renderHook(hook, { wrapper });
      // L'esito non conta (Giulia non elimina): il viewer si rilegge comunque.
      await result.current.mutateAsync(vars as never).catch(() => null);
      expect(client.getQueryState(["viewer", GIULIA])?.isInvalidated).toBe(true);
    });
  }
});
