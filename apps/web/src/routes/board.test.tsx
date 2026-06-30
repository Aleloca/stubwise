import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import { act, render, renderHook, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Ticket } from "../lib/api";
import { ticketKeys } from "../lib/queries";
import { createAppRouter } from "../router";
import { useMoveTicket } from "./board";

/**
 * Test della board con il router vero (memory history) e fetch mockata a
 * livello di rete. La simulazione completa del drag con dnd-kit è
 * inaffidabile in happy-dom (niente layout reale né pointer capture): qui si
 * testa direttamente `useMoveTicket`, l'handler che `onDragEnd` invoca, che
 * contiene tutta la logica di spostamento (ottimismo, PATCH, rollback).
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

type Handler = (url: URL, init?: RequestInit) => Response | Promise<Response>;

/** Gli handler sono indicizzati per pathname, o "METODO pathname" se serve. */
function mockApi(handlers: Record<string, Handler>) {
  fetchMock.mockImplementation((input, init) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(raw, "http://test.local");
    const method = init?.method ?? "GET";
    const handler = handlers[`${method} ${url.pathname}`] ?? handlers[url.pathname];
    if (!handler) throw new Error(`fetch non mockato per ${method} ${raw}`);
    return Promise.resolve(handler(url, init));
  });
}

const PROJECT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PROJECT_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function makeTicket(overrides: Partial<Ticket>): Ticket {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    projectId: PROJECT_A,
    repositoryId: null,
    number: 1,
    title: "Ticket di prova",
    body: "",
    type: "bug",
    priority: "medium",
    status: "open",
    source: "manual",
    assigneeId: null,
    milestoneId: null,
    effort: null,
    labels: [],
    technicalPayload: null,
    occurrences: 1,
    lastSeenAt: "2026-06-01T10:00:00.000Z",
    createdAt: "2026-06-01T10:00:00.000Z",
    updatedAt: "2026-06-01T10:00:00.000Z",
    ...overrides,
  };
}

const crash = makeTicket({
  id: "11111111-1111-4111-8111-111111111111",
  number: 42,
  title: "Crash al checkout",
  type: "bug",
  priority: "urgent",
  status: "open",
  occurrences: 7,
});

const exportCsv = makeTicket({
  id: "22222222-2222-4222-8222-222222222222",
  number: 41,
  title: "Export CSV degli ordini",
  type: "feature",
  priority: "low",
  status: "in_progress",
});

const onboarding = makeTicket({
  id: "33333333-3333-4333-8333-333333333333",
  projectId: PROJECT_B,
  number: 7,
  title: "Refactoring onboarding",
  type: "task",
  priority: "medium",
  status: "done",
});

const allTickets = [crash, exportCsv, onboarding];

const ticketsHandler: Handler = (url) => {
  const projectId = url.searchParams.get("projectId");
  const items = projectId
    ? allTickets.filter((ticket) => ticket.projectId === projectId)
    : allTickets;
  return jsonResponse(200, { items, nextCursor: null });
};

const baseHandlers: Record<string, Handler> = {
  "/api/auth/me": () =>
    jsonResponse(200, { user: { id: "u1", email: "ada@example.com", role: "admin" } }),
  "/api/projects": () =>
    jsonResponse(200, [
      {
        id: PROJECT_A,
        name: "Progetto Alfa",
        slug: "progetto-alfa",
        description: null,
        aiProviderId: null,
        docAutoUpdate: false,
        repositoryCount: 1,
        createdAt: "2026-01-01T00:00:00.000Z",
      },
      {
        id: PROJECT_B,
        name: "Progetto Beta",
        slug: "progetto-beta",
        description: null,
        aiProviderId: null,
        docAutoUpdate: false,
        repositoryCount: 1,
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    ]),
  "/api/repositories": () => jsonResponse(200, []),
  "/api/tickets": ticketsHandler,
};

function renderApp(initialPath = "/board") {
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

describe("board kanban", () => {
  it("renderizza le sei colonne nell'ordine del ciclo di vita, con conteggi e card", async () => {
    mockApi(baseHandlers);

    renderApp();

    expect(await screen.findByText("Crash al checkout")).toBeInTheDocument();

    // Sei colonne, una per stato, nell'ordine open → closed.
    const columns = screen.getAllByRole("region");
    expect(columns.map((column) => column.getAttribute("aria-label"))).toEqual([
      "Open: 1 tickets",
      "Triaged: 0 tickets",
      "In progress: 1 tickets",
      "In review: 0 tickets",
      "Done: 1 tickets",
      "Closed: 0 tickets",
    ]);

    // Ogni card sta nella colonna del suo stato.
    const open = screen.getByRole("region", { name: /^open/i });
    const card = within(open).getByRole("button", { name: /crash al checkout/i });
    expect(within(card).getByText("#42")).toBeInTheDocument();
    expect(within(card).getByText("×7")).toBeInTheDocument();
    expect(within(card).getByText("Urgent")).toBeInTheDocument();
    expect(within(card).getByText("Bug")).toBeInTheDocument();

    const inProgress = screen.getByRole("region", { name: /^in progress/i });
    expect(within(inProgress).getByText("Export CSV degli ordini")).toBeInTheDocument();

    const done = screen.getByRole("region", { name: /^done/i });
    expect(within(done).getByText("Refactoring onboarding")).toBeInTheDocument();

    // Scroll-snap mobile: il contenitore aggancia le colonne, ognuna allineata
    // a inizio scroll (le classi sono additive, il desktop resta scroll libero).
    const columnsContainer = columns[0]?.parentElement;
    expect(columnsContainer?.className).toContain("snap-x");
    expect(columnsContainer?.className).toContain("snap-mandatory");
    expect(columns[0]?.className).toContain("snap-start");

    // Le colonne senza ticket mostrano il placeholder.
    expect(screen.getAllByText(/no tickets/i)).toHaveLength(3);

    // Sotto la soglia di troncamento non c'è alcun avviso.
    expect(screen.queryByText(/showing the first/i)).not.toBeInTheDocument();
  });

  it("con esattamente 100 ticket (limite board) mostra l'avviso di troncamento", async () => {
    const many = Array.from({ length: 100 }, (_, index) =>
      makeTicket({
        id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
        number: index + 1,
        title: `Ticket ${index + 1}`,
      }),
    );
    mockApi({
      ...baseHandlers,
      "/api/tickets": () => jsonResponse(200, { items: many, nextCursor: "altro" }),
    });

    renderApp();

    expect(
      await screen.findByText(/showing the first 100 tickets — filter by project/i),
    ).toBeInTheDocument();
  });

  it("il filtro progetto aggiorna l'URL e rifà la richiesta filtrata", async () => {
    const seen: string[] = [];
    mockApi({
      ...baseHandlers,
      "/api/tickets": (url) => {
        seen.push(url.search);
        return ticketsHandler(url);
      },
    });

    const router = renderApp();
    expect(await screen.findByText("Crash al checkout")).toBeInTheDocument();
    // La board è uno snapshot a pagina singola: chiede il massimo consentito.
    expect(seen[0]).toContain("limit=100");

    await userEvent.selectOptions(screen.getByLabelText(/project/i), PROJECT_B);

    expect(await screen.findByText("Refactoring onboarding")).toBeInTheDocument();
    expect(screen.queryByText("Crash al checkout")).not.toBeInTheDocument();
    expect(router.state.location.search).toEqual({ projectId: PROJECT_B });
    expect(seen.at(-1)).toContain(`projectId=${PROJECT_B}`);
    expect(seen.at(-1)).toContain("limit=100");
  });

  it("un projectId malformato nell'URL viene scartato invece di rompere la route", async () => {
    mockApi(baseHandlers);

    const router = renderApp("/board?projectId=non-un-uuid");

    expect(await screen.findByText("Crash al checkout")).toBeInTheDocument();
    expect(router.state.location.search).toEqual({});
  });

  it("il click su una card (non drag) naviga al dettaglio del ticket", async () => {
    mockApi({
      ...baseHandlers,
      [`/api/tickets/${crash.id}`]: () => jsonResponse(200, crash),
      [`/api/tickets/${crash.id}/comments`]: () => jsonResponse(200, []),
      [`/api/tickets/${crash.id}/jobs`]: () => jsonResponse(200, []),
      "/api/users": () => jsonResponse(200, []),
    });

    const router = renderApp();
    expect(await screen.findByText("Crash al checkout")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /crash al checkout/i }));

    await waitFor(() => expect(router.state.location.pathname).toBe(`/tickets/${crash.id}`));
  });
});

describe("useMoveTicket", () => {
  function setupHook(tickets: Ticket[], projectId?: string) {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    queryClient.setQueryData(ticketKeys.board(projectId), tickets);
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(() => useMoveTicket(projectId), { wrapper });
    return { queryClient, result };
  }

  function boardData(queryClient: QueryClient, projectId?: string) {
    return queryClient.getQueryData<Ticket[]>(ticketKeys.board(projectId));
  }

  it("aggiorna la cache in modo ottimistico, prima che la PATCH risolva", async () => {
    let resolvePatch!: (response: Response) => void;
    mockApi({
      [`PATCH /api/tickets/${crash.id}`]: () =>
        new Promise<Response>((resolve) => {
          resolvePatch = resolve;
        }),
    });
    const { queryClient, result } = setupHook([crash, exportCsv], PROJECT_A);

    act(() => result.current.moveTicket(crash.id, "triaged"));

    // La card è già nella nuova colonna mentre la PATCH è ancora in volo.
    await waitFor(() => {
      const moved = boardData(queryClient, PROJECT_A)?.find((t) => t.id === crash.id);
      expect(moved?.status).toBe("triaged");
    });

    // La PATCH è partita con il solo campo status.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [input, init] = fetchMock.mock.calls[0] ?? [];
    expect(String(input)).toBe(`/api/tickets/${crash.id}`);
    expect(init?.method).toBe("PATCH");
    expect(JSON.parse(String(init?.body))).toEqual({ status: "triaged" });

    resolvePatch(jsonResponse(200, { ...crash, status: "triaged" }));
    await waitFor(() => expect(result.current.isPending).toBe(false));
    // Gli altri ticket non sono stati toccati.
    expect(boardData(queryClient, PROJECT_A)?.find((t) => t.id === exportCsv.id)?.status).toBe(
      "in_progress",
    );
  });

  it("su errore della PATCH ripristina lo snapshot precedente ed espone l'errore", async () => {
    mockApi({
      [`PATCH /api/tickets/${crash.id}`]: () =>
        jsonResponse(409, { message: "Transizione non valida" }),
    });
    const { queryClient, result } = setupHook([crash, exportCsv]);

    act(() => result.current.moveTicket(crash.id, "closed"));

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error?.message).toBe("Transizione non valida");
    // Rollback: la card è tornata nella colonna di partenza.
    expect(boardData(queryClient)?.find((t) => t.id === crash.id)?.status).toBe("open");
    // E il ticket non spostato è rimasto intatto.
    expect(boardData(queryClient)?.find((t) => t.id === exportCsv.id)).toEqual(exportCsv);
  });

  it("cambiare progetto con la PATCH in volo non corrompe la cache: rollback sulla chiave originale", async () => {
    let resolvePatch!: (response: Response) => void;
    mockApi({
      [`PATCH /api/tickets/${crash.id}`]: () =>
        new Promise<Response>((resolve) => {
          resolvePatch = resolve;
        }),
    });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    queryClient.setQueryData(ticketKeys.board(PROJECT_A), [crash, exportCsv]);
    queryClient.setQueryData(ticketKeys.board(PROJECT_B), [onboarding]);
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    const { result, rerender } = renderHook(
      ({ projectId }: { projectId?: string }) => useMoveTicket(projectId),
      { wrapper, initialProps: { projectId: PROJECT_A as string | undefined } },
    );
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");

    act(() => result.current.moveTicket(crash.id, "triaged"));
    // L'aggiornamento ottimistico è atterrato sulla board del progetto A.
    await waitFor(() =>
      expect(boardData(queryClient, PROJECT_A)?.find((t) => t.id === crash.id)?.status).toBe(
        "triaged",
      ),
    );

    // L'utente cambia filtro progetto mentre la PATCH è ancora in volo:
    // TanStack aggiorna le opzioni della mutation pendente al re-render.
    rerender({ projectId: PROJECT_B });

    resolvePatch(jsonResponse(409, { message: "Transizione non valida" }));
    await waitFor(() => expect(result.current.isError).toBe(true));

    // Il rollback colpisce la board ORIGINALE (progetto A), non quella nuova.
    expect(boardData(queryClient, PROJECT_A)?.find((t) => t.id === crash.id)?.status).toBe(
      "open",
    );
    // La board del progetto B non è stata toccata dal rollback altrui.
    expect(boardData(queryClient, PROJECT_B)).toEqual([onboarding]);
    // E l'invalidazione di onSettled punta alla chiave catturata alla mutate.
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ticketKeys.board(PROJECT_A) });
  });

  it("a mutazione conclusa invalida board, liste e dettaglio del ticket", async () => {
    mockApi({
      [`PATCH /api/tickets/${crash.id}`]: () =>
        jsonResponse(200, { ...crash, status: "done" }),
    });
    const { queryClient, result } = setupHook([crash]);
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");

    act(() => result.current.moveTicket(crash.id, "done"));

    await waitFor(() =>
      expect(invalidate).toHaveBeenCalledWith({ queryKey: ticketKeys.board(undefined) }),
    );
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ticketKeys.lists() });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ticketKeys.detail(crash.id) });
  });

  it("non chiama l'API se il ticket viene rilasciato nella colonna di partenza", () => {
    mockApi({});
    const { result } = setupHook([crash]);

    act(() => result.current.moveTicket(crash.id, "open"));

    expect(fetchMock).not.toHaveBeenCalled();
  });
});
