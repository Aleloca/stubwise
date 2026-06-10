import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRouteWithContext,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ApiError } from "../lib/api";
import { meQueryOptions } from "../lib/auth";
import { RouteError } from "./route-error";

/**
 * Router vero in miniatura (memory history) con RouteError come error
 * boundary di default: il pattern dell'app, senza mock del modulo router.
 */
function renderWithFailingLoader(loader: () => Promise<unknown>) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  // Identità in cache, come a sessione attiva: il 401 deve buttarla via.
  queryClient.setQueryData(meQueryOptions.queryKey, {
    user: { id: "u1", email: "ada@example.com", role: "admin" as const },
  });

  const rootRoute = createRootRouteWithContext<{ queryClient: QueryClient }>()({
    component: Outlet,
  });
  const loginRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/login",
    component: () => <h1>Accedi</h1>,
  });
  const brokenRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    loader,
    component: () => <p>contenuto caricato</p>,
  });

  const router = createRouter({
    routeTree: rootRoute.addChildren([loginRoute, brokenRoute]),
    context: { queryClient },
    defaultErrorComponent: RouteError,
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });

  render(
    <QueryClientProvider client={queryClient}>
      {/* Cast: il Register globale punta al router dell'app, questo è di test. */}
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
  return { router, queryClient };
}

describe("RouteError", () => {
  it("loader che lancia 401: svuota la query me e atterra su /login", async () => {
    const { router, queryClient } = renderWithFailingLoader(() => {
      throw new ApiError(401, "Non autenticato");
    });

    expect(await screen.findByRole("heading", { name: "Accedi" })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/login");
    expect(queryClient.getQueryData(meQueryOptions.queryKey)).toBeUndefined();
  });

  it("errore generico: pannello con messaggio e bottone di retry, nessun redirect", async () => {
    const { router } = renderWithFailingLoader(() => {
      throw new ApiError(500, "Errore interno");
    });

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Errore interno");
    expect(screen.getByRole("button", { name: /riprova/i })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/");
  });
});
