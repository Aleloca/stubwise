import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAppRouter } from "../router";

/**
 * Registrazione su invito: pagina pubblica, token prefillato dall'URL,
 * dopo il 201 login automatico e atterraggio su /tickets.
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

function renderApp(initialPath: string) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createAppRouter(
    queryClient,
    createMemoryHistory({ initialEntries: [initialPath] }),
  );
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return router;
}

describe("registrazione su invito", () => {
  it("token prefillato dall'URL; register + login e si atterra su /tickets", async () => {
    const user = userEvent.setup();
    let registerBody: unknown;
    mockApi({
      "POST /api/auth/register": (_url, init) => {
        registerBody = JSON.parse(String(init?.body));
        return jsonResponse(201, {
          user: { id: "u2", email: "bea@example.com", role: "member" },
        });
      },
      "POST /api/auth/login": () =>
        jsonResponse(200, { user: { id: "u2", email: "bea@example.com", role: "member" } }),
      "GET /api/tickets": () => jsonResponse(200, { items: [], nextCursor: null }),
      "GET /api/projects": () => jsonResponse(200, []),
    });

    const router = renderApp("/register?token=tok-segreto-123");

    expect(
      await screen.findByRole("heading", { name: "Crea il tuo account" }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Token di invito")).toHaveValue("tok-segreto-123");

    await user.type(screen.getByLabelText("Email"), "bea@example.com");
    await user.type(screen.getByLabelText("Password"), "password-sicura");
    await user.click(screen.getByRole("button", { name: "Registrati" }));

    await waitFor(() => expect(router.state.location.pathname).toBe("/tickets"));
    expect(registerBody).toEqual({
      email: "bea@example.com",
      password: "password-sicura",
      token: "tok-segreto-123",
    });
  });

  it("invito scaduto: il 410 del server diventa errore visibile", async () => {
    const user = userEvent.setup();
    mockApi({
      "POST /api/auth/register": () => jsonResponse(410, { message: "Invito scaduto" }),
    });

    renderApp("/register?token=tok-vecchio");

    await screen.findByRole("heading", { name: "Crea il tuo account" });
    await user.type(screen.getByLabelText("Email"), "bea@example.com");
    await user.type(screen.getByLabelText("Password"), "password-sicura");
    await user.click(screen.getByRole("button", { name: "Registrati" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Invito scaduto");
  });
});
