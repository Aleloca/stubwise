import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createHashHistory, RouterProvider, type RouterHistory } from "@tanstack/react-router";
import { useState } from "react";
import { ViewerProvider } from "./data/viewer";
import { createAppRouter } from "./router";
import { ThemeProvider } from "./theme/ThemeProvider";

/** `history` iniettabile (memory nei test); nell'app è l'hash history. */
export function App({ history }: { history?: RouterHistory }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        // Nessun retry: i dati sono finti e un errore iniettato (`failNext`)
        // deve mostrare subito lo stato di errore, non sparire in 3 tentativi.
        defaultOptions: { queries: { retry: false } },
      }),
  );
  const [router] = useState(() => createAppRouter(history ?? createHashHistory()));
  return (
    <QueryClientProvider client={queryClient}>
      <ViewerProvider>
        <ThemeProvider>
          <RouterProvider router={router} />
        </ThemeProvider>
      </ViewerProvider>
    </QueryClientProvider>
  );
}
