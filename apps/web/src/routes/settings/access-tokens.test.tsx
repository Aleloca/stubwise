import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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

  it("blocca il submit e mostra l'errore quando la scadenza è nel passato", async () => {
    const user = userEvent.setup();
    let posted = false;
    mockApi({
      "GET /api/auth/me": meHandler(),
      "GET /api/pats": () => jsonResponse(200, []),
      "POST /api/pats": () => {
        posted = true;
        return jsonResponse(201, patWithToken());
      },
    });

    renderApp("/settings/access-tokens");

    await user.type(await screen.findByLabelText("Name"), "past token");
    // datetime-local nel passato: la validazione client deve bloccare l'invio.
    fireEvent.change(screen.getByLabelText("Expiry (optional)"), {
      target: { value: "2020-01-01T00:00" },
    });
    await user.click(screen.getByRole("button", { name: "Create token" }));

    expect(await screen.findByText("The expiry must be in the future.")).toBeInTheDocument();
    // Nessuna POST è partita.
    expect(posted).toBe(false);
  });

  it("invia expiresAt come stringa ISO futura quando la scadenza è valida", async () => {
    const user = userEvent.setup();
    let postBody: { name: string; expiresAt: string | null } | undefined;
    mockApi({
      "GET /api/auth/me": meHandler(),
      "GET /api/pats": () => jsonResponse(200, []),
      "POST /api/pats": (_url, init) => {
        postBody = JSON.parse(String(init?.body));
        return jsonResponse(201, patWithToken({ name: "future token" }));
      },
    });

    renderApp("/settings/access-tokens");

    await user.type(await screen.findByLabelText("Name"), "future token");
    // Anno lontano: sicuramente nel futuro a prescindere dal fuso.
    fireEvent.change(screen.getByLabelText("Expiry (optional)"), {
      target: { value: "2999-01-01T12:00" },
    });
    await user.click(screen.getByRole("button", { name: "Create token" }));

    await waitFor(() => expect(postBody).toBeDefined());
    expect(postBody?.name).toBe("future token");
    const iso = postBody?.expiresAt;
    expect(typeof iso).toBe("string");
    expect(Number.isNaN(Date.parse(iso as string))).toBe(false);
    expect(new Date(iso as string).getTime()).toBeGreaterThan(Date.now());
  });

  it("mostra l'errore localizzato quando la creazione fallisce", async () => {
    const user = userEvent.setup();
    mockApi({
      "GET /api/auth/me": meHandler(),
      "GET /api/pats": () => jsonResponse(200, []),
      "POST /api/pats": () => jsonResponse(400, { code: "forbidden", message: "Forbidden" }),
    });

    renderApp("/settings/access-tokens");

    await user.type(await screen.findByLabelText("Name"), "boom");
    await user.click(screen.getByRole("button", { name: "Create token" }));

    // Il `code` noto viene tradotto (errors:forbidden), non mostrato grezzo.
    expect(await screen.findByText("Administrators only")).toBeInTheDocument();
    expect(screen.queryByText("Forbidden")).not.toBeInTheDocument();
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

    // Revoca a due passi: prima "Revoke", poi la conferma. I bottoni hanno un
    // aria-label per-riga che include il nome del token.
    await user.click(screen.getByRole("button", { name: "Revoke token to revoke" }));
    await user.click(screen.getByRole("button", { name: "Confirm revoking token to revoke" }));

    await waitFor(() => expect(deletePath).toBe("/api/pats/pat-9"));
    await waitFor(() => expect(screen.queryByText("to revoke")).not.toBeInTheDocument());
    expect(await screen.findByText("// no tokens yet")).toBeInTheDocument();
  });
});
