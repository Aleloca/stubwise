import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PatView, PatWithToken } from "../../lib/api";
import { createAppRouter } from "../../router";

/**
 * Sotto-pagina Impostazioni → Token di accesso (`/settings/access-tokens`) col
 * router vero (memory history) e fetch mockata: elenco dei PAT, creazione con
 * rivelazione una-tantum del token in chiaro e revoca con conferma. Verifica che
 * nessuna chiave i18n grezza finisca a schermo.
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

function meHandler(role: "admin" | "member" = "member"): Handler {
  return () => jsonResponse(200, { user: { id: "u1", email: "ada@example.com", role } });
}

function pat(overrides: Partial<PatView> = {}): PatView {
  return {
    id: "pat-1",
    name: "Default token",
    lastUsedAt: null,
    expiresAt: null,
    createdAt: "2026-06-01T10:00:00.000Z",
    ...overrides,
  };
}

function patWithToken(overrides: Partial<PatWithToken> = {}): PatWithToken {
  return { ...pat(), token: "stw_pat_secret_value_123", ...overrides };
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

describe("Impostazioni — token di accesso", () => {
  it("elenca i token esistenti coi metadati", async () => {
    mockApi({
      "GET /api/auth/me": meHandler(),
      "GET /api/pats": () =>
        jsonResponse(200, [
          pat({ id: "pat-1", name: "laptop MCP", lastUsedAt: null, expiresAt: null }),
          pat({ id: "pat-2", name: "CI token", createdAt: "2026-05-01T09:00:00.000Z" }),
        ]),
    });

    renderApp("/settings/access-tokens");

    expect(await screen.findByText("laptop MCP")).toBeInTheDocument();
    expect(screen.getByText("CI token")).toBeInTheDocument();
    // "Never" per token mai usati / senza scadenza.
    expect(screen.getAllByText("Never").length).toBeGreaterThan(0);
    // Nessuna chiave i18n grezza a schermo.
    expect(document.body.textContent ?? "").not.toMatch(/settings:/);
  });

  it("stato vuoto quando non ci sono token", async () => {
    mockApi({
      "GET /api/auth/me": meHandler(),
      "GET /api/pats": () => jsonResponse(200, []),
    });

    renderApp("/settings/access-tokens");

    expect(await screen.findByText("// no tokens yet")).toBeInTheDocument();
  });

  it("crea un token e ne rivela il valore in chiaro una sola volta", async () => {
    const user = userEvent.setup();
    let postBody: unknown;
    mockApi({
      "GET /api/auth/me": meHandler(),
      "GET /api/pats": () => jsonResponse(200, []),
      "POST /api/pats": (_url, init) => {
        postBody = JSON.parse(String(init?.body));
        return jsonResponse(201, patWithToken({ name: "laptop MCP" }));
      },
    });

    renderApp("/settings/access-tokens");

    await user.type(await screen.findByLabelText("Name"), "laptop MCP");
    await user.click(screen.getByRole("button", { name: "Create token" }));

    // Il token in chiaro compare nel pannello di rivelazione, con avviso one-shot.
    expect(await screen.findByText("stw_pat_secret_value_123")).toBeInTheDocument();
    expect(screen.getByText(/shown only once/i)).toBeInTheDocument();

    // Nome inviato, scadenza null (campo lasciato vuoto).
    await waitFor(() => expect(postBody).toEqual({ name: "laptop MCP", expiresAt: null }));

    // Chiudendo il pannello il token sparisce e riappare il form.
    await user.click(screen.getByRole("button", { name: "Done" }));
    expect(screen.queryByText("stw_pat_secret_value_123")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create token" })).toBeInTheDocument();
  });

  it("revoca un token con conferma e lo rimuove dalla lista", async () => {
    const user = userEvent.setup();
    let deleted = false;
    let deletePath: string | null = null;
    mockApi({
      "GET /api/auth/me": meHandler(),
      "GET /api/pats": () =>
        jsonResponse(200, deleted ? [] : [pat({ id: "pat-9", name: "to revoke" })]),
      "DELETE /api/pats/pat-9": (url) => {
        deleted = true;
        deletePath = url.pathname;
        return new Response(null, { status: 204 });
      },
    });

    renderApp("/settings/access-tokens");

    expect(await screen.findByText("to revoke")).toBeInTheDocument();

    // Revoca a due passi: prima "Revoke", poi la conferma.
    await user.click(screen.getByRole("button", { name: "Revoke" }));
    await user.click(screen.getByRole("button", { name: "Confirm revoke" }));

    await waitFor(() => expect(deletePath).toBe("/api/pats/pat-9"));
    await waitFor(() => expect(screen.queryByText("to revoke")).not.toBeInTheDocument());
    expect(await screen.findByText("// no tokens yet")).toBeInTheDocument();
  });
});
