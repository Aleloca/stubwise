import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it } from "vitest";
import { resetApi, setLatency } from "../api";
import { ViewerProvider } from "../viewer";
import { useConfirmChatProposal, useConfirmProposal, useUndoClaudeActions } from "../queries";

// Review F7 renderer, I2: confermare o annullare un'azione di Claude
// dell'area 9 (archiveProject, addMember…) cambia impostazioni del progetto,
// registro, Amministrazione, elenchi dei progetti (l'archiviato nel binario)
// e i permessi di chi guarda (membri, archivio): si rileggono tutti.

const ME = "p-laura";
const TOUCHED = [
  "projectSettings",
  "changelog",
  "admin",
  "instance",
  "projects",
  "project",
  "archived",
];

beforeEach(() => {
  resetApi();
  setLatency(0);
});

const HOOKS: Record<string, [() => { mutateAsync: (v: never) => Promise<unknown> }, unknown]> = {
  useConfirmProposal: [() => useConfirmProposal(), { id: "c-none", proposalId: "p-none" }],
  useUndoClaudeActions: [() => useUndoClaudeActions(), { id: "c-none", groupId: "g-none" }],
  useConfirmChatProposal: [
    () => useConfirmChatProposal(),
    { messageId: "m-none", proposalId: "p-none" },
  ],
};

describe("dopo una conferma o un «Annulla» di Claude si rileggono le aree dell'area 9 e il viewer", () => {
  for (const [name, [hook, vars]] of Object.entries(HOOKS)) {
    it(name, async () => {
      const client = new QueryClient();
      for (const area of TOUCHED) client.setQueryData(["as", ME, area, "x"], {});
      client.setQueryData(["viewer", ME], { personId: ME });
      const wrapper = ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={client}>
          <ViewerProvider initialPersonId={ME}>{children}</ViewerProvider>
        </QueryClientProvider>
      );
      const { result } = renderHook(hook, { wrapper });
      // L'esito non conta (la proposta non c'è): conta cosa si rilegge dopo.
      await result.current.mutateAsync(vars as never).catch(() => null);
      for (const area of TOUCHED)
        expect(client.getQueryState(["as", ME, area, "x"])?.isInvalidated, area).toBe(true);
      expect(client.getQueryState(["viewer", ME])?.isInvalidated).toBe(true);
    });
  }
});
