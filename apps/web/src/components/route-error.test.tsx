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
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../lib/api";
import { meQueryOptions } from "../lib/auth";
import { RouteError } from "./route-error";

/**
 * Router vero in miniatura (memory history) con RouteError come error
 * boundary di default: il pattern dell'app, senza mock del modulo router.
 */
function renderWithFailingLoader(loader: () => Promise<unknown>) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  // Identità e dati di dominio in cache, come a sessione attiva: il 401
  // deve buttare via tutto, non solo la query me.
  queryClient.setQueryData(meQueryOptions.queryKey, {
    user: {
      id: "u1",
      email: "ada@example.com",
      role: "admin" as const,
      language: "en" as const,
      avatarUrl: null,
      slackUserId: null,
    },
  });
  queryClient.setQueryData(["tickets", "detail", "t1"], { id: "t1" });

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
  // I loader che lanciano sporcano la console con l'errore catturato dal
  // boundary: rumore atteso, silenziato solo per questi test.
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("loader che lancia 401: svuota tutta la cache e atterra su /login", async () => {
    const { router, queryClient } = renderWithFailingLoader(() => {
      throw new ApiError(401, "Non autenticato");
    });

    expect(await screen.findByRole("heading", { name: "Accedi" })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/login");
    // Come al logout: cache azzerata per intero, non solo l'identità.
    expect(queryClient.getQueryData(meQueryOptions.queryKey)).toBeUndefined();
    expect(queryClient.getQueryCache().getAll()).toHaveLength(0);
  });

  it("errore generico: pannello con messaggio e bottone di retry, nessun redirect", async () => {
    const { router } = renderWithFailingLoader(() => {
      throw new ApiError(500, "Errore interno");
    });

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Errore interno");
    expect(screen.getByRole("button", { name: /retry/i })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/");
  });
});
