import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AIJob, Comment, Ticket } from "../../lib/api";
import { ticketKeys } from "../../lib/queries";
import { createAppRouter } from "../../router";

/**
 * Test del dettaglio con il router vero e fetch mockata per metodo+path:
 * fixture completa (payload tecnico, commenti, job AI) e azioni che
 * diventano PATCH/POST reali sul mock.
 */

const TICKET_ID = "11111111-1111-4111-8111-111111111111";
const PROJECT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ADMIN_ID = "99999999-9999-4999-8999-999999999999";
const MEMBER_ID = "88888888-8888-4888-8888-888888888888";

const ticketFixture: Ticket = {
  id: TICKET_ID,
  projectId: PROJECT_ID,
  number: 7,
  title: "TypeError al checkout",
  body: "Il bottone **Paga ora** lancia un'eccezione.",
  type: "bug",
  priority: "high",
  status: "open",
  source: "sdk_error",
  assigneeId: null,
  labels: ["pagamenti"],
  technicalPayload: {
    message: "Cannot read properties of undefined (reading 'total')",
    stack: "TypeError: Cannot read properties of undefined\n    at checkout.ts:42:13",
    url: "https://shop.example.com/checkout",
    release: "1.4.2",
    environment: "production",
    userAgent: "Mozilla/5.0",
    breadcrumbs: [
      { type: "click", message: "click su #paga-ora", timestamp: "2026-06-01T09:59:58.000Z" },
    ],
    timestamp: "2026-06-01T10:00:00.000Z",
  },
  occurrences: 12,
  lastSeenAt: "2026-06-08T10:00:00.000Z",
  createdAt: "2026-06-01T10:00:00.000Z",
  updatedAt: "2026-06-08T10:00:00.000Z",
};

const commentsFixture: Comment[] = [
  {
    id: "c1",
    ticketId: TICKET_ID,
    authorType: "user",
    authorId: ADMIN_ID,
    body: "Riprodotto anche su staging.",
    createdAt: "2026-06-02T09:00:00.000Z",
  },
  {
    id: "c2",
    ticketId: TICKET_ID,
    authorType: "ai",
    authorId: null,
    body: "Triage: il carrello può essere `undefined` dopo il logout.",
    createdAt: "2026-06-02T09:05:00.000Z",
  },
];

const jobsFixture: AIJob[] = [
  {
    id: "j2",
    ticketId: TICKET_ID,
    status: "pr_opened",
    log: "triage ok\nfix applicato",
    prUrl: "https://github.com/acme/shop/pull/12",
    error: null,
    createdAt: "2026-06-03T10:00:00.000Z",
    startedAt: "2026-06-03T10:00:05.000Z",
    finishedAt: "2026-06-03T10:04:00.000Z",
  },
  {
    id: "j1",
    ticketId: TICKET_ID,
    status: "failed",
    log: "clone fallito",
    prUrl: null,
    error: "git clone: timeout",
    createdAt: "2026-06-02T10:00:00.000Z",
    startedAt: "2026-06-02T10:00:02.000Z",
    finishedAt: "2026-06-02T10:00:40.000Z",
  },
];

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

type Handler = (url: URL, init: RequestInit | undefined) => Response;

function mockApi(handlers: Record<string, Handler>) {
  fetchMock.mockImplementation((input, init) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(raw, "http://test.local");
    const method = init?.method ?? "GET";
    const handler = handlers[`${method} ${url.pathname}`];
    if (!handler) throw new Error(`fetch non mockata per ${method} ${url.pathname}`);
    return Promise.resolve(handler(url, init));
  });
}

interface MockState {
  ticket: Ticket;
  comments: Comment[];
  patches: unknown[];
  postedComments: unknown[];
}

function mockDetailApi(): MockState {
  const state: MockState = {
    ticket: { ...ticketFixture },
    comments: [...commentsFixture],
    patches: [],
    postedComments: [],
  };

  mockApi({
    "GET /api/auth/me": () =>
      jsonResponse(200, { user: { id: ADMIN_ID, email: "ada@example.com", role: "admin" } }),
    "GET /api/projects": () =>
      jsonResponse(200, [
        {
          id: PROJECT_ID,
          name: "Shop Acme",
          slug: "shop-acme",
          provider: "github",
          repoUrl: "https://github.com/acme/shop",
          defaultBranch: "main",
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      ]),
    "GET /api/users": () =>
      jsonResponse(200, [
        { id: ADMIN_ID, email: "ada@example.com", role: "admin" },
        { id: MEMBER_ID, email: "bob@example.com", role: "member" },
      ]),
    [`GET /api/tickets/${TICKET_ID}`]: () => jsonResponse(200, state.ticket),
    [`PATCH /api/tickets/${TICKET_ID}`]: (_url, init) => {
      const patch = JSON.parse(String(init?.body)) as Partial<Ticket>;
      state.patches.push(patch);
      state.ticket = { ...state.ticket, ...patch };
      return jsonResponse(200, state.ticket);
    },
    [`GET /api/tickets/${TICKET_ID}/comments`]: () => jsonResponse(200, state.comments),
    [`POST /api/tickets/${TICKET_ID}/comments`]: (_url, init) => {
      const body = (JSON.parse(String(init?.body)) as { body: string }).body;
      state.postedComments.push(body);
      const created: Comment = {
        id: `c${state.comments.length + 1}`,
        ticketId: TICKET_ID,
        authorType: "user",
        authorId: ADMIN_ID,
        body,
        createdAt: "2026-06-09T10:00:00.000Z",
      };
      state.comments = [...state.comments, created];
      return jsonResponse(201, created);
    },
    [`GET /api/tickets/${TICKET_ID}/jobs`]: () => jsonResponse(200, jobsFixture),
  });

  return state;
}

function renderDetail() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createAppRouter(
    queryClient,
    createMemoryHistory({ initialEntries: [`/tickets/${TICKET_ID}`] }),
  );
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { router, queryClient };
}

describe("dettaglio ticket", () => {
  it("header: numero, titolo, badge, progetto e occorrenze", async () => {
    mockDetailApi();
    renderDetail();

    expect(
      await screen.findByRole("heading", { name: "TypeError al checkout" }),
    ).toBeInTheDocument();
    const header = screen.getByRole("banner");
    expect(within(header).getByText("#7")).toBeInTheDocument();
    expect(within(header).getByText("Aperto")).toBeInTheDocument();
    expect(within(header).getByText("Alta")).toBeInTheDocument();
    expect(within(header).getByText("Bug")).toBeInTheDocument();
    // Il testo del badge origine è "◇ SDK": match parziale.
    expect(within(header).getByText(/SDK/)).toBeInTheDocument();
    expect(within(header).getByText("Shop Acme")).toBeInTheDocument();
    expect(within(header).getByText("×12")).toBeInTheDocument();
  });

  it("la descrizione è markdown renderizzato", async () => {
    mockDetailApi();
    renderDetail();

    const bold = await screen.findByText("Paga ora");
    expect(bold.tagName).toBe("STRONG");
  });

  it("payload tecnico: collassato di default, al click mostra stack, metadati e breadcrumb", async () => {
    mockDetailApi();
    renderDetail();

    const toggle = await screen.findByRole("button", { name: /payload tecnico/i });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText(/checkout\.ts:42/)).not.toBeInTheDocument();

    await userEvent.click(toggle);

    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText(/checkout\.ts:42/)).toBeInTheDocument();
    expect(screen.getByText("https://shop.example.com/checkout")).toBeInTheDocument();
    expect(screen.getByText("production")).toBeInTheDocument();
    expect(screen.getByText("click su #paga-ora")).toBeInTheDocument();
  });

  it("commenti: l'autore umano è firmato con l'email, quello AI con il badge", async () => {
    mockDetailApi();
    renderDetail();

    expect(await screen.findByText("Riprodotto anche su staging.")).toBeInTheDocument();
    expect(screen.getAllByText("ada@example.com").length).toBeGreaterThan(0);
    expect(screen.getByText("AI")).toBeInTheDocument();
    // Il corpo del commento AI è markdown: `undefined` diventa <code>.
    expect(screen.getByText("undefined").tagName).toBe("CODE");
  });

  it("timeline AI: stati, link alla PR ed errore del job fallito", async () => {
    mockDetailApi();
    renderDetail();

    expect(await screen.findByText("PR aperta")).toBeInTheDocument();
    expect(screen.getByText("Fallito")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /vedi pr/i })).toHaveAttribute(
      "href",
      "https://github.com/acme/shop/pull/12",
    );
    expect(screen.getByText("git clone: timeout")).toBeInTheDocument();
  });

  it("cambiare stato manda la PATCH e aggiorna la pagina", async () => {
    const state = mockDetailApi();
    renderDetail();

    const select = await screen.findByLabelText("Stato");
    await userEvent.selectOptions(select, "in_progress");

    await waitFor(() => expect(state.patches).toEqual([{ status: "in_progress" }]));
    const header = screen.getByRole("banner");
    await waitFor(() => expect(within(header).getByText("In corso")).toBeInTheDocument());
  });

  it("la PATCH cancella i refetch in volo del dettaglio prima di scrivere in cache", async () => {
    const state = mockDetailApi();
    const { queryClient } = renderDetail();
    const cancelSpy = vi.spyOn(queryClient, "cancelQueries");

    await userEvent.selectOptions(await screen.findByLabelText("Stato"), "in_progress");
    await waitFor(() => expect(state.patches).toEqual([{ status: "in_progress" }]));

    // Un refetch partito prima della PATCH non deve poter sovrascrivere il
    // setQueryData con la risposta stantia: la cancellazione viene prima.
    await waitFor(() =>
      expect(cancelSpy).toHaveBeenCalledWith(
        expect.objectContaining({ queryKey: ["tickets", "detail", TICKET_ID] }),
      ),
    );
    expect(queryClient.getQueryData(["tickets", "detail", TICKET_ID])).toMatchObject({
      status: "in_progress",
    });
  });

  it("la PATCH invalida anche le board: un cambio dal dettaglio aggiorna la kanban", async () => {
    const state = mockDetailApi();
    const { queryClient } = renderDetail();
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");

    await userEvent.selectOptions(await screen.findByLabelText("Stato"), "in_progress");
    await waitFor(() => expect(state.patches).toEqual([{ status: "in_progress" }]));

    // La chiave padre `boards()` matcha ogni board, qualunque filtro progetto.
    await waitFor(() =>
      expect(invalidate).toHaveBeenCalledWith({ queryKey: ticketKeys.boards() }),
    );
  });

  it("cambiare assegnatario manda la PATCH con l'id utente", async () => {
    const state = mockDetailApi();
    renderDetail();

    const select = await screen.findByLabelText("Assegnatario");
    await userEvent.selectOptions(select, MEMBER_ID);

    await waitFor(() => expect(state.patches).toEqual([{ assigneeId: MEMBER_ID }]));
  });

  it("rimuovere una label manda la PATCH con la lista nuova", async () => {
    const state = mockDetailApi();
    renderDetail();

    await userEvent.click(
      await screen.findByRole("button", { name: /rimuovi.*pagamenti/i }),
    );

    await waitFor(() => expect(state.patches).toEqual([{ labels: [] }]));
  });

  it("aggiungere un commento: POST, thread aggiornato e campo svuotato", async () => {
    const state = mockDetailApi();
    renderDetail();

    const textarea = await screen.findByLabelText(/aggiungi un commento/i);
    await userEvent.type(textarea, "Sistemo io.");
    await userEvent.click(screen.getByRole("button", { name: /commenta/i }));

    await waitFor(() => expect(state.postedComments).toEqual(["Sistemo io."]));
    expect(await screen.findByText("Sistemo io.")).toBeInTheDocument();
    expect(textarea).toHaveValue("");
  });
});
