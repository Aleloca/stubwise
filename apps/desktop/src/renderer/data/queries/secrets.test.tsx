import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it } from "vitest";
import { resetApi, setLatency } from "../api";
import { ViewerProvider } from "../viewer";
import {
  useConfirmEnrollment,
  useCreateInvite,
  useCreatePasswordResetLink,
  useEnrollDuringReauth,
} from "../queries";

// Le mutazioni che restituiscono un segreto mostrato una volta (un link
// d'invito o di reset, la chiave TOTP, i codici di backup) hanno `gcTime: 0`
// anche fuori dalle Preferenze: la cache delle mutazioni non li tiene dopo
// che la pagina li ha lasciati (Minor 1 della revisione finale dell'area 9a).

beforeEach(() => {
  resetApi();
  setLatency(0);
});

const SECRET_HOOKS: Record<string, () => { mutateAsync: (v: never) => Promise<unknown> }> = {
  useCreateInvite: () => useCreateInvite(),
  useCreatePasswordResetLink: () => useCreatePasswordResetLink(),
  useConfirmEnrollment: () => useConfirmEnrollment(),
  useEnrollDuringReauth: () => useEnrollDuringReauth(),
};

describe("segreti nelle mutazioni d'amministrazione e della riconferma", () => {
  for (const [name, hook] of Object.entries(SECRET_HOOKS)) {
    it(`${name}: gcTime 0`, async () => {
      const client = new QueryClient();
      const wrapper = ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={client}>
          <ViewerProvider initialPersonId="p-roberta">{children}</ViewerProvider>
        </QueryClientProvider>
      );
      const { result } = renderHook(hook, { wrapper });
      // Gli argomenti non contano: conta come la mutazione è registrata.
      await result.current.mutateAsync(undefined as never).catch(() => null);
      const [mutation] = client.getMutationCache().getAll();
      expect(mutation!.options.gcTime).toBe(0);
    });
  }
});
