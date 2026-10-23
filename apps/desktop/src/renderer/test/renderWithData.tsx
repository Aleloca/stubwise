import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, type RenderResult } from "@testing-library/react";
import type { ReactElement, ReactNode } from "react";
import { ViewerProvider } from "../data/viewer";

/**
 * Monta un componente col livello dati finto (query senza retry, come
 * nell'`App`) e la persona «vedi come» indicata. Per i componenti che leggono
 * via `data/queries.ts` ma non hanno bisogno del router.
 */
export function renderWithData(ui: ReactElement, { personId }: { personId?: string } = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>
      <ViewerProvider initialPersonId={personId}>{children}</ViewerProvider>
    </QueryClientProvider>
  );
  const result: RenderResult = render(ui, { wrapper });
  return { ...result, client };
}
