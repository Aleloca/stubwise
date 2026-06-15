import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AIJob, Comment, Ticket, TicketUsage } from "../../lib/api";
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
  effort: null,
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

const usageFixture: TicketUsage = {
  totalTokens: 12555,
  totalCostUsd: 0.0515,
  byModel: [
    {
      model: "claude-haiku-4-5",
      inputTokens: 110,
      outputTokens: 55,
      cacheReadTokens: 22,
      costUsd: 0.0015,
    },
    {
      model: "claude-opus-4-8",
      inputTokens: 12000,
      outputTokens: 390,
      cacheReadTokens: 200,
      costUsd: 0.05,
    },
  ],
};

// Riepilogo vuoto: nessun consumo → il pannello "Consumi AI" non compare.
const emptyUsageFixture: TicketUsage = { totalTokens: 0, totalCostUsd: null, byModel: [] };

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
  usage: TicketUsage;
  jobs: AIJob[];
  /** Body inviati a POST /run-ai (per verificare il flag withInstructions). */
  runAiCalls: unknown[];
  /** Quante volte è stato chiamato POST /approve-plan. */
  approveCalls: number;
  /** Quante volte è stato chiamato POST /reject-plan. */
  rejectCalls: number;
}

function mockDetailApi(
  overrides: { usage?: TicketUsage; ticket?: Ticket; jobs?: AIJob[]; comments?: Comment[] } = {},
): MockState {
  const state: MockState = {
    ticket: overrides.ticket ?? { ...ticketFixture },
    comments: overrides.comments ?? [...commentsFixture],
    patches: [],
    postedComments: [],
    usage: overrides.usage ?? usageFixture,
    jobs: overrides.jobs ?? jobsFixture,
    runAiCalls: [],
    approveCalls: 0,
    rejectCalls: 0,
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
    [`GET /api/tickets/${TICKET_ID}/jobs`]: () => jsonResponse(200, state.jobs),
    [`GET /api/tickets/${TICKET_ID}/usage`]: () => jsonResponse(200, state.usage),
    [`POST /api/tickets/${TICKET_ID}/run-ai`]: (_url, init) => {
      state.runAiCalls.push(init?.body ? JSON.parse(String(init.body)) : undefined);
      return jsonResponse(202, { jobId: "j3" });
    },
    [`POST /api/tickets/${TICKET_ID}/approve-plan`]: () => {
      state.approveCalls += 1;
      return jsonResponse(202, { jobId: "j3" });
    },
    [`POST /api/tickets/${TICKET_ID}/reject-plan`]: () => {
      state.rejectCalls += 1;
      return jsonResponse(202, { jobId: "j3" });
    },
  });

  return state;
}

/** Job singolo in stato "held": l'ultimo della lista (più recente). */
const heldJobFixture: AIJob = {
  id: "jh",
  ticketId: TICKET_ID,
  status: "held",
  log: "[triage] decisione: fix, ma automazione in attesa",
  prUrl: null,
  error: null,
  createdAt: "2026-06-04T10:00:00.000Z",
  startedAt: "2026-06-04T10:00:02.000Z",
  finishedAt: "2026-06-04T10:00:05.000Z",
};

/** Job singolo in stato "pr_closed": PR rifiutata, il ticket è stato riaperto. */
const prClosedJobFixture: AIJob = {
  id: "jc",
  ticketId: TICKET_ID,
  status: "pr_closed",
  log: "[fix] PR aperta\n[webhook] PR chiusa senza merge",
  prUrl: "https://github.com/acme/shop/pull/13",
  error: null,
  createdAt: "2026-06-06T10:00:00.000Z",
  startedAt: "2026-06-06T10:00:02.000Z",
  finishedAt: "2026-06-06T10:04:00.000Z",
};

/** Job singolo in stato "failed": un re-run manuale ha senso. */
const failedJobFixture: AIJob = {
  id: "jf",
  ticketId: TICKET_ID,
  status: "failed",
  log: "clone fallito",
  prUrl: null,
  error: "git clone: timeout",
  createdAt: "2026-06-06T10:00:00.000Z",
  startedAt: "2026-06-06T10:00:02.000Z",
  finishedAt: "2026-06-06T10:00:40.000Z",
};

/** Job singolo in stato "pr_merged": PR già mergiata, niente rilancio. */
const prMergedJobFixture: AIJob = {
  id: "jm",
  ticketId: TICKET_ID,
  status: "pr_merged",
  log: "[fix] PR aperta\n[webhook] PR mergiata",
  prUrl: "https://github.com/acme/shop/pull/14",
  error: null,
  createdAt: "2026-06-06T10:00:00.000Z",
  startedAt: "2026-06-06T10:00:02.000Z",
  finishedAt: "2026-06-06T10:04:00.000Z",
};

/** Job singolo in volo ("fixing"): nessun bottone di rilancio. */
const fixingJobFixture: AIJob = {
  id: "jx",
  ticketId: TICKET_ID,
  status: "fixing",
  log: "[fix] in corso",
  prUrl: null,
  error: null,
  createdAt: "2026-06-06T10:00:00.000Z",
  startedAt: "2026-06-06T10:00:02.000Z",
  finishedAt: null,
};

/** Job singolo in stato "awaiting_plan_approval": piano in attesa di decisione. */
const awaitingPlanJobFixture: AIJob = {
  id: "jp",
  ticketId: TICKET_ID,
  status: "awaiting_plan_approval",
  log: "[plan] piano proposto, in attesa di approvazione",
  prUrl: null,
  error: null,
  createdAt: "2026-06-05T10:00:00.000Z",
  startedAt: "2026-06-05T10:00:02.000Z",
  finishedAt: "2026-06-05T10:00:05.000Z",
};

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

  it("mostra l'effort stimato quando valorizzato (etichetta + n/5)", async () => {
    mockDetailApi({ ticket: { ...ticketFixture, effort: 3 } });
    renderDetail();

    const header = await screen.findByRole("banner");
    expect(within(header).getByText("Effort: Medio (3/5)")).toBeInTheDocument();
  });

  it("NON mostra l'effort quando è null (ticket non ancora triagiato)", async () => {
    mockDetailApi({ ticket: { ...ticketFixture, effort: null } });
    renderDetail();

    await screen.findByRole("banner");
    expect(screen.queryByText(/Effort:/)).not.toBeInTheDocument();
  });

  it("job 'held': mostra lo stato ON HOLD e il bottone Start AI fix che chiama run-ai", async () => {
    const state = mockDetailApi({ jobs: [heldJobFixture] });
    renderDetail();

    // Stato held reso nella timeline.
    expect(await screen.findByText("On hold")).toBeInTheDocument();

    const button = screen.getByRole("button", { name: "Start AI fix" });
    await userEvent.click(button);

    // Senza opzione: il run-ai parte senza body (triage da capo).
    await waitFor(() => expect(state.runAiCalls).toEqual([undefined]));
  });

  it("job 'held': 'Rilancia con istruzioni' chiama run-ai con withInstructions", async () => {
    const state = mockDetailApi({ jobs: [heldJobFixture] });
    renderDetail();

    const button = await screen.findByRole("button", { name: "Relaunch with instructions" });
    await userEvent.click(button);

    await waitFor(() => expect(state.runAiCalls).toEqual([{ withInstructions: true }]));
  });

  it("hint 'aggiungi un commento': assente quando l'utente ha già commentato", async () => {
    // I commenti fixture includono un commento utente → nessun hint.
    mockDetailApi({ jobs: [heldJobFixture] });
    renderDetail();

    await screen.findByRole("button", { name: "Relaunch with instructions" });
    expect(screen.queryByText(/Add a comment with the instructions/i)).not.toBeInTheDocument();
  });

  it("hint 'aggiungi un commento': presente quando non ci sono commenti utente", async () => {
    // Solo un commento AI → manca un commento utente con le istruzioni.
    mockDetailApi({
      jobs: [heldJobFixture],
      comments: commentsFixture.filter((comment) => comment.authorType === "ai"),
    });
    renderDetail();

    await screen.findByRole("button", { name: "Relaunch with instructions" });
    expect(screen.getByText(/Add a comment with the instructions/i)).toBeInTheDocument();
  });

  it("job 'awaiting_plan_approval': Approva chiama approve-plan", async () => {
    const state = mockDetailApi({ jobs: [awaitingPlanJobFixture] });
    renderDetail();

    expect(await screen.findByText("Plan to approve")).toBeInTheDocument();
    const approve = screen.getByRole("button", { name: "Approve" });
    await userEvent.click(approve);

    await waitFor(() => expect(state.approveCalls).toBe(1));
  });

  it("job 'awaiting_plan_approval': Rifiuta chiama reject-plan e porta il focus al commento", async () => {
    const state = mockDetailApi({ jobs: [awaitingPlanJobFixture] });
    renderDetail();

    const reject = await screen.findByRole("button", { name: "Reject" });
    await userEvent.click(reject);

    await waitFor(() => expect(state.rejectCalls).toBe(1));
    expect(screen.getByLabelText(/add a comment/i)).toHaveFocus();
  });

  it("senza job 'awaiting_plan_approval': Approva/Rifiuta non compaiono", async () => {
    mockDetailApi({ jobs: [heldJobFixture] });
    renderDetail();

    await screen.findByRole("button", { name: "Start AI fix" });
    expect(screen.queryByRole("button", { name: "Approve" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Reject" })).not.toBeInTheDocument();
  });

  it("job 'pr_closed': mostra i bottoni di rilancio (PR rifiutata, ticket riaperto)", async () => {
    const state = mockDetailApi({ jobs: [prClosedJobFixture] });
    renderDetail();

    const avvia = await screen.findByRole("button", { name: "Start AI fix" });
    expect(screen.getByRole("button", { name: "Relaunch with instructions" })).toBeInTheDocument();

    await userEvent.click(avvia);
    await waitFor(() => expect(state.runAiCalls).toEqual([undefined]));
  });

  it("job 'failed': mostra i bottoni di rilancio (re-run manuale)", async () => {
    mockDetailApi({ jobs: [failedJobFixture] });
    renderDetail();

    expect(await screen.findByRole("button", { name: "Start AI fix" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Relaunch with instructions" })).toBeInTheDocument();
  });

  it("job 'pr_opened' in cima: nessun bottone di rilancio (PR già aperta)", async () => {
    mockDetailApi(); // l'ultimo job è pr_opened
    renderDetail();

    await screen.findByRole("heading", { name: "TypeError al checkout" });
    expect(screen.queryByRole("button", { name: "Start AI fix" })).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Relaunch with instructions" }),
    ).not.toBeInTheDocument();
  });

  it("job 'pr_merged' in cima: nessun bottone di rilancio (PR mergiata)", async () => {
    mockDetailApi({ jobs: [prMergedJobFixture] });
    renderDetail();

    await screen.findByRole("heading", { name: "TypeError al checkout" });
    expect(screen.queryByRole("button", { name: "Start AI fix" })).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Relaunch with instructions" }),
    ).not.toBeInTheDocument();
  });

  it("job in volo ('fixing'): nessun bottone di rilancio", async () => {
    mockDetailApi({ jobs: [fixingJobFixture] });
    renderDetail();

    await screen.findByRole("heading", { name: "TypeError al checkout" });
    expect(screen.queryByRole("button", { name: "Start AI fix" })).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Relaunch with instructions" }),
    ).not.toBeInTheDocument();
  });

  it("job 'awaiting_plan_approval': Approva/Rifiuta presenti, bottoni di rilancio assenti", async () => {
    mockDetailApi({ jobs: [awaitingPlanJobFixture] });
    renderDetail();

    expect(await screen.findByRole("button", { name: "Approve" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reject" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Start AI fix" })).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Relaunch with instructions" }),
    ).not.toBeInTheDocument();
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

    const toggle = await screen.findByRole("button", { name: /technical payload/i });
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

    expect(await screen.findByText("PR opened")).toBeInTheDocument();
    expect(screen.getByText("Failed")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /view pr/i })).toHaveAttribute(
      "href",
      "https://github.com/acme/shop/pull/12",
    );
    expect(screen.getByText("git clone: timeout")).toBeInTheDocument();
  });

  it("pannello Consumi AI: token totali, costo e righe per modello", async () => {
    mockDetailApi();
    renderDetail();

    expect(await screen.findByText("Consumi AI")).toBeInTheDocument();
    // 12555 → "12.555" (it-IT raggruppa dalle migliaia).
    expect(screen.getByText("12.555")).toBeInTheDocument();
    expect(screen.getByText("$0.0515")).toBeInTheDocument();
    expect(screen.getByText("claude-haiku-4-5")).toBeInTheDocument();
    expect(screen.getByText("claude-opus-4-8")).toBeInTheDocument();
  });

  it("senza consumi: il pannello Consumi AI non compare", async () => {
    mockDetailApi({ usage: emptyUsageFixture });
    renderDetail();

    // Attende che la pagina sia montata (timeline presente), poi verifica
    // l'assenza del pannello.
    await screen.findByText("AI activity");
    expect(screen.queryByText("Consumi AI")).not.toBeInTheDocument();
  });

  it("cambiare stato manda la PATCH e aggiorna la pagina", async () => {
    const state = mockDetailApi();
    renderDetail();

    const select = await screen.findByLabelText("Status");
    await userEvent.selectOptions(select, "in_progress");

    await waitFor(() => expect(state.patches).toEqual([{ status: "in_progress" }]));
    const header = screen.getByRole("banner");
    await waitFor(() => expect(within(header).getByText("In corso")).toBeInTheDocument());
  });

  it("la PATCH cancella i refetch in volo del dettaglio prima di scrivere in cache", async () => {
    const state = mockDetailApi();
    const { queryClient } = renderDetail();
    const cancelSpy = vi.spyOn(queryClient, "cancelQueries");

    await userEvent.selectOptions(await screen.findByLabelText("Status"), "in_progress");
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

    await userEvent.selectOptions(await screen.findByLabelText("Status"), "in_progress");
    await waitFor(() => expect(state.patches).toEqual([{ status: "in_progress" }]));

    // La chiave padre `boards()` matcha ogni board, qualunque filtro progetto.
    await waitFor(() =>
      expect(invalidate).toHaveBeenCalledWith({ queryKey: ticketKeys.boards() }),
    );
  });

  it("cambiare assegnatario manda la PATCH con l'id utente", async () => {
    const state = mockDetailApi();
    renderDetail();

    const select = await screen.findByLabelText("Assignee");
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

    const textarea = await screen.findByLabelText(/add a comment/i);
    await userEvent.type(textarea, "Sistemo io.");
    await userEvent.click(screen.getByRole("button", { name: /comment/i }));

    await waitFor(() => expect(state.postedComments).toEqual(["Sistemo io."]));
    expect(await screen.findByText("Sistemo io.")).toBeInTheDocument();
    expect(textarea).toHaveValue("");
  });
});
