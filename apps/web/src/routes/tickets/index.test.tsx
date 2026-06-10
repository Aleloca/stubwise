import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Ticket } from "../../lib/api";
import { createAppRouter } from "../../router";

/**
 * Test della lista con il router vero (memory history) e fetch mockata a
 * livello di rete: nessun mock di moduli, si esercita la catena completa
 * validateSearch → loader → query → componenti.
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
  vi.restoreAllMocks();
  fetchMock.mockReset();
});

function mockApi(handlers: Record<string, (url: URL) => Response>) {
  fetchMock.mockImplementation((input) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(raw, "http://test.local");
    const handler = handlers[url.pathname];
    if (!handler) throw new Error(`fetch non mockato per ${raw}`);
    return Promise.resolve(handler(url));
  });
}

function makeTicket(overrides: Partial<Ticket>): Ticket {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    projectId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    number: 1,
    title: "Ticket di prova",
    body: "",
    type: "bug",
    priority: "medium",
    status: "open",
    source: "manual",
    assigneeId: null,
    labels: [],
    technicalPayload: null,
    occurrences: 1,
    lastSeenAt: "2026-06-01T10:00:00.000Z",
    createdAt: "2026-06-01T10:00:00.000Z",
    updatedAt: "2026-06-01T10:00:00.000Z",
    ...overrides,
  };
}

const PROJECT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

const baseHandlers = {
  "/api/auth/me": () =>
    jsonResponse(200, { user: { id: "u1", email: "ada@example.com", role: "admin" } }),
  "/api/projects": () =>
    jsonResponse(200, [
      {
        id: PROJECT_ID,
        name: "Progetto Alfa",
        slug: "progetto-alfa",
        provider: "github",
        repoUrl: "https://github.com/acme/alfa",
        defaultBranch: "main",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    ]),
};

function renderApp(initialPath = "/tickets") {
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

describe("lista ticket", () => {
  it("renderizza le righe: numero, titolo, progetto, badge, occorrenze e link al dettaglio", async () => {
    const crash = makeTicket({
      id: "11111111-1111-4111-8111-111111111111",
      number: 42,
      title: "Crash al checkout",
      type: "bug",
      priority: "urgent",
      status: "open",
      source: "sdk_error",
      occurrences: 7,
      labels: ["pagamenti"],
    });
    const feature = makeTicket({
      id: "22222222-2222-4222-8222-222222222222",
      number: 41,
      title: "Export CSV degli ordini",
      type: "feature",
      priority: "low",
      status: "done",
    });
    mockApi({
      ...baseHandlers,
      "/api/tickets": () => jsonResponse(200, { items: [crash, feature], nextCursor: null }),
    });

    renderApp();

    expect(await screen.findByText("Crash al checkout")).toBeInTheDocument();

    // Badge ed etichette verificati dentro la riga: i filtri in pagina
    // contengono le stesse parole nelle option dei select.
    const row = screen.getByRole("link", { name: /crash al checkout/i });
    expect(row).toHaveAttribute("href", `/tickets/${crash.id}`);
    expect(within(row).getByText("#42")).toBeInTheDocument();
    expect(within(row).getByText("Progetto Alfa")).toBeInTheDocument();
    expect(within(row).getByText("Urgente")).toBeInTheDocument();
    expect(within(row).getByText("Aperto")).toBeInTheDocument();
    expect(within(row).getByText("×7")).toBeInTheDocument();
    expect(within(row).getByText("pagamenti")).toBeInTheDocument();

    const doneRow = screen.getByRole("link", { name: /export csv/i });
    expect(within(doneRow).getByText("Fatto")).toBeInTheDocument();
  });

  it("senza risultati mostra lo stato vuoto", async () => {
    mockApi({
      ...baseHandlers,
      "/api/tickets": () => jsonResponse(200, { items: [], nextCursor: null }),
    });

    renderApp();

    expect(await screen.findByText(/nessun ticket trovato/i)).toBeInTheDocument();
  });

  it("i filtri nell'URL arrivano ai controlli e alla richiesta API", async () => {
    const seen: string[] = [];
    mockApi({
      ...baseHandlers,
      "/api/tickets": (url) => {
        seen.push(url.search);
        return jsonResponse(200, { items: [], nextCursor: null });
      },
    });

    renderApp("/tickets?status=done&q=export");

    expect(await screen.findByLabelText(/stato/i)).toHaveValue("done");
    expect(screen.getByRole("searchbox", { name: /cerca/i })).toHaveValue("export");
    expect(seen[0]).toContain("status=done");
    expect(seen[0]).toContain("q=export");
  });

  it("un search param malformato viene scartato invece di rompere la route", async () => {
    mockApi({
      ...baseHandlers,
      "/api/tickets": () => jsonResponse(200, { items: [], nextCursor: null }),
    });

    const router = renderApp("/tickets?status=inesistente");

    expect(await screen.findByLabelText(/stato/i)).toHaveValue("");
    expect(router.state.location.search).toEqual({});
  });

  it("cambiare un filtro aggiorna l'URL e rifà la richiesta filtrata", async () => {
    mockApi({
      ...baseHandlers,
      "/api/tickets": (url) =>
        url.searchParams.get("status") === "open"
          ? jsonResponse(200, {
              items: [makeTicket({ title: "Solo gli aperti" })],
              nextCursor: null,
            })
          : jsonResponse(200, {
              items: [makeTicket({ title: "Tutti i ticket" })],
              nextCursor: null,
            }),
    });

    const router = renderApp();
    expect(await screen.findByText("Tutti i ticket")).toBeInTheDocument();

    await userEvent.selectOptions(screen.getByLabelText(/stato/i), "open");

    expect(await screen.findByText("Solo gli aperti")).toBeInTheDocument();
    expect(router.state.location.search).toEqual({ status: "open" });
  });

  it("«Carica altri» appende la pagina successiva usando il cursore", async () => {
    const first = makeTicket({
      id: "11111111-1111-4111-8111-111111111111",
      number: 2,
      title: "Pagina uno",
    });
    const second = makeTicket({
      id: "22222222-2222-4222-8222-222222222222",
      number: 1,
      title: "Pagina due",
    });
    mockApi({
      ...baseHandlers,
      "/api/tickets": (url) =>
        url.searchParams.get("cursor") === "cursore-1"
          ? jsonResponse(200, { items: [second], nextCursor: null })
          : jsonResponse(200, { items: [first], nextCursor: "cursore-1" }),
    });

    renderApp();
    expect(await screen.findByText("Pagina uno")).toBeInTheDocument();
    expect(screen.queryByText("Pagina due")).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /carica altri/i }));

    expect(await screen.findByText("Pagina due")).toBeInTheDocument();
    // Le righe della prima pagina restano: append, non replace.
    expect(screen.getByText("Pagina uno")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /carica altri/i })).not.toBeInTheDocument();
  });

  it("401 dal loader (sessione scaduta ad app montata): si atterra su /login", async () => {
    // L'errore del loader catturato dal boundary sporca la console: rumore
    // atteso, silenziato solo per questo test (restore in afterEach globale).
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    mockApi({
      ...baseHandlers,
      "/api/tickets": () => jsonResponse(401, { message: "Non autenticato" }),
    });

    const router = renderApp();

    expect(await screen.findByRole("heading", { name: "Accedi" })).toBeInTheDocument();
    await waitFor(() => expect(router.state.location.pathname).toBe("/login"));
  });
});
