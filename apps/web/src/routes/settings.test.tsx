import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAppRouter } from "../router";

/**
 * Pagina impostazioni: account per tutti, pannello inviti solo admin.
 * L'invito creato mostra il link /register?token=… pronto da copiare.
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
  it("admin: email, ruolo e creazione invito con link di registrazione", async () => {
    const user = userEvent.setup();
    let postBody: unknown;
    mockApi({
      "GET /api/auth/me": () =>
        jsonResponse(200, { user: { id: "u1", email: "ada@example.com", role: "admin" } }),
      "POST /api/auth/invites": (_url, init) => {
        postBody = JSON.parse(String(init?.body));
        return jsonResponse(201, {
          token: "tok-segreto-123",
          expiresAt: "2026-06-17T10:00:00.000Z",
        });
      },
    });

    renderSettings();

    expect(await screen.findByRole("heading", { name: "Settings" })).toBeInTheDocument();
    // L'email compare nel pannello account (oltre che nella sidebar).
    expect(screen.getAllByText("ada@example.com").length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText("Admin")).toBeInTheDocument();

    await user.type(screen.getByLabelText("Email"), "collega@example.com");
    await user.click(screen.getByRole("button", { name: "Crea invito" }));

    expect(postBody).toEqual({ email: "collega@example.com" });
    const link = await screen.findByTestId("invite-url");
    expect(link.textContent).toContain("/register?token=tok-segreto-123");
    expect(screen.getByRole("button", { name: "Copia link di invito" })).toBeInTheDocument();
  });

  it("member: pannello account senza inviti", async () => {
    mockApi({
      "GET /api/auth/me": () =>
        jsonResponse(200, { user: { id: "u2", email: "bea@example.com", role: "member" } }),
    });

    renderSettings();

    expect(await screen.findByText("Member")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Crea invito" })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Email")).not.toBeInTheDocument();
  });
});
