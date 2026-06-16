import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAppRouter } from "./router";

/**
 * Smoke test della guardia di routing con fetch mockato per URL: verifica
 * dove si atterra entrando da "/" nei tre stati possibili dell'istanza.
 */

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  fetchMock.mockReset();
});

function mockApi(routes: Record<string, () => Response>) {
  fetchMock.mockImplementation((input) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const path = url.replace(/^https?:\/\/[^/]+/, "");
    const handler = routes[path];
    if (!handler) throw new Error(`fetch non mockato per ${url}`);
    return Promise.resolve(handler());
  });
}

function renderApp() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const router = createAppRouter(queryClient, createMemoryHistory({ initialEntries: ["/"] }));
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return router;
}

describe("guardia di routing", () => {
  it("non autenticato e setup già fatto: da / si finisce su /login", async () => {
    mockApi({
      "/api/auth/me": () => jsonResponse(401, { message: "Non autenticato" }),
      "/api/auth/setup": () => jsonResponse(200, { needed: false }),
    });

    const router = renderApp();

    expect(await screen.findByRole("heading", { name: "Sign in" })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/login");
  });

  it("non autenticato e istanza vergine: da / si finisce su /setup", async () => {
    mockApi({
      "/api/auth/me": () => jsonResponse(401, { message: "Non autenticato" }),
      "/api/auth/setup": () => jsonResponse(200, { needed: true }),
    });

    const router = renderApp();

    expect(
      await screen.findByRole("heading", { name: /administrator account/i }),
    ).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/setup");
  });

  it("autenticato: da / si finisce su /tickets dentro il layout con nav e email", async () => {
    mockApi({
      "/api/auth/me": () =>
        jsonResponse(200, { user: { id: "u1", email: "ada@example.com", role: "admin" } }),
      // Il loader di /tickets precarica lista e progetti.
      "/api/tickets": () => jsonResponse(200, { items: [], nextCursor: null }),
      "/api/projects": () => jsonResponse(200, []),
    });

    const router = renderApp();

    expect(await screen.findByRole("heading", { name: "Tickets" })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/tickets");
    expect(screen.getByRole("link", { name: /board/i })).toBeInTheDocument();
    expect(screen.getByText("ada@example.com")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /sign out/i })).toBeInTheDocument();
  });
});
