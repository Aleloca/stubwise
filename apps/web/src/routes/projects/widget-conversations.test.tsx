import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAppRouter } from "../../router";

/**
 * Route Conversazioni widget (viewer read-only) col router vero (memory
 * history) e fetch mockata: lista con 2 conversazioni, selezione che carica il
 * filo, badge ticket, citazioni e link al ticket. Più il link "Vedi
 * conversazione" dal dettaglio di un ticket con source=widget.
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

const PROJECT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CONV_A = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const CONV_B = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const TICKET_ID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const WIDGET_ID = "ffffffff-ffff-4fff-8fff-ffffffffffff";

function meHandler(role: "admin" | "member" = "admin"): Handler {
  return () => jsonResponse(200, { user: { id: "u1", email: "ada@example.com", role } });
}

function projectDetail() {
  return {
    id: PROJECT_ID,
    name: "Acme Platform",
    slug: "acme-platform",
    description: null,
    aiProviderId: null,
    docAutoUpdate: false,
    ingestionKey: "0123456789abcdef0123456789abcdef",
    nextTicketNumber: 1,
    repositories: [],
    createdAt: "2026-06-01T10:00:00.000Z",
  };
}

const NOW = "2026-07-05T10:00:00.000Z";

function widgets() {
  return {
    widgets: [
      {
        id: WIDGET_ID,
        name: "Support",
        key: "wgt_support",
        greeting: null,
        primaryColor: null,
        position: "right",
        enabledRepositoryIds: [],
        dailyMessageCap: null,
        dailyTicketCap: null,
        createdAt: NOW,
        conversationCount: 1,
      },
    ],
  };
}

function conversations() {
  return {
    conversations: [
      {
        id: CONV_A,
        externalUserId: "ext-a",
        externalUserEmail: "user-a@example.com",
        externalUserName: "Alice",
        widgetId: WIDGET_ID,
        widgetName: "Support",
        createdAt: NOW,
        lastMessageAt: NOW,
        messageCount: 4,
        ticketCount: 1,
      },
      {
        id: CONV_B,
        externalUserId: "ext-b",
        externalUserEmail: null,
        externalUserName: null,
        widgetId: null,
        widgetName: null,
        createdAt: NOW,
        lastMessageAt: NOW,
        messageCount: 2,
        ticketCount: 0,
      },
    ],
  };
}

function threadA() {
  return {
    conversation: {
      id: CONV_A,
      externalUserId: "ext-a",
      externalUserEmail: "user-a@example.com",
      externalUserName: "Alice",
      widgetName: "Support",
      createdAt: NOW,
    },
    messages: [
      {
        id: "m1",
        role: "user",
        content: "How do I reset my password?",
        citations: null,
        ticketId: null,
        createdAt: NOW,
      },
      {
        id: "m2",
        role: "assistant",
        content: "You can reset it from settings.",
        citations: [{ title: "Password guide" }],
        ticketId: TICKET_ID,
        createdAt: NOW,
      },
    ],
  };
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

describe("viewer conversazioni widget", () => {
  it("mostra la lista con 2 conversazioni, nome/fallback id, badge ticket e widget", async () => {
    mockApi({
      "GET /api/auth/me": meHandler(),
      [`GET /api/projects/${PROJECT_ID}`]: () => jsonResponse(200, projectDetail()),
      [`GET /api/projects/${PROJECT_ID}/widgets`]: () => jsonResponse(200, widgets()),
      [`GET /api/projects/${PROJECT_ID}/widget/conversations`]: () =>
        jsonResponse(200, conversations()),
    });

    renderApp(`/projects/${PROJECT_ID}/conversations`);

    expect(
      await screen.findByRole("heading", { name: "Widget conversations" }),
    ).toBeInTheDocument();
    // Nome esplicito e fallback all'id esterno (name+email nulli).
    expect(screen.getByText("Alice")).toBeInTheDocument();
    expect(screen.getByText("ext-b")).toBeInTheDocument();
    // Badge messaggi + ticket (con plurale/singolare) sulla prima conversazione.
    expect(screen.getByText("4 messages")).toBeInTheDocument();
    expect(screen.getByText("1 ticket")).toBeInTheDocument();
    // La seconda non ha ticket: nessun badge ticket per lei.
    expect(screen.getByText("2 messages")).toBeInTheDocument();
    // Badge del widget d'origine sulla prima: scopato alla lista così l'assert
    // non passa per l'opzione della select (che ha lo stesso testo "Support").
    const list = screen.getByRole("list");
    expect(within(list).getByText("Support")).toBeInTheDocument();
    expect(within(list).getByText("deleted widget")).toBeInTheDocument();
  });

  it("selezione: carica il filo, mostra i ruoli, la citazione e il link al ticket", async () => {
    const user = userEvent.setup();
    mockApi({
      "GET /api/auth/me": meHandler(),
      [`GET /api/projects/${PROJECT_ID}`]: () => jsonResponse(200, projectDetail()),
      [`GET /api/projects/${PROJECT_ID}/widgets`]: () => jsonResponse(200, widgets()),
      [`GET /api/projects/${PROJECT_ID}/widget/conversations`]: () =>
        jsonResponse(200, conversations()),
      [`GET /api/projects/${PROJECT_ID}/widget/conversations/${CONV_A}/messages`]: () =>
        jsonResponse(200, threadA()),
    });

    renderApp(`/projects/${PROJECT_ID}/conversations`);

    await user.click(await screen.findByText("Alice"));

    // Contenuti dei messaggi resi.
    expect(await screen.findByText("How do I reset my password?")).toBeInTheDocument();
    expect(screen.getByText("You can reset it from settings.")).toBeInTheDocument();
    // Citazione sotto la risposta assistant.
    expect(screen.getByText("source: Password guide")).toBeInTheDocument();
    // Link al ticket aperto dal messaggio.
    expect(screen.getByRole("link", { name: /view ticket/i })).toHaveAttribute(
      "href",
      `/tickets/${TICKET_ID}`,
    );
    // Nome del widget nell'header del dettaglio (badge nella lista + header +
    // opzione del filtro → più occorrenze).
    expect(screen.getAllByText("Support").length).toBeGreaterThan(1);
  });

  it("con ?ticketId: filtra la lista e auto-seleziona la conversazione trovata", async () => {
    let convRequestUrl: URL | undefined;
    mockApi({
      "GET /api/auth/me": meHandler(),
      [`GET /api/projects/${PROJECT_ID}`]: () => jsonResponse(200, projectDetail()),
      [`GET /api/projects/${PROJECT_ID}/widgets`]: () => jsonResponse(200, widgets()),
      [`GET /api/projects/${PROJECT_ID}/widget/conversations`]: (url) => {
        convRequestUrl = url;
        return jsonResponse(200, { conversations: conversations().conversations.slice(0, 1) });
      },
      [`GET /api/projects/${PROJECT_ID}/widget/conversations/${CONV_A}/messages`]: () =>
        jsonResponse(200, threadA()),
    });

    renderApp(`/projects/${PROJECT_ID}/conversations?ticketId=${TICKET_ID}`);

    // Il filtro ticketId arriva al server.
    await waitFor(() => expect(convRequestUrl?.searchParams.get("ticketId")).toBe(TICKET_ID));
    // Auto-selezione: il filo è visibile senza click.
    expect(await screen.findByText("You can reset it from settings.")).toBeInTheDocument();
  });

  it("lista vuota: stato vuoto i18n", async () => {
    mockApi({
      "GET /api/auth/me": meHandler(),
      [`GET /api/projects/${PROJECT_ID}`]: () => jsonResponse(200, projectDetail()),
      [`GET /api/projects/${PROJECT_ID}/widgets`]: () => jsonResponse(200, widgets()),
      [`GET /api/projects/${PROJECT_ID}/widget/conversations`]: () =>
        jsonResponse(200, { conversations: [] }),
    });

    renderApp(`/projects/${PROJECT_ID}/conversations`);

    expect(await screen.findByText("No conversations yet")).toBeInTheDocument();
  });

  it("select filtro widget: naviga con ?widgetId e rifetcha con quel filtro", async () => {
    const user = userEvent.setup();
    const convRequestUrls: URL[] = [];
    mockApi({
      "GET /api/auth/me": meHandler(),
      [`GET /api/projects/${PROJECT_ID}`]: () => jsonResponse(200, projectDetail()),
      [`GET /api/projects/${PROJECT_ID}/widgets`]: () => jsonResponse(200, widgets()),
      [`GET /api/projects/${PROJECT_ID}/widget/conversations`]: (url) => {
        convRequestUrls.push(url);
        const filtered = url.searchParams.get("widgetId")
          ? conversations().conversations.slice(0, 1)
          : conversations().conversations;
        return jsonResponse(200, { conversations: filtered });
      },
    });

    const router = renderApp(`/projects/${PROJECT_ID}/conversations`);

    // Prima fetch senza filtro widget.
    await screen.findByText("Alice");
    expect(convRequestUrls[0]?.searchParams.get("widgetId")).toBeNull();

    // Selezione del widget dal filtro → nuova fetch con widgetId nell'URL.
    await user.selectOptions(await screen.findByRole("combobox"), WIDGET_ID);

    await waitFor(() =>
      expect(convRequestUrls.some((u) => u.searchParams.get("widgetId") === WIDGET_ID)).toBe(true),
    );
    // Il search param finisce anche nell'URL della route.
    await waitFor(() =>
      expect(router.state.location.search).toEqual(expect.objectContaining({ widgetId: WIDGET_ID })),
    );
  });
});

describe("ticket widget → conversazione", () => {
  function widgetTicket() {
    return {
      id: TICKET_ID,
      projectId: PROJECT_ID,
      number: 7,
      title: "Reset password broken",
      body: "",
      type: "bug",
      priority: "high",
      status: "open",
      source: "widget",
      assigneeId: null,
      milestoneId: null,
      effort: null,
      labels: [],
      technicalPayload: null,
      occurrences: 1,
      lastSeenAt: NOW,
      createdAt: NOW,
      updatedAt: NOW,
      repositories: [],
    };
  }

  it("il dettaglio di un ticket widget mostra il link 'Vedi conversazione' con ?ticketId", async () => {
    mockApi({
      "GET /api/auth/me": meHandler(),
      [`GET /api/tickets/${TICKET_ID}`]: () => jsonResponse(200, widgetTicket()),
      [`GET /api/tickets/${TICKET_ID}/comments`]: () => jsonResponse(200, []),
      [`GET /api/tickets/${TICKET_ID}/activity`]: () => jsonResponse(200, []),
      [`GET /api/tickets/${TICKET_ID}/jobs`]: () => jsonResponse(200, []),
      [`GET /api/tickets/${TICKET_ID}/usage`]: () =>
        jsonResponse(200, { totalTokens: 0, totalCostUsd: null, byModel: [] }),
      [`GET /api/tickets/${TICKET_ID}/links`]: () => jsonResponse(200, []),
      [`GET /api/tickets/${TICKET_ID}/attachments`]: () => jsonResponse(200, []),
      "GET /api/users": () => jsonResponse(200, []),
      "GET /api/projects": () => jsonResponse(200, []),
      "GET /api/milestones": () => jsonResponse(200, []),
    });

    renderApp(`/tickets/${TICKET_ID}`);

    const link = await screen.findByRole("link", { name: /view conversation/i });
    expect(link).toHaveAttribute(
      "href",
      `/projects/${PROJECT_ID}/conversations?ticketId=${TICKET_ID}`,
    );
  });
});
