import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAppRouter } from "../router";

/**
 * Pagina impostazioni: dati dell'account corrente e, per gli admin, le regole
 * di automazione AI. La gestione degli accessi (membri e inviti) è nella
 * pagina Team.
 */

const DEFAULT_AUTOMATION = {
  rules: [
    { type: "bug", autoFix: true, maxEffort: 3 },
    { type: "task", autoFix: true, maxEffort: 2 },
    { type: "feature", autoFix: false, maxEffort: 3 },
    { type: "feedback", autoFix: false, maxEffort: 3 },
  ],
};

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
      "GET /api/settings/automation": () => jsonResponse(200, DEFAULT_AUTOMATION),
      // La sezione "Account Git" (solo admin) carica gli account.
      "GET /api/git-accounts": () => jsonResponse(200, []),
    });

    renderSettings();

    expect(await screen.findByRole("heading", { name: "Settings" })).toBeInTheDocument();
    // L'email compare nel pannello account (oltre che nella sidebar).
    expect(screen.getAllByText("ada@example.com").length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText("Admin")).toBeInTheDocument();
    // La gestione degli inviti è migrata nella pagina Team.
    expect(screen.queryByRole("button", { name: "Crea invito" })).not.toBeInTheDocument();
    // La sezione "Account Git" è presente per gli admin.
    expect(screen.getByRole("heading", { name: "Account Git" })).toBeInTheDocument();
  });

  it("member: pannello account con ruolo Member, niente sezione Automazione AI", async () => {
    mockApi({
      "GET /api/auth/me": () =>
        jsonResponse(200, { user: { id: "u2", email: "bea@example.com", role: "member" } }),
    });

    renderSettings();

    expect(await screen.findByText("Member")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Crea invito" })).not.toBeInTheDocument();
    // La sezione automazione è riservata agli admin.
    expect(screen.queryByText("Automazione AI")).not.toBeInTheDocument();
    // Anche la sezione "Account Git" è riservata agli admin.
    expect(screen.queryByRole("heading", { name: "Account Git" })).not.toBeInTheDocument();
  });
});

describe("automazione AI (admin)", () => {
  it("rende le 4 regole con toggle e soglia di sforzo", async () => {
    mockApi({
      "GET /api/auth/me": () =>
        jsonResponse(200, { user: { id: "u1", email: "ada@example.com", role: "admin" } }),
      "GET /api/settings/automation": () => jsonResponse(200, DEFAULT_AUTOMATION),
      // La sezione "Account Git" (solo admin) carica gli account.
      "GET /api/git-accounts": () => jsonResponse(200, []),
    });

    renderSettings();

    const heading = await screen.findByText("Automazione AI");
    const section = heading.closest("section") as HTMLElement;
    const scope = within(section);
    // Un toggle e una soglia per ciascuno dei 4 tipi.
    expect(scope.getByLabelText("Auto-fix bug")).toBeChecked();
    expect(scope.getByLabelText("Auto-fix feature")).not.toBeChecked();
    expect((scope.getByLabelText("Soglia effort task") as HTMLSelectElement).value).toBe("2");
  });

  it("salva tutte le regole via PUT e mostra la conferma", async () => {
    let putBody: unknown = null;
    mockApi({
      "GET /api/auth/me": () =>
        jsonResponse(200, { user: { id: "u1", email: "ada@example.com", role: "admin" } }),
      "GET /api/settings/automation": () => jsonResponse(200, DEFAULT_AUTOMATION),
      "GET /api/git-accounts": () => jsonResponse(200, []),
      "PUT /api/settings/automation": (_url, init) => {
        putBody = JSON.parse(String(init?.body));
        return jsonResponse(200, {
          rules: DEFAULT_AUTOMATION.rules.map((r) =>
            r.type === "bug" ? { ...r, autoFix: false } : r,
          ),
        });
      },
    });

    renderSettings();

    const toggle = (await screen.findByLabelText("Auto-fix bug")) as HTMLInputElement;
    await userEvent.click(toggle); // bug: true → false
    await userEvent.click(screen.getByRole("button", { name: "Salva" }));

    await waitFor(() => expect(putBody).not.toBeNull());
    const body = putBody as { rules: { type: string; autoFix: boolean }[] };
    expect(body.rules.find((r) => r.type === "bug")?.autoFix).toBe(false);
    // Conferma di salvataggio.
    expect(await screen.findByText("Salvato")).toBeInTheDocument();
  });
});
