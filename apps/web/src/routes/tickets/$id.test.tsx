import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ActivityItem,
  AIJob,
  Comment,
  MilestoneWithCounts,
  Ticket,
  TicketLinkView,
  TicketUsage,
} from "../../lib/api";
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
const MILESTONE_A = "aaaa1111-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const MILESTONE_B = "bbbb2222-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const milestonesFixture: MilestoneWithCounts[] = [
  {
    id: MILESTONE_A,
    projectId: PROJECT_ID,
    name: "Sprint 1",
    dueDate: null,
    status: "open",
    createdAt: "2026-01-01T00:00:00.000Z",
    counts: { total: 3, completed: 1, byStatus: {} },
  },
  {
    id: MILESTONE_B,
    projectId: PROJECT_ID,
    name: "Sprint 2",
    dueDate: null,
    status: "open",
    createdAt: "2026-01-02T00:00:00.000Z",
    counts: { total: 0, completed: 0, byStatus: {} },
  },
];

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
  milestoneId: null,
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
  // Vuoto di default: il fix non ha ancora toccato repository (placeholder).
  repositories: [],
};

const REPO_A_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const REPO_B_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

/** Stato PR per-repo di un ticket dopo l'esecuzione del fix (Fase 3). */
const ticketRepositoriesFixture = [
  {
    repositoryId: REPO_A_ID,
    repositorySlug: "shop-api",
    repositoryName: "Shop API",
    branch: "stubwise/fix-7",
    prUrl: "https://github.com/acme/shop-api/pull/12",
    prState: "open" as const,
  },
  {
    repositoryId: REPO_B_ID,
    repositorySlug: "shop-web",
    repositoryName: "Shop Web",
    branch: "stubwise/fix-7",
    prUrl: "https://github.com/acme/shop-web/pull/34",
    prState: "merged" as const,
  },
];

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
    providerLabel: null,
    providerKind: null,
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
    providerLabel: null,
    providerKind: null,
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

/** Link risolti del ticket: uno per direzione (outgoing/incoming). */
const linksFixture: TicketLinkView[] = [
  {
    linkId: "lk1",
    relation: "blocks",
    otherTicketId: "22222222-2222-4222-8222-222222222222",
    otherNumber: 9,
    otherTitle: "Migra il gateway pagamenti",
    otherStatus: "in_progress",
    createdAt: "2026-06-05T10:00:00.000Z",
  },
  {
    linkId: "lk2",
    relation: "child",
    otherTicketId: "33333333-3333-4333-8333-333333333333",
    otherNumber: 4,
    otherTitle: "Epica checkout",
    otherStatus: "open",
    createdAt: "2026-06-05T10:01:00.000Z",
  },
];

/** Ticket cercabili dal picker (oltre al ticket corrente, qui escluso). */
const searchableTicketsFixture: Ticket[] = [
  { ...ticketFixture, id: "44444444-4444-4444-8444-444444444444", number: 15, title: "Aggiungi retry al gateway" },
  { ...ticketFixture, id: "55555555-5555-4555-8555-555555555555", number: 16, title: "Logging strutturato" },
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
  usage: TicketUsage;
  jobs: AIJob[];
  /** Body inviati a POST /run-ai (per verificare il flag withInstructions). */
  runAiCalls: unknown[];
  /** Quante volte è stato chiamato POST /approve-plan. */
  approveCalls: number;
  /** Quante volte è stato chiamato POST /reject-plan. */
  rejectCalls: number;
  /** Eventi di audit accumulati (es. una PATCH di stato ne aggiunge uno). */
  events: ActivityItem[];
  /** Link risolti del ticket (sezione "Linked tickets"). */
  links: TicketLinkView[];
  /** Body inviati a POST /links (per verificare la creazione). */
  createdLinks: unknown[];
  /** linkId passati a DELETE /links/:linkId. */
  deletedLinks: string[];
}

/**
 * Compone il feed dallo stato corrente: commenti, marker dei job e gli eventi
 * di audit registrati (es. dalla PATCH), in ordine cronologico crescente —
 * gemello del feed che il server costruirebbe.
 */
function buildActivity(state: MockState): ActivityItem[] {
  const items: ActivityItem[] = [
    ...state.comments.map(
      (comment): ActivityItem => ({
        kind: "comment",
        id: comment.id,
        authorType: comment.authorType,
        authorId: comment.authorId,
        body: comment.body,
        createdAt: comment.createdAt,
      }),
    ),
    ...state.jobs.map(
      (job): ActivityItem => ({
        kind: "ai_job",
        id: job.id,
        status: job.status,
        prUrl: job.prUrl,
        createdAt: job.createdAt,
        finishedAt: job.finishedAt,
      }),
    ),
    ...state.events,
  ];
  return items.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

function mockDetailApi(
  overrides: {
    usage?: TicketUsage;
    ticket?: Ticket;
    jobs?: AIJob[];
    comments?: Comment[];
    links?: TicketLinkView[];
  } = {},
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
    events: [],
    links: overrides.links ?? [],
    createdLinks: [],
    deletedLinks: [],
  };

  mockApi({
    "GET /api/auth/me": () =>
      jsonResponse(200, {
        user: {
          id: ADMIN_ID,
          email: "ada@example.com",
          role: "admin",
          avatarUrl: null,
          slackUserId: null,
        },
      }),
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
        {
          id: ADMIN_ID,
          email: "ada@example.com",
          role: "admin",
          // Avatar Slack: alimenta l'<img> dell'avatar nel feed/assegnatario.
          avatarUrl: "https://avatars.slack-edge.com/ada.png",
          slackUserId: "U_ADA",
        },
        { id: MEMBER_ID, email: "bob@example.com", role: "member", avatarUrl: null, slackUserId: null },
      ]),
    "GET /api/milestones": () => jsonResponse(200, milestonesFixture),
    [`GET /api/tickets/${TICKET_ID}`]: () => jsonResponse(200, state.ticket),
    [`PATCH /api/tickets/${TICKET_ID}`]: (_url, init) => {
      const patch = JSON.parse(String(init?.body)) as Partial<Ticket>;
      state.patches.push(patch);
      // Una PATCH di stato genera un evento di audit nel feed, come farebbe il
      // server: così la timeline mostra la transizione.
      if (typeof patch.status === "string") {
        state.events.push({
          kind: "event",
          id: `ev${state.events.length + 1}`,
          eventKind: "status_changed",
          actorId: ADMIN_ID,
          payload: { from: state.ticket.status, to: patch.status },
          createdAt: "2026-06-09T11:00:00.000Z",
        });
      }
      // Una PATCH di milestone genera un milestone_changed (from/to = id|null).
      if ("milestoneId" in patch) {
        state.events.push({
          kind: "event",
          id: `ev${state.events.length + 1}`,
          eventKind: "milestone_changed",
          actorId: ADMIN_ID,
          payload: { from: state.ticket.milestoneId, to: patch.milestoneId ?? null },
          createdAt: "2026-06-09T11:05:00.000Z",
        });
      }
      state.ticket = { ...state.ticket, ...patch };
      return jsonResponse(200, state.ticket);
    },
    [`GET /api/tickets/${TICKET_ID}/comments`]: () => jsonResponse(200, state.comments),
    [`GET /api/tickets/${TICKET_ID}/activity`]: () => jsonResponse(200, buildActivity(state)),
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
    [`GET /api/tickets/${TICKET_ID}/attachments`]: () => jsonResponse(200, []),
    "GET /api/settings/instance": () =>
      jsonResponse(200, {
        contentLanguage: "en",
        monthlyBudgetUsd: null,
        s3Endpoint: null,
        s3Region: null,
        s3Bucket: null,
        s3AccessKey: null,
        s3SecretKeySet: false,
        attachmentsEnabled: false,
      }),
    [`GET /api/tickets/${TICKET_ID}/links`]: () => jsonResponse(200, state.links),
    [`POST /api/tickets/${TICKET_ID}/links`]: (_url, init) => {
      const body = JSON.parse(String(init?.body)) as {
        targetTicketId: string;
        kind: string;
      };
      state.createdLinks.push(body);
      return jsonResponse(201, {
        id: "newlink",
        sourceTicketId: TICKET_ID,
        targetTicketId: body.targetTicketId,
        kind: body.kind,
        createdAt: "2026-06-09T12:00:00.000Z",
      });
    },
    // Ricerca dei target nel picker: lista filtrata per projectId + q.
    "GET /api/tickets": (url) => {
      const q = (url.searchParams.get("q") ?? "").toLowerCase();
      const items = searchableTicketsFixture.filter((ticket) =>
        ticket.title.toLowerCase().includes(q),
      );
      return jsonResponse(200, { items, nextCursor: null });
    },
  });

  // DELETE /links/:linkId ha un path variabile: gestito a parte registrando
  // un matcher per prefisso sul fetch mock già installato da mockApi.
  const baseFetch = fetchMock.getMockImplementation()!;
  fetchMock.mockImplementation((input, init) => {
    const raw =
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(raw, "http://test.local");
    const method = init?.method ?? "GET";
    const match = url.pathname.match(
      new RegExp(`^/api/tickets/${TICKET_ID}/links/([^/]+)$`),
    );
    if (method === "DELETE" && match) {
      state.deletedLinks.push(match[1]!);
      return Promise.resolve(new Response(null, { status: 204 }));
    }
    return baseFetch(input, init);
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
  providerLabel: null,
  providerKind: null,
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
  providerLabel: null,
  providerKind: null,
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
  providerLabel: null,
  providerKind: null,
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
  providerLabel: null,
  providerKind: null,
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
  providerLabel: null,
  providerKind: null,
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
  providerLabel: null,
  providerKind: null,
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
    expect(within(header).getByText("Open")).toBeInTheDocument();
    expect(within(header).getByText("High")).toBeInTheDocument();
    expect(within(header).getByText("Bug")).toBeInTheDocument();
    // Il testo del badge origine è "◇ SDK": match parziale.
    expect(within(header).getByText(/SDK/)).toBeInTheDocument();
    expect(within(header).getByText("Shop Acme")).toBeInTheDocument();
    expect(within(header).getByText("×12")).toBeInTheDocument();
  });

  it("export .md: copia negli appunti frontmatter + corpo del ticket", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    mockDetailApi();
    renderDetail();

    await screen.findByRole("heading", { name: "TypeError al checkout" });
    await userEvent.click(screen.getByRole("button", { name: "Copy .md" }));

    expect(writeText).toHaveBeenCalledTimes(1);
    const md = writeText.mock.calls[0]![0] as string;
    expect(md).toContain('ticket: "#7"');
    expect(md).toContain('title: "TypeError al checkout"');
    expect(md).toContain("type: bug");
    expect(md).toContain("status: open");
    expect(md).toContain("priority: high");
    // Il corpo del ticket è incluso dopo il frontmatter.
    expect(md).toContain("Il bottone **Paga ora** lancia un'eccezione.");
    // Feedback "Copied!" dopo la copia.
    expect(await screen.findByRole("button", { name: "Copied!" })).toBeInTheDocument();
  });

  it("sezione Repository/PR: elenca repo, stato PR e link alla PR (fix eseguito)", async () => {
    mockDetailApi({ ticket: { ...ticketFixture, repositories: ticketRepositoriesFixture } });
    renderDetail();

    const section = await screen.findByRole("region", { name: "Repository / PR" });
    // Un repo con PR aperta e uno con PR mergiata: nomi, stati e link corretti.
    expect(within(section).getByText("Shop API")).toBeInTheDocument();
    expect(within(section).getByText("Shop Web")).toBeInTheDocument();
    expect(within(section).getByText("PR open")).toBeInTheDocument();
    expect(within(section).getByText("PR merged")).toBeInTheDocument();
    const prLinks = within(section).getAllByRole("link", { name: /view pr/i });
    expect(prLinks[0]).toHaveAttribute("href", "https://github.com/acme/shop-api/pull/12");
    expect(prLinks[1]).toHaveAttribute("href", "https://github.com/acme/shop-web/pull/34");
  });

  it("sezione Repository/PR: placeholder quando il fix non ha ancora toccato repo", async () => {
    mockDetailApi({ ticket: { ...ticketFixture, repositories: [] } });
    renderDetail();

    const section = await screen.findByRole("region", { name: "Repository / PR" });
    expect(within(section).getByText(/no PR yet/i)).toBeInTheDocument();
    expect(within(section).queryByRole("link", { name: /view pr/i })).not.toBeInTheDocument();
  });

  it("mostra l'effort stimato quando valorizzato (etichetta + n/5)", async () => {
    mockDetailApi({ ticket: { ...ticketFixture, effort: 3 } });
    renderDetail();

    const header = await screen.findByRole("banner");
    expect(within(header).getByText("Effort: Medium (3/5)")).toBeInTheDocument();
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

    // Stato held reso nel pannello "AI activity" (lo stato compare anche nel feed).
    const panel = await screen.findByRole("region", { name: "AI activity" });
    expect(within(panel).getByText("On hold")).toBeInTheDocument();

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

    const panel = await screen.findByRole("region", { name: "AI activity" });
    expect(within(panel).getByText("Plan to approve")).toBeInTheDocument();
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

  it("ticket senza job: mostra 'Start AI fix' (primo avvio) che chiama run-ai senza istruzioni", async () => {
    const state = mockDetailApi({ jobs: [] });
    renderDetail();

    const button = await screen.findByRole("button", { name: "Start AI fix" });
    await userEvent.click(button);

    // Primo avvio: nessun body (il server accoda un nuovo job triage).
    await waitFor(() => expect(state.runAiCalls).toEqual([undefined]));
  });

  it("ticket senza job: NON mostra 'Rilancia con istruzioni' né l'hint (solo primo avvio)", async () => {
    // Nessun commento utente: nel rilancio comparirebbe l'hint, ma al primo
    // avvio non ha senso → niente hint, niente bottone con istruzioni.
    mockDetailApi({
      jobs: [],
      comments: commentsFixture.filter((comment) => comment.authorType === "ai"),
    });
    renderDetail();

    await screen.findByRole("button", { name: "Start AI fix" });
    expect(
      screen.queryByRole("button", { name: "Relaunch with instructions" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText(/Add a comment with the instructions/i)).not.toBeInTheDocument();
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

  it("feed: il commento di un utente con avatar Slack mostra l'<img> dell'avatar", async () => {
    mockDetailApi();
    renderDetail();

    const feed = await screen.findByRole("region", { name: "Activity" });
    // Ada ha un avatarUrl: accanto alla sua firma compare l'immagine (alt=email).
    const avatar = within(feed).getByRole("img", { name: "ada@example.com" });
    expect(avatar).toHaveAttribute("src", "https://avatars.slack-edge.com/ada.png");
  });

  it("pannello assegnatario: l'assegnatario con avatar Slack mostra l'<img>", async () => {
    mockDetailApi({ ticket: { ...ticketFixture, assigneeId: ADMIN_ID } });
    renderDetail();

    // L'avatar dell'assegnatario sta nel contenitore del select "Assignee".
    const select = await screen.findByLabelText("Assignee");
    const panel = select.closest("div")!.parentElement!;
    expect(within(panel).getByRole("img", { name: "ada@example.com" })).toHaveAttribute(
      "src",
      "https://avatars.slack-edge.com/ada.png",
    );
  });

  it("timeline AI: stati, link alla PR ed errore del job fallito", async () => {
    mockDetailApi();
    renderDetail();

    // I marker di stato compaiono sia nel feed che nel pannello "AI activity":
    // si scopa il pannello, che è quello col dettaglio tecnico (errore, log).
    const panel = await screen.findByRole("region", { name: "AI activity" });
    expect(within(panel).getByText("PR opened")).toBeInTheDocument();
    expect(within(panel).getByText("Failed")).toBeInTheDocument();
    expect(within(panel).getByRole("link", { name: /view pr/i })).toHaveAttribute(
      "href",
      "https://github.com/acme/shop/pull/12",
    );
    expect(within(panel).getByText("git clone: timeout")).toBeInTheDocument();
  });

  it("pannello Consumi AI: token totali, costo e righe per modello", async () => {
    mockDetailApi();
    renderDetail();

    expect(await screen.findByText("AI usage")).toBeInTheDocument();
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
    expect(screen.queryByText("AI usage")).not.toBeInTheDocument();
  });

  it("cambiare stato manda la PATCH e aggiorna la pagina", async () => {
    const state = mockDetailApi();
    renderDetail();

    const select = await screen.findByLabelText("Status");
    await userEvent.selectOptions(select, "in_progress");

    await waitFor(() => expect(state.patches).toEqual([{ status: "in_progress" }]));
    const header = screen.getByRole("banner");
    await waitFor(() => expect(within(header).getByText("In progress")).toBeInTheDocument());
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

  it("assegnare una milestone manda la PATCH con il milestoneId", async () => {
    const state = mockDetailApi();
    renderDetail();

    const select = await screen.findByLabelText("Milestone");
    await userEvent.selectOptions(select, MILESTONE_A);

    await waitFor(() => expect(state.patches).toEqual([{ milestoneId: MILESTONE_A }]));
  });

  it("rimuovere la milestone (None) manda la PATCH con milestoneId null", async () => {
    const state = mockDetailApi({ ticket: { ...ticketFixture, milestoneId: MILESTONE_A } });
    renderDetail();

    const select = await screen.findByLabelText("Milestone");
    await userEvent.selectOptions(select, "");

    await waitFor(() => expect(state.patches).toEqual([{ milestoneId: null }]));
  });

  it("badge milestone: il dettaglio mostra il nome della milestone corrente", async () => {
    mockDetailApi({ ticket: { ...ticketFixture, milestoneId: MILESTONE_A } });
    renderDetail();

    const header = await screen.findByRole("banner");
    expect(within(header).getByText("Sprint 1")).toBeInTheDocument();
  });

  it("feed milestone_changed: assegnazione, cambio e rimozione rese leggibili", async () => {
    const state = mockDetailApi();
    state.events.push(
      {
        kind: "event",
        id: "evm1",
        eventKind: "milestone_changed",
        actorId: ADMIN_ID,
        payload: { from: null, to: MILESTONE_A },
        createdAt: "2026-06-02T09:40:00.000Z",
      },
      {
        kind: "event",
        id: "evm2",
        eventKind: "milestone_changed",
        actorId: ADMIN_ID,
        payload: { from: MILESTONE_A, to: MILESTONE_B },
        createdAt: "2026-06-02T09:41:00.000Z",
      },
      {
        kind: "event",
        id: "evm3",
        eventKind: "milestone_changed",
        actorId: ADMIN_ID,
        payload: { from: MILESTONE_B, to: null },
        createdAt: "2026-06-02T09:42:00.000Z",
      },
    );
    renderDetail();

    const feed = await screen.findByRole("region", { name: "Activity" });
    expect(within(feed).getByText("ada@example.com set milestone Sprint 1")).toBeInTheDocument();
    expect(
      within(feed).getByText("ada@example.com changed milestone: Sprint 1 → Sprint 2"),
    ).toBeInTheDocument();
    expect(
      within(feed).getByText("ada@example.com removed milestone Sprint 2"),
    ).toBeInTheDocument();
  });

  it("rimuovere una label manda la PATCH con la lista nuova", async () => {
    const state = mockDetailApi();
    renderDetail();

    await userEvent.click(
      await screen.findByRole("button", { name: /remove label pagamenti/i }),
    );

    await waitFor(() => expect(state.patches).toEqual([{ labels: [] }]));
  });

  it("aggiungere un commento: POST, feed aggiornato e campo svuotato", async () => {
    const state = mockDetailApi();
    renderDetail();

    const textarea = await screen.findByLabelText(/add a comment/i);
    await userEvent.type(textarea, "Sistemo io.");
    await userEvent.click(screen.getByRole("button", { name: /comment/i }));

    await waitFor(() => expect(state.postedComments).toEqual(["Sistemo io."]));
    // Il commento compare nel feed (Activity), invalidato dalla mutazione.
    const feed = screen.getByRole("region", { name: "Activity" });
    expect(await within(feed).findByText("Sistemo io.")).toBeInTheDocument();
    expect(textarea).toHaveValue("");
  });

  it("feed Attività: rende commento, evento di audit e marker job AI", async () => {
    const state = mockDetailApi();
    state.events.push({
      kind: "event",
      id: "ev0",
      eventKind: "status_changed",
      actorId: ADMIN_ID,
      payload: { from: "open", to: "in_progress" },
      createdAt: "2026-06-02T09:30:00.000Z",
    });
    renderDetail();

    const feed = await screen.findByRole("region", { name: "Activity" });
    // comment kind
    expect(within(feed).getByText("Riprodotto anche su staging.")).toBeInTheDocument();
    // event kind: riga di audit con label di stato risolte
    expect(
      within(feed).getByText("ada@example.com changed status: Open → In progress"),
    ).toBeInTheDocument();
    // ai_job kind: marker di stato del job
    expect(within(feed).getByText("PR opened")).toBeInTheDocument();
  });

  it("feed Attività: un cambio stato genera una riga di audit nel feed", async () => {
    mockDetailApi();
    renderDetail();

    await userEvent.selectOptions(await screen.findByLabelText("Status"), "in_progress");

    const feed = screen.getByRole("region", { name: "Activity" });
    expect(
      await within(feed).findByText("ada@example.com changed status: Open → In progress"),
    ).toBeInTheDocument();
  });

  it("feed Attività: un evento relazione mostra il testo i18n giusto (kind+direzione)", async () => {
    const state = mockDetailApi();
    // outgoing blocks → "linked: blocks #9"; incoming blocks → "blocked by".
    state.events.push(
      {
        kind: "event",
        id: "evr1",
        eventKind: "relation_added",
        actorId: ADMIN_ID,
        payload: { kind: "blocks", direction: "outgoing", otherTicketId: "x", otherNumber: 9 },
        createdAt: "2026-06-02T09:31:00.000Z",
      },
      {
        kind: "event",
        id: "evr2",
        eventKind: "relation_added",
        actorId: ADMIN_ID,
        payload: { kind: "parent", direction: "incoming", otherTicketId: "y", otherNumber: 4 },
        createdAt: "2026-06-02T09:32:00.000Z",
      },
      {
        kind: "event",
        id: "evr3",
        eventKind: "relation_removed",
        actorId: ADMIN_ID,
        payload: { kind: "relates_to", direction: "outgoing", otherTicketId: "z", otherNumber: 7 },
        createdAt: "2026-06-02T09:33:00.000Z",
      },
    );
    renderDetail();

    const feed = await screen.findByRole("region", { name: "Activity" });
    expect(within(feed).getByText("ada@example.com linked: blocks #9")).toBeInTheDocument();
    // parent incoming → "child of"
    expect(within(feed).getByText("ada@example.com linked: child of #4")).toBeInTheDocument();
    expect(
      within(feed).getByText("ada@example.com removed link: relates to #7"),
    ).toBeInTheDocument();
  });

  it("Linked tickets: elenca i link con la label di relazione, il numero e lo stato", async () => {
    mockDetailApi({ links: linksFixture });
    renderDetail();

    const section = await screen.findByRole("region", { name: "Linked tickets" });
    expect(within(section).getByText("Blocks")).toBeInTheDocument();
    expect(within(section).getByText("Child of")).toBeInTheDocument();
    // Link al ticket collegato (#9 + titolo) e badge di stato.
    expect(within(section).getByRole("link", { name: /#9.*Migra il gateway/ })).toBeInTheDocument();
    expect(within(section).getByText("In progress")).toBeInTheDocument();
    expect(within(section).getByText("Open")).toBeInTheDocument();
  });

  it("Linked tickets: niente link → riga vuota", async () => {
    mockDetailApi({ links: [] });
    renderDetail();

    const section = await screen.findByRole("region", { name: "Linked tickets" });
    expect(within(section).getByText("// no linked tickets")).toBeInTheDocument();
  });

  it("Linked tickets: il picker cerca un target e crea il link con la kind scelta", async () => {
    const state = mockDetailApi({ links: [] });
    renderDetail();

    const section = await screen.findByRole("region", { name: "Linked tickets" });
    await userEvent.click(within(section).getByRole("button", { name: "Link ticket" }));

    await userEvent.type(within(section).getByLabelText("Search tickets"), "retry");
    // Risultato filtrato per titolo.
    const result = await within(section).findByRole("button", { name: /#15.*retry al gateway/i });
    await userEvent.click(result);

    await userEvent.selectOptions(within(section).getByLabelText("Relation"), "blocks");
    await userEvent.click(within(section).getByRole("button", { name: "Create link" }));

    await waitFor(() =>
      expect(state.createdLinks).toEqual([
        { targetTicketId: "44444444-4444-4444-8444-444444444444", kind: "blocks" },
      ]),
    );
  });

  it("Linked tickets: il bottone remove chiama DELETE solo dopo la conferma a due click", async () => {
    const state = mockDetailApi({ links: linksFixture });
    renderDetail();

    const section = await screen.findByRole("region", { name: "Linked tickets" });
    const removeButton = within(section).getByRole("button", {
      name: /remove link to #9/i,
    });

    // Primo click: arma la conferma (label → "Confirm?"), nessuna DELETE.
    await userEvent.click(removeButton);
    expect(removeButton).toHaveTextContent("Confirm?");
    expect(state.deletedLinks).toEqual([]);

    // Secondo click sulla stessa riga: scatena la DELETE.
    await userEvent.click(removeButton);
    await waitFor(() => expect(state.deletedLinks).toEqual(["lk1"]));
  });
});
