import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAppRouter } from "../router";

/**
 * Pagina pubblica di reset della password (`/reset-password/$token`): dice per
 * quale account vale il link, chiede la password due volte, a buon fine
 * rimanda al login. Un link non valido dà un messaggio chiaro e niente form.
 */

function jsonResponse(status: number, body: unknown): Response {
  return new Response(status === 204 ? null : JSON.stringify(body), {
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

const INVALID = { code: "password_reset_invalid", message: "Password reset link invalid or expired" };

describe("reset della password da link", () => {
  it("mostra l'account, imposta la password e porta al login", async () => {
    const user = userEvent.setup();
    let postBody: unknown;
    mockApi({
      "GET /api/auth/password-reset/tok-123": () =>
        jsonResponse(200, { email: "bea@example.com", expiresAt: "2026-10-22T10:00:00.000Z" }),
      "POST /api/auth/password-reset/tok-123": (_url, init) => {
        postBody = JSON.parse(String(init?.body));
        return jsonResponse(204, null);
      },
    });

    const router = renderApp("/reset-password/tok-123");

    expect(
      await screen.findByRole("heading", { name: "Choose a new password" }),
    ).toBeInTheDocument();
    expect(screen.getByText(/bea@example\.com/)).toBeInTheDocument();

    await user.type(screen.getByLabelText("New password"), "password-nuova");
    await user.type(screen.getByLabelText("Confirm password"), "password-nuova");
    await user.click(screen.getByRole("button", { name: "Set password" }));

    expect(await screen.findByText(/Your password has been changed/)).toBeInTheDocument();
    expect(postBody).toEqual({ password: "password-nuova" });

    await user.click(screen.getByRole("link", { name: "Go to sign in" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/login"));
  });

  it("le due password non coincidono: errore e nessuna richiesta", async () => {
    const user = userEvent.setup();
    let posted = false;
    mockApi({
      "GET /api/auth/password-reset/tok-123": () =>
        jsonResponse(200, { email: "bea@example.com", expiresAt: "2026-10-22T10:00:00.000Z" }),
      "POST /api/auth/password-reset/tok-123": () => {
        posted = true;
        return jsonResponse(204, null);
      },
    });

    renderApp("/reset-password/tok-123");

    await user.type(await screen.findByLabelText("New password"), "password-nuova");
    await user.type(screen.getByLabelText("Confirm password"), "password-diversa");
    await user.click(screen.getByRole("button", { name: "Set password" }));

    expect(await screen.findByText("Passwords do not match")).toBeInTheDocument();
    expect(posted).toBe(false);
  });

  it("link non valido: messaggio chiaro, niente form", async () => {
    mockApi({
      "GET /api/auth/password-reset/tok-morto": () => jsonResponse(410, INVALID),
    });

    renderApp("/reset-password/tok-morto");

    expect(await screen.findByRole("heading", { name: "Link not valid" })).toBeInTheDocument();
    expect(screen.getByText(/invalid, expired or already used/)).toBeInTheDocument();
    expect(screen.queryByLabelText("New password")).not.toBeInTheDocument();
  });

  it("il link scade fra l'apertura e l'invio: l'errore del server si vede sul form", async () => {
    const user = userEvent.setup();
    mockApi({
      "GET /api/auth/password-reset/tok-123": () =>
        jsonResponse(200, { email: "bea@example.com", expiresAt: "2026-10-22T10:00:00.000Z" }),
      "POST /api/auth/password-reset/tok-123": () => jsonResponse(410, INVALID),
    });

    renderApp("/reset-password/tok-123");

    await user.type(await screen.findByLabelText("New password"), "password-nuova");
    await user.type(screen.getByLabelText("Confirm password"), "password-nuova");
    await user.click(screen.getByRole("button", { name: "Set password" }));

    expect(
      await screen.findByText("This password reset link is invalid, expired or already used"),
    ).toBeInTheDocument();
  });

  it.each([
    ["429", () => jsonResponse(429, { message: "Too many requests" })],
    ["500", () => jsonResponse(500, { message: "Internal error" })],
  ])("un errore %s non dice «link non valido»: messaggio generico e riprova", async (_label, respond) => {
    const user = userEvent.setup();
    let calls = 0;
    mockApi({
      "GET /api/auth/password-reset/tok-123": () => {
        calls += 1;
        return calls === 1
          ? respond()
          : jsonResponse(200, { email: "bea@example.com", expiresAt: "2026-10-22T10:00:00.000Z" });
      },
    });

    renderApp("/reset-password/tok-123");

    expect(
      await screen.findByRole("heading", { name: "Could not check the link" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Link not valid" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByLabelText("New password")).toBeInTheDocument();
  });

  it("errore di rete: stesso messaggio generico", async () => {
    fetchMock.mockImplementation(() => Promise.reject(new TypeError("Failed to fetch")));

    renderApp("/reset-password/tok-123");

    expect(
      await screen.findByRole("heading", { name: "Could not check the link" }),
    ).toBeInTheDocument();
  });
});
