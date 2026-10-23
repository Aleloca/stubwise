import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider, createMemoryHistory } from "@tanstack/react-router";
import { render } from "@testing-library/react";
import { ViewerProvider } from "../data/viewer";
import { createAppRouter } from "../router";
import { ThemeProvider } from "../theme/ThemeProvider";

/**
 * Monta l'app intera su un indirizzo (router in memoria, livello dati finto,
 * persona «vedi come»): per i test delle pagine che leggono la ricerca o
 * navigano. Restituisce il router, per leggere `matches.at(-1).search`.
 */
export function renderRoute(path: string, personId?: string) {
  const history = createMemoryHistory({ initialEntries: [path] });
  const router = createAppRouter(history);
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <ViewerProvider initialPersonId={personId}>
        <ThemeProvider>
          <RouterProvider router={router} />
        </ThemeProvider>
      </ViewerProvider>
    </QueryClientProvider>,
  );
  return router;
}
