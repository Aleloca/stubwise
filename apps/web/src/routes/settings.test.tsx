import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAppRouter } from "../router";

/**
 * Pagina impostazioni: solo i dati dell'account corrente. La gestione degli
 * accessi (membri e inviti) è stata spostata nella pagina Team.
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

type Handler = (url: URL, init?: RequestInit) => Response;

function mockApi(handlers: Record<string, Handler>) {
  fetchMock.mockImplementation((input, init) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(raw, "http://test.local");
    const method = init?.method ?? "GET";
    const handler = handlers[`${method} ${url.pathname}`];
    if (!handler) throw new Error(`fetch non mockata per ${method} ${raw}`);
    return Promise.resolve(handler(url, init));
  });
}

function renderSettings() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createAppRouter(
    queryClient,
    createMemoryHistory({ initialEntries: ["/settings"] }),
  );
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return router;
}

describe("impostazioni", () => {
  it("admin: mostra email e ruolo dell'account, niente gestione inviti", async () => {
    mockApi({
      "GET /api/auth/me": () =>
        jsonResponse(200, { user: { id: "u1", email: "ada@example.com", role: "admin" } }),
    });

    renderSettings();

    expect(await screen.findByRole("heading", { name: "Settings" })).toBeInTheDocument();
    // L'email compare nel pannello account (oltre che nella sidebar).
    expect(screen.getAllByText("ada@example.com").length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText("Admin")).toBeInTheDocument();
    // La gestione degli inviti è migrata nella pagina Team.
    expect(screen.queryByRole("button", { name: "Crea invito" })).not.toBeInTheDocument();
  });

  it("member: pannello account con ruolo Member", async () => {
    mockApi({
      "GET /api/auth/me": () =>
        jsonResponse(200, { user: { id: "u2", email: "bea@example.com", role: "member" } }),
    });

    renderSettings();

    expect(await screen.findByText("Member")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Crea invito" })).not.toBeInTheDocument();
  });
});
