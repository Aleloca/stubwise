import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BacklogItem } from "../../lib/api";
import { createAppRouter } from "../../router";

/**
 * Test della lista backlog col router vero (memory history) e fetch mockata a
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

const PROJECT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function makeItem(overrides: Partial<BacklogItem>): BacklogItem {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    projectId: PROJECT_ID,
    title: "Idea di prova",
    status: "new",
    effort: null,
    risk: null,
    riskNote: null,
    urgency: null,
    requestCount: 1,
    source: "manual",
    similarTo: null,
    ticketCount: 0,
    createdAt: "2026-06-01T10:00:00.000Z",
    updatedAt: "2026-06-01T10:00:00.000Z",
    ...overrides,
  };
}

const baseHandlers = {
  "/api/auth/me": () =>
    jsonResponse(200, { user: { id: "u1", email: "ada@example.com", role: "admin" } }),
  "/api/projects": () =>
    jsonResponse(200, [
      {
        id: PROJECT_ID,
        name: "Progetto Alfa",
        slug: "progetto-alfa",
        description: null,
        aiProviderId: null,
        docAutoUpdate: false,
        dailyReportEnabled: false,
        backlogEnabled: true,
        ingestionKey: "key-alfa",
        nextTicketNumber: 1,
        repositoryCount: 1,
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    ]),
};

function renderApp(initialPath = "/backlog") {
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

describe("lista backlog", () => {
  it("renderizza le card: titolo/link, badge (effort/rischio/urgenza/stato), pill richieste e simile", async () => {
    const checkout = makeItem({
      id: "11111111-1111-4111-8111-111111111111",
      title: "Export massivo ordini",
      status: "ready",
      effort: 3,
      risk: "medium",
      urgency: "high",
      requestCount: 4,
      ticketCount: 2,
      similarTo: { id: "99999999-9999-4999-8999-999999999999", title: "Export CSV" },
    });
    const bare = makeItem({
      id: "22222222-2222-4222-8222-222222222222",
      title: "Idea grezza",
      status: "new",
    });
    mockApi({
      ...baseHandlers,
      "/api/backlog": () => jsonResponse(200, { items: [checkout, bare], nextCursor: null }),
    });

    renderApp();

    expect(await screen.findByText("Export massivo ordini")).toBeInTheDocument();

    const card = screen.getByRole("link", { name: /export massivo ordini/i });
    // La route dettaglio non esiste ancora (Task 20): ancora col path letterale.
    expect(card).toHaveAttribute("href", `/backlog/${checkout.id}`);
    expect(within(card).getByText("Progetto Alfa")).toBeInTheDocument();
    expect(within(card).getByText("E3")).toBeInTheDocument();
    expect(within(card).getByText("Medium risk")).toBeInTheDocument();
    expect(within(card).getByText("High")).toBeInTheDocument();
    expect(within(card).getByText("Ready")).toBeInTheDocument();
    // Pill "richiesto N volte" con N > 1.
    expect(within(card).getByText("×4")).toBeInTheDocument();
    // Pill "≈ simile a <titolo>".
    expect(within(card).getByText(/≈ similar to Export CSV/)).toBeInTheDocument();
    // Conteggio ticket collegati.
    expect(within(card).getByText("2 linked tickets")).toBeInTheDocument();

    // La card senza metadati non mostra badge opzionali né le pill.
    const bareCard = screen.getByRole("link", { name: /idea grezza/i });
    expect(within(bareCard).getByText("New")).toBeInTheDocument();
    expect(within(bareCard).queryByText(/^E\d$/)).not.toBeInTheDocument();
    expect(within(bareCard).queryByText(/^×\d+$/)).not.toBeInTheDocument();
    expect(within(bareCard).queryByText(/≈ similar to/)).not.toBeInTheDocument();
  });

  it("senza risultati mostra lo stato vuoto", async () => {
    mockApi({
      ...baseHandlers,
      "/api/backlog": () => jsonResponse(200, { items: [], nextCursor: null }),
    });

    renderApp();

    expect(await screen.findByText(/no backlog items/i)).toBeInTheDocument();
  });

  it("i filtri nell'URL arrivano ai controlli e alla richiesta API", async () => {
    let seen: URLSearchParams | undefined;
    mockApi({
      ...baseHandlers,
      "/api/backlog": (url) => {
        seen = url.searchParams;
        return jsonResponse(200, { items: [], nextCursor: null });
      },
    });

    renderApp(`/backlog?projectId=${PROJECT_ID}&status=ready&urgency=high&risk=medium&q=export`);

    expect(await screen.findByLabelText("Status")).toHaveValue("ready");
    expect(screen.getByLabelText("Project")).toHaveValue(PROJECT_ID);
    expect(screen.getByLabelText("Urgency")).toHaveValue("high");
    expect(screen.getByLabelText("Risk")).toHaveValue("medium");
    expect(screen.getByRole("searchbox", { name: /search/i })).toHaveValue("export");
    expect(seen?.get("projectId")).toBe(PROJECT_ID);
    expect(seen?.get("status")).toBe("ready");
    expect(seen?.get("urgency")).toBe("high");
    expect(seen?.get("risk")).toBe("medium");
    expect(seen?.get("q")).toBe("export");
  });

  it("senza status di default non manda alcun parametro di stato (default lato server)", async () => {
    let seen: URLSearchParams | undefined;
    mockApi({
      ...baseHandlers,
      "/api/backlog": (url) => {
        seen = url.searchParams;
        return jsonResponse(200, { items: [], nextCursor: null });
      },
    });

    renderApp("/backlog");

    await screen.findByText(/no backlog items/i);
    expect(screen.getByLabelText("Status")).toHaveValue("");
    expect(seen?.get("status")).toBeNull();
  });

  it("un search param malformato viene scartato invece di rompere la route", async () => {
    mockApi({
      ...baseHandlers,
      "/api/backlog": () => jsonResponse(200, { items: [], nextCursor: null }),
    });

    const router = renderApp("/backlog?status=inesistente");

    expect(await screen.findByLabelText("Status")).toHaveValue("");
    expect(router.state.location.search).toEqual({});
  });

  it("cambiare un filtro aggiorna l'URL e rifà la richiesta filtrata", async () => {
    mockApi({
      ...baseHandlers,
      "/api/backlog": (url) =>
        url.searchParams.get("status") === "ready"
          ? jsonResponse(200, {
              items: [makeItem({ title: "Solo le pronte", status: "ready" })],
              nextCursor: null,
            })
          : jsonResponse(200, {
              items: [makeItem({ title: "Tutte le idee" })],
              nextCursor: null,
            }),
    });

    const router = renderApp();
    expect(await screen.findByText("Tutte le idee")).toBeInTheDocument();

    await userEvent.selectOptions(screen.getByLabelText("Status"), "ready");

    expect(await screen.findByText("Solo le pronte")).toBeInTheDocument();
    expect(router.state.location.search).toEqual({ status: "ready" });
  });

  it("«Carica altri» appende la pagina successiva usando il cursore", async () => {
    const first = makeItem({
      id: "11111111-1111-4111-8111-111111111111",
      title: "Pagina uno",
    });
    const second = makeItem({
      id: "22222222-2222-4222-8222-222222222222",
      title: "Pagina due",
    });
    mockApi({
      ...baseHandlers,
      "/api/backlog": (url) =>
        url.searchParams.get("cursor") === "cursore-1"
          ? jsonResponse(200, { items: [second], nextCursor: null })
          : jsonResponse(200, { items: [first], nextCursor: "cursore-1" }),
    });

    renderApp();
    expect(await screen.findByText("Pagina uno")).toBeInTheDocument();
    expect(screen.queryByText("Pagina due")).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /load more/i }));

    expect(await screen.findByText("Pagina due")).toBeInTheDocument();
    expect(screen.getByText("Pagina uno")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /load more/i })).not.toBeInTheDocument();
  });
});

describe("nuovo item dalla lista backlog", () => {
  /**
   * Mock per metodo+path: POST /api/backlog risponde 202 (e cattura il body),
   * GET /api/backlog risponde la lista corrente (`listItems`, mutabile dal
   * chiamante) e ne conta le richieste in `listGets`.
   */
  function mockBacklogCreate() {
    const state = {
      postBody: undefined as unknown,
      listGets: 0,
      listItems: [] as BacklogItem[],
    };
    fetchMock.mockImplementation((input, init) => {
      const raw =
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const url = new URL(raw, "http://test.local");
      const method = init?.method ?? "GET";
      if (url.pathname === "/api/backlog" && method === "POST") {
        state.postBody = JSON.parse(String(init?.body));
        return Promise.resolve(jsonResponse(202, { queued: true }));
      }
      if (url.pathname === "/api/backlog") {
        state.listGets += 1;
        return Promise.resolve(jsonResponse(200, { items: state.listItems, nextCursor: null }));
      }
      const handler = baseHandlers[url.pathname as keyof typeof baseHandlers];
      if (!handler) throw new Error(`fetch non mockata per ${method} ${raw}`);
      return Promise.resolve(handler());
    });
    return state;
  }

  /** Compila e invia il dialog "Nuovo item" (già sulla lista renderizzata). */
  async function submitNewItem(user: ReturnType<typeof userEvent.setup>) {
    await user.click(screen.getByRole("button", { name: "New item" }));
    const dialog = screen.getByRole("dialog", { name: "New backlog item" });
    await user.type(within(dialog).getByLabelText("Title"), "Export massivo ordini");
    await user.type(within(dialog).getByLabelText("Description"), "Servono gli ordini in CSV.");
    await user.click(within(dialog).getByRole("button", { name: "Create item" }));
  }

  it("apre il dialog, invia il POST 202, mostra il banner e rifetcha la lista", async () => {
    const user = userEvent.setup();
    const api = mockBacklogCreate();

    renderApp();
    expect(await screen.findByText(/no backlog items/i)).toBeInTheDocument();
    const getsBeforePost = api.listGets;

    await submitNewItem(user);

    // Dialog chiuso e banner comparso: il 202 non crea subito la voce.
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "New backlog item" })).not.toBeInTheDocument(),
    );
    expect(
      await screen.findByText(/Item queued — it will appear here in a few minutes\./),
    ).toBeInTheDocument();
    expect(api.postBody).toEqual({
      projectId: PROJECT_ID,
      title: "Export massivo ordini",
      body: "Servono gli ordini in CSV.",
    });
    // L'invalidazione post-202 rifetcha la lista (qui ancora vuota: il banner
    // resta finché la voce non compare).
    await waitFor(() => expect(api.listGets).toBeGreaterThan(getsBeforePost));
    expect(
      screen.getByText(/Item queued — it will appear here in a few minutes\./),
    ).toBeInTheDocument();
  });

  it("quando l'item compare in lista il banner si dismette da solo", async () => {
    const user = userEvent.setup();
    const api = mockBacklogCreate();

    renderApp();
    expect(await screen.findByText(/no backlog items/i)).toBeInTheDocument();

    // Dal prossimo GET (il refetch dell'invalidazione post-202) la lista
    // contiene la voce creata dal worker: il refetch la porta in pagina e
    // l'auto-dismiss spegne il banner. Impostata PRIMA del submit perché il
    // refetch parte subito dopo il POST (nessun altro GET nel mezzo).
    api.listItems = [makeItem({ title: "Export massivo ordini" })];
    await submitNewItem(user);

    expect(await screen.findByText("Export massivo ordini")).toBeInTheDocument();
    await waitFor(() =>
      expect(
        screen.queryByText(/Item queued — it will appear here in a few minutes\./),
      ).not.toBeInTheDocument(),
    );
  });
});
