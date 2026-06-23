import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { act, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useCloseOnRouteChange } from "./use-close-on-route-change";

/**
 * useCloseOnRouteChange: usa lo stato del router TanStack (memory history nei
 * test) per chiamare `close` quando cambia il pathname. Si monta un mini-router
 * con due rotte e si naviga via history per verificare la chiamata al cambio di
 * pathname (ma non sul cambio di solo search param).
 *
 * La navigazione è guidata dalla `history` (non da <Link>) per non urtare contro
 * il modulo `Register` globale che tipa i path sulle rotte reali dell'app.
 */
function Probe({ close }: { close: () => void }) {
  useCloseOnRouteChange(close);
  return <Outlet />;
}

function buildRouter(close: () => void, initialPath = "/a") {
  const rootRoute = createRootRoute({ component: () => <Probe close={close} /> });
  const aRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/a",
    validateSearch: (s: Record<string, unknown>) => ({ q: (s.q as string) ?? "" }),
    component: () => <p>page-a</p>,
  });
  const bRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/b",
    component: () => <p>page-b</p>,
  });
  return createRouter({
    routeTree: rootRoute.addChildren([aRoute, bRoute]),
    history: createMemoryHistory({ initialEntries: [initialPath] }),
  });
}

describe("useCloseOnRouteChange", () => {
  it("chiama close quando cambia il pathname", async () => {
    const close = vi.fn();
    const router = buildRouter(close);
    render(<RouterProvider router={router as never} />);
    await screen.findByText("page-a");
    // Il primo effect monta con close già invocato una volta.
    close.mockClear();

    await act(async () => {
      router.history.push("/b");
    });
    await screen.findByText("page-b");
    await waitFor(() => expect(close).toHaveBeenCalledTimes(1));
  });

  it("non richiama close sul cambio del solo search param (stesso pathname)", async () => {
    const close = vi.fn();
    const router = buildRouter(close);
    render(<RouterProvider router={router as never} />);
    await screen.findByText("page-a");
    close.mockClear();

    await act(async () => {
      router.history.push("/a?q=x");
    });
    // Diamo tempo a un eventuale effect spurio di scattare.
    await new Promise((r) => setTimeout(r, 50));
    expect(close).not.toHaveBeenCalled();
  });
});
