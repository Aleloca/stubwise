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
  TicketQuestion,
  TicketRepository,
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
    description: null,
    dueDate: null,
    status: "open",
    closedAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    counts: { total: 3, completed: 1, byStatus: {} },
  },
  {
    id: MILESTONE_B,
    projectId: PROJECT_ID,
    name: "Sprint 2",
    description: null,
    dueDate: null,
    status: "open",
    closedAt: null,
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
  // Design/piano non collegati di default (solo nel dettaglio).
  implementationPlan: null,
  originContent: null,
  planSummary: null,
  // Vuoto di default: il fix non ha ancora toccato repository (placeholder).
  repositories: [],
};

const REPO_A_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const REPO_B_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

/**
 * Stato PR per-repo di un ticket dopo l'esecuzione del fix (Fase 3).
 *
 * ⚠️ SENZA `cycle` apposta (30 set 2026): è la risposta di un server senza il
 * ciclo di correzione, e sul web il `.default(null)` dello schema non gira
 * (`lib/api.ts` fa un cast, non un parse). Il tipo del web lo ammette
 * (`cycle` è opzionale in `TicketRepository`): non completarla.
 */
const ticketRepositoriesFixture: TicketRepository[] = [
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
    requestedByUserId: null,
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
    requestedByUserId: null,
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
  {
    ...ticketFixture,
    id: "44444444-4444-4444-8444-444444444444",
    number: 15,
    title: "Aggiungi retry al gateway",
  },
  {
    ...ticketFixture,
    id: "55555555-5555-4555-8555-555555555555",
    number: 16,
    title: "Logging strutturato",
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
  /** Il corpo JSON INTERO di ogni POST /comments (per `replyToCommentId`). */
  postedPayloads: unknown[];
  usage: TicketUsage;
  jobs: AIJob[];
  /** Body inviati a POST /run-ai (per verificare il flag withInstructions). */
  runAiCalls: unknown[];
  /** Quante volte è stato chiamato POST /approve-plan. */
  approveCalls: number;
  /** Quante volte è stato chiamato POST /reject-plan. */
  rejectCalls: number;
  /** Body inviati a POST /reject-plan (per verificare le istruzioni). */
  rejectBodies: unknown[];
  /** Eventi di audit accumulati (es. una PATCH di stato ne aggiunge uno). */
  events: ActivityItem[];
  /** Link risolti del ticket (sezione "Linked tickets"). */
  links: TicketLinkView[];
  /** Body inviati a POST /links (per verificare la creazione). */
  createdLinks: unknown[];
  /** linkId passati a DELETE /links/:linkId. */
  deletedLinks: string[];
  /** Quante volte è stato chiamato DELETE /design. */
  designDeletes: number;
  /** Quante volte è stato chiamato DELETE /plan. */
  planDeletes: number;
  /** Quante volte è stato chiamato POST /pre-approve-plan. */
  preApproveCalls: number;
  /** Quante volte è stato chiamato DELETE /pre-approve-plan. */
  revokeApprovalCalls: number;
  /** Q&A dell'agente sul ticket (GET /questions). */
  questions: TicketQuestion[];
  /** Body inviati a POST /questions/answer. */
  answerBodies: unknown[];
  /** PATCH /comments/:commentId: id e corpo JSON (0084). */
  commentPatches: { id: string; body: unknown }[];
  /** DELETE /comments/:commentId: gli id (0084). */
  commentDeletes: string[];
}

/**
 * `a` viene prima di `b` nel documento, dall'ordine dell'albero letto a mano.
 * Con `compareDocumentPosition` su questa pagina la mutazione che spostava il
 * campo dei commenti IN FONDO restava verde: questa forma l'ha fatta fallire.
 */
function precedes(a: Element, b: Element): boolean {
  const all = Array.from(document.querySelectorAll("*"));
  const ia = all.indexOf(a);
  const ib = all.indexOf(b);
  if (ia < 0 || ib < 0) throw new Error("elemento non nel documento");
  return ia < ib;
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
        // ⚠️ `replyTo` passa SOLO se la fixture ce l'ha: le fixture di default
        // (`commentsFixture`) ne sono prive APPOSTA — è la risposta di un
        // server più vecchio della 0083, e il web (che fa un cast) deve reggerla.
        ...(comment.replyTo !== undefined ? { replyTo: comment.replyTo } : {}),
        // 0084: stessa regola — i campi passano SOLO se la fixture li ha.
        ...(comment.editedAt !== undefined ? { editedAt: comment.editedAt } : {}),
        ...(comment.deletedAt !== undefined ? { deletedAt: comment.deletedAt } : {}),
        ...(comment.deletedBy !== undefined ? { deletedBy: comment.deletedBy } : {}),
        ...(comment.canEdit !== undefined ? { canEdit: comment.canEdit } : {}),
        ...(comment.canDelete !== undefined ? { canDelete: comment.canDelete } : {}),
        ...(comment.inDecisionLog !== undefined ? { inDecisionLog: comment.inDecisionLog } : {}),
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
    /** Ruolo dell'utente corrente: "admin" = maintainer (default). */
    role?: "admin" | "member";
    /** Risposta di POST /run-ai: default 202 queued; serve per 409 e gate piano. */
    runAiResponse?: () => Response;
    /** Q&A dell'agente sul ticket: default nessuna. */
    questions?: TicketQuestion[];
    /** Risposta di POST /questions/answer: default 200; serve per il 409. */
    answerResponse?: () => Response;
    /** Risposta di POST /comments al posto della creazione: serve per il 422. */
    commentResponse?: () => Response;
    /** Risposta di PATCH /comments/:id al posto della modifica: serve per il 409 (0084). */
    commentEditResponse?: () => Response;
    /** Risposta di GET /history: default una storia di un evento; serve per il 404. */
    historyResponse?: () => Response;
    /** Risposta di GET /api/agent-sessions: default 404 senza `code` (server senza la funzione). */
    agentSessionsResponse?: () => Response;
  } = {},
): MockState {
  const state: MockState = {
    ticket: overrides.ticket ?? { ...ticketFixture },
    comments: overrides.comments ?? [...commentsFixture],
    patches: [],
    postedComments: [],
    postedPayloads: [],
    usage: overrides.usage ?? usageFixture,
    jobs: overrides.jobs ?? jobsFixture,
    runAiCalls: [],
    approveCalls: 0,
    rejectCalls: 0,
    rejectBodies: [],
    events: [],
    links: overrides.links ?? [],
    createdLinks: [],
    deletedLinks: [],
    designDeletes: 0,
    planDeletes: 0,
    preApproveCalls: 0,
    revokeApprovalCalls: 0,
    questions: overrides.questions ?? [],
    answerBodies: [],
    commentPatches: [],
    commentDeletes: [],
  };

  mockApi({
    "GET /api/auth/me": () => {
      const role = overrides.role ?? "admin";
      return jsonResponse(200, {
        user: {
          id: role === "admin" ? ADMIN_ID : MEMBER_ID,
          email: role === "admin" ? "ada@example.com" : "bob@example.com",
          role,
          avatarUrl: null,
          slackUserId: null,
        },
      });
    },
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
        {
          id: MEMBER_ID,
          email: "bob@example.com",
          role: "member",
          avatarUrl: null,
          slackUserId: null,
        },
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
    // 0084: PATCH/DELETE di ogni commento della fixture iniziale.
    ...Object.fromEntries(
      state.comments.flatMap((initial): [string, Handler][] => [
        [
          `PATCH /api/tickets/${TICKET_ID}/comments/${initial.id}`,
          (_url, init) => {
            const body = JSON.parse(String(init?.body)) as { body: string };
            state.commentPatches.push({ id: initial.id, body });
            if (overrides.commentEditResponse) return overrides.commentEditResponse();
            state.comments = state.comments.map((c) =>
              c.id === initial.id
                ? { ...c, body: body.body, editedAt: "2026-06-09T12:00:00.000Z" }
                : c,
            );
            return jsonResponse(
              200,
              state.comments.find((c) => c.id === initial.id),
            );
          },
        ],
        [
          `DELETE /api/tickets/${TICKET_ID}/comments/${initial.id}`,
          () => {
            state.commentDeletes.push(initial.id);
            state.comments = state.comments.map((c) =>
              c.id === initial.id
                ? {
                    ...c,
                    body: "",
                    deletedAt: "2026-06-09T12:00:00.000Z",
                    deletedBy: { name: "ada@example.com" },
                    canEdit: false,
                    canDelete: false,
                  }
                : c,
            );
            return new Response(null, { status: 204 });
          },
        ],
      ]),
    ),
    [`GET /api/tickets/${TICKET_ID}/activity`]: () => jsonResponse(200, buildActivity(state)),
    // La storia: SENZA i campi facoltativi e senza `total`, apposta (server
    // che non li manda; il componente li difende).
    "GET /api/agent-sessions": () =>
      overrides.agentSessionsResponse?.() ??
      jsonResponse(404, { error: "not_found", message: "Not found" }),
    [`GET /api/tickets/${TICKET_ID}/history`]: () =>
      overrides.historyResponse
        ? overrides.historyResponse()
        : jsonResponse(200, {
            events: [{ id: "run_started:j1", kind: "run_started", at: "2026-06-03T09:00:00.000Z" }],
          }),
    [`POST /api/tickets/${TICKET_ID}/comments`]: (_url, init) => {
      state.postedPayloads.push(JSON.parse(String(init?.body)));
      if (overrides.commentResponse) return overrides.commentResponse();
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
      return overrides.runAiResponse
        ? overrides.runAiResponse()
        : jsonResponse(202, { jobId: "j3", status: "queued" });
    },
    [`POST /api/tickets/${TICKET_ID}/approve-plan`]: () => {
      state.approveCalls += 1;
      return jsonResponse(202, { jobId: "j3" });
    },
    [`POST /api/tickets/${TICKET_ID}/reject-plan`]: (_url, init) => {
      state.rejectCalls += 1;
      state.rejectBodies.push(init?.body ? JSON.parse(String(init.body)) : undefined);
      return jsonResponse(202, { jobId: "j3" });
    },
    [`DELETE /api/tickets/${TICKET_ID}/design`]: () => {
      state.designDeletes += 1;
      // Ripristina l'origine nel body e azzera originContent (forma dettaglio).
      state.ticket = {
        ...state.ticket,
        body: state.ticket.originContent ?? state.ticket.body,
        originContent: null,
      };
      return jsonResponse(200, state.ticket);
    },
    [`DELETE /api/tickets/${TICKET_ID}/plan`]: () => {
      state.planDeletes += 1;
      state.ticket = { ...state.ticket, implementationPlan: null };
      return jsonResponse(200, state.ticket);
    },
    [`POST /api/tickets/${TICKET_ID}/pre-approve-plan`]: () => {
      state.preApproveCalls += 1;
      state.ticket = {
        ...state.ticket,
        planApprovedAt: "2026-06-09T12:30:00.000Z",
        planApprovedBy: { id: ADMIN_ID, email: "ada@example.com" },
        planApprovalStale: false,
      };
      return jsonResponse(200, state.ticket);
    },
    [`DELETE /api/tickets/${TICKET_ID}/pre-approve-plan`]: () => {
      state.revokeApprovalCalls += 1;
      state.ticket = {
        ...state.ticket,
        planApprovedAt: null,
        planApprovedBy: null,
        planApprovalStale: false,
      };
      return jsonResponse(200, state.ticket);
    },
    [`GET /api/tickets/${TICKET_ID}/questions`]: () => jsonResponse(200, state.questions),
    [`POST /api/tickets/${TICKET_ID}/questions/answer`]: (_url, init) => {
      state.answerBodies.push(init?.body ? JSON.parse(String(init.body)) : undefined);
      return overrides.answerResponse
        ? overrides.answerResponse()
        : jsonResponse(200, { jobId: "jq", questionId: openQuestionFixture.questionId });
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
    const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(raw, "http://test.local");
    const method = init?.method ?? "GET";
    const match = url.pathname.match(new RegExp(`^/api/tickets/${TICKET_ID}/links/([^/]+)$`));
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
  requestedByUserId: null,
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
  requestedByUserId: null,
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
  requestedByUserId: null,
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
  requestedByUserId: null,
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
  requestedByUserId: null,
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
  requestedByUserId: null,
};

/**
 * Job fermo su una domanda dell'agente, CHIESTO dall'operatore: è l'unica
 * fixture con `requestedByUserId` valorizzato, perché è il campo con cui la
 * pagina decide chi vede il pannello di risposta.
 */
const awaitingInputJobFixture: AIJob = {
  id: "jq",
  ticketId: TICKET_ID,
  status: "awaiting_input",
  log: "[plan] domanda all'umano, in attesa di risposta",
  prUrl: null,
  error: null,
  createdAt: "2026-06-07T10:00:00.000Z",
  startedAt: "2026-06-07T10:00:02.000Z",
  finishedAt: null,
  providerLabel: null,
  providerKind: null,
  requestedByUserId: MEMBER_ID,
};

/** La domanda aperta del job qui sopra, nella forma di GET /questions. */
const openQuestionFixture: TicketQuestion = {
  questionId: "66666666-6666-4666-8666-666666666666",
  jobId: "jq",
  round: 2,
  question: "Quale coda uso per i job del grafo?",
  options: [
    { label: "Quella esistente", consequence: "Nessuna migrazione" },
    { label: "Una coda nuova" },
  ],
  recommendedIndex: 0,
  allowFreeText: true,
  askedAt: "2026-06-07T10:00:03.000Z",
  answer: null,
  answeredAt: null,
  answeredBy: null,
};

/** Una Q&A già chiusa: alimenta lo storico collassabile. */
const answeredQuestionFixture: TicketQuestion = {
  questionId: "77777777-7777-4777-8777-777777777777",
  jobId: "jq",
  round: 1,
  question: "Quali colonne devo toccare?",
  options: [{ label: "Le vecchie" }, { label: "Le nuove" }],
  allowFreeText: false,
  askedAt: "2026-06-07T09:00:00.000Z",
  answer: { optionIndex: 1 },
  answeredAt: "2026-06-07T09:05:00.000Z",
  answeredBy: { id: ADMIN_ID, email: "ada@example.com" },
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

/** Le GET /api/agent-sessions fatte finora. */
function agentSessionCalls(): URL[] {
  return fetchMock.mock.calls
    .map(([input]) => new URL(String(input), "http://test.local"))
    .filter((u) => u.pathname === "/api/agent-sessions");
}

const AGENT_SESSION_ID = "11111111-1111-4111-8111-111111111111";

function agentSessionList(outcome: "completed" | null) {
  const summary = {
    id: AGENT_SESSION_ID,
    kind: "ai_job",
    title: "Fix",
    projectId: null,
    projectName: null,
    ticketId: TICKET_ID,
    ticketNumber: 7,
    startedAt: "2026-06-03T10:00:05.000Z",
    lastEventAt: null,
    state: outcome === null ? "working" : "ended",
    aiJobId: "22222222-2222-4222-8222-222222222222",
    outcome,
  };
  return outcome === null ? { live: [summary], recent: [] } : { live: [], recent: [summary] };
}

describe("dettaglio ticket", () => {
  it("sessione viva: «Watch the session» porta a /agents/<id>", async () => {
    mockDetailApi({ agentSessionsResponse: () => jsonResponse(200, agentSessionList(null)) });
    renderDetail();

    const link = await screen.findByRole("link", { name: "Watch the session" });
    expect(link).toHaveAttribute("href", `/agents/${AGENT_SESSION_ID}`);
    expect(screen.queryByRole("link", { name: "Replay the session" })).toBeNull();
  });

  it("job in coda senza sessione, poi in corso con la sessione: il link compare senza ricaricare", async () => {
    const job = (status: AIJob["status"]): AIJob => ({ ...jobsFixture[0]!, id: "jq", status });
    let session = false;
    const state = mockDetailApi({
      jobs: [job("queued")],
      agentSessionsResponse: () =>
        jsonResponse(200, session ? agentSessionList(null) : { live: [], recent: [] }),
    });
    const { queryClient } = renderDetail();
    await screen.findByRole("region", { name: "AI activity" });
    await waitFor(() => expect(agentSessionCalls()).toHaveLength(1));
    expect(screen.queryByRole("link", { name: "Watch the session" })).toBeNull();

    // Il worker prende il job: la polling dei job lo vede, il lookup riparte.
    session = true;
    state.jobs = [job("triaging")];
    await queryClient.invalidateQueries({ queryKey: ticketKeys.jobs(TICKET_ID) });

    expect(await screen.findByRole("link", { name: "Watch the session" })).toBeInTheDocument();
  });

  it("ticket senza job: nessuna richiesta di sessioni", async () => {
    mockDetailApi({ jobs: [] });
    renderDetail();

    await screen.findByRole("region", { name: "AI activity" });
    expect(agentSessionCalls()).toHaveLength(0);
  });

  it("nuovo ultimo job: il lookup riparte con il suo id", async () => {
    const job = (id: string): AIJob => ({ ...jobsFixture[0]!, id });
    const state = mockDetailApi({
      jobs: [job("j-one")],
      agentSessionsResponse: () => jsonResponse(200, { live: [], recent: [] }),
    });
    const { queryClient } = renderDetail();
    await waitFor(() => expect(agentSessionCalls()).toHaveLength(1));

    state.jobs = [job("j-two"), job("j-one")];
    await queryClient.invalidateQueries({ queryKey: ticketKeys.jobs(TICKET_ID) });

    await waitFor(() => expect(agentSessionCalls()).toHaveLength(2));
    expect(agentSessionCalls().map((u) => u.searchParams.get("aiJobId"))).toEqual([
      "j-one",
      "j-two",
    ]);
  });

  it("sessione conclusa: «Replay the session»", async () => {
    mockDetailApi({
      agentSessionsResponse: () => jsonResponse(200, agentSessionList("completed")),
    });
    renderDetail();

    const link = await screen.findByRole("link", { name: "Replay the session" });
    expect(link).toHaveAttribute("href", `/agents/${AGENT_SESSION_ID}`);
  });

  it("server senza le rotte (404 senza code): nessun link e la pagina resta intera", async () => {
    mockDetailApi();
    renderDetail();

    expect(await screen.findByRole("region", { name: "AI activity" })).toBeInTheDocument();
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(([input]) => String(input).includes("/api/agent-sessions")),
      ).toBe(true),
    );
    expect(screen.queryByRole("link", { name: "Watch the session" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Replay the session" })).toBeNull();
    expect(screen.getByRole("heading", { name: "TypeError al checkout" })).toBeInTheDocument();
  });

  it("«Story of the work» sta subito PRIMA di «AI activity», con le righe del server", async () => {
    mockDetailApi();
    renderDetail();

    const story = await screen.findByRole("region", { name: "Story of the work" });
    expect(await within(story).findByText("Run started")).toBeInTheDocument();
    const ai = screen.getByRole("region", { name: "AI activity" });
    expect(precedes(story, ai)).toBe(true);
    expect(story.nextElementSibling).toBe(ai);
  });

  it("un server senza la rotta (404): «Story not available» e il resto della pagina resta", async () => {
    mockDetailApi({
      historyResponse: () => jsonResponse(404, { error: "not_found", message: "Not found" }),
    });
    renderDetail();

    const story = await screen.findByRole("region", { name: "Story of the work" });
    expect(await within(story).findByText("Story not available.")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "TypeError al checkout" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "AI activity" })).toBeInTheDocument();
  });

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

  it("export .md: include il piano come sezione dedicata quando presente", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    mockDetailApi({
      ticket: { ...ticketFixture, implementationPlan: "1. Aggiungi retry al gateway." },
    });
    renderDetail();

    await screen.findByRole("heading", { name: "TypeError al checkout" });
    await userEvent.click(screen.getByRole("button", { name: "Copy .md" }));

    const md = writeText.mock.calls[0]![0] as string;
    // Il piano segue il corpo come sezione "## Implementation plan" (label i18n).
    expect(md).toContain("## Implementation plan");
    expect(md).toContain("1. Aggiungi retry al gateway.");
  });

  it("riassunto in breve del piano: reso sopra il piano, con la sua etichetta", async () => {
    mockDetailApi({
      ticket: {
        ...ticketFixture,
        implementationPlan: "1. Aggiungi endpoint **/retry**.",
        planSummary: "Il pagamento riprova da solo quando il gateway non risponde.",
      },
    });
    renderDetail();

    await screen.findByRole("heading", { name: "TypeError al checkout" });
    expect(screen.getByText("In brief")).toBeInTheDocument();
    const riassunto = screen.getByText(
      "Il pagamento riprova da solo quando il gateway non risponde.",
    );
    expect(riassunto).toBeInTheDocument();
  });

  it("senza planSummary la sezione del piano resta quella di prima", async () => {
    mockDetailApi({
      ticket: { ...ticketFixture, implementationPlan: "1. Aggiungi endpoint **/retry**." },
    });
    renderDetail();

    await screen.findByRole("heading", { name: "TypeError al checkout" });
    expect(screen.queryByText("In brief")).toBeNull();
  });

  it("piano di implementazione: reso in markdown quando presente", async () => {
    mockDetailApi({
      ticket: { ...ticketFixture, implementationPlan: "1. Aggiungi endpoint **/retry**." },
    });
    renderDetail();

    const section = await screen.findByRole("region", { name: "Implementation plan" });
    const bold = within(section).getByText("/retry");
    expect(bold.tagName).toBe("STRONG");
  });

  it("piano di implementazione: empty state quando assente", async () => {
    mockDetailApi();
    renderDetail();

    const section = await screen.findByRole("region", { name: "Implementation plan" });
    expect(within(section).getByText(/No implementation plan yet/i)).toBeInTheDocument();
  });

  it("richiesta originale: blocco collassabile con originContent, assente se null", async () => {
    mockDetailApi({
      ticket: {
        ...ticketFixture,
        body: "Design collegato.",
        originContent: "La **richiesta** iniziale.",
      },
    });
    renderDetail();

    // Il corpo mostra il design; l'origine è nel blocco collassabile, montato
    // solo da aperto (CollapsibleSection).
    const toggle = await screen.findByRole("button", { name: /Original request/ });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    await userEvent.click(toggle);
    const bold = await screen.findByText("richiesta");
    expect(bold.tagName).toBe("STRONG");
  });

  it("richiesta originale: assente quando originContent è null", async () => {
    mockDetailApi();
    renderDetail();

    await screen.findByRole("heading", { name: "TypeError al checkout" });
    expect(screen.queryByText("Original request")).not.toBeInTheDocument();
  });

  it("elimina design: conferma a due passi chiama la DELETE e ripristina l'origine", async () => {
    const state = mockDetailApi({
      ticket: { ...ticketFixture, body: "Design collegato.", originContent: "Origine." },
    });
    renderDetail();

    await userEvent.click(await screen.findByRole("button", { name: "Remove design" }));
    // Secondo passo: conferma.
    await userEvent.click(
      await screen.findByRole("button", { name: "Confirm removing the design" }),
    );

    await waitFor(() => expect(state.designDeletes).toBe(1));
    // L'origine torna nel corpo e il blocco "Richiesta originale" sparisce.
    await waitFor(() => expect(screen.getByText("Origine.")).toBeInTheDocument());
    await waitFor(() => expect(screen.queryByText("Original request")).not.toBeInTheDocument());
  });

  it("elimina piano: conferma a due passi chiama la DELETE", async () => {
    const state = mockDetailApi({
      ticket: { ...ticketFixture, implementationPlan: "Passi del piano." },
    });
    renderDetail();

    await userEvent.click(await screen.findByRole("button", { name: "Remove plan" }));
    await userEvent.click(await screen.findByRole("button", { name: "Confirm removing the plan" }));

    await waitFor(() => expect(state.planDeletes).toBe(1));
    const section = await screen.findByRole("region", { name: "Implementation plan" });
    await waitFor(() =>
      expect(within(section).getByText(/No implementation plan yet/i)).toBeInTheDocument(),
    );
  });

  it("elimina design/piano: nessun bottone quando i campi sono null o il ticket è chiuso", async () => {
    mockDetailApi({
      ticket: {
        ...ticketFixture,
        status: "closed",
        body: "Design.",
        originContent: "Origine.",
        implementationPlan: "Piano.",
      },
    });
    renderDetail();

    await screen.findByRole("heading", { name: "TypeError al checkout" });
    // Ticket chiuso: le azioni di rimozione sono nascoste anche se i campi ci sono.
    expect(screen.queryByRole("button", { name: "Remove design" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Remove plan" })).not.toBeInTheDocument();
  });

  it("pre-approvazione: assente quando non c'è un piano", async () => {
    mockDetailApi();
    renderDetail();

    await screen.findByRole("heading", { name: "TypeError al checkout" });
    expect(
      screen.queryByRole("button", { name: "Approve plan in advance" }),
    ).not.toBeInTheDocument();
  });

  it("pre-approvazione: il maintainer approva, la riga di stato compare con nome e data", async () => {
    const state = mockDetailApi({
      ticket: { ...ticketFixture, implementationPlan: "1. Fai questo." },
    });
    renderDetail();

    const approve = await screen.findByRole("button", { name: "Approve plan in advance" });
    await userEvent.click(approve);

    await waitFor(() => expect(state.preApproveCalls).toBe(1));
    expect(
      await screen.findByText(/plan approved by ada@example\.com on .+, ready to start/i),
    ).toBeInTheDocument();
    // Il bottone diventa "Revoke": approvare di nuovo non ha senso finché lo è.
    expect(
      screen.queryByRole("button", { name: "Approve plan in advance" }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Revoke approval" })).toBeInTheDocument();
  });

  it("pre-approvazione: piano già approvato, il bottone Revoke la azzera", async () => {
    const state = mockDetailApi({
      ticket: {
        ...ticketFixture,
        implementationPlan: "1. Fai questo.",
        planApprovedAt: "2026-06-09T12:00:00.000Z",
        planApprovedBy: { id: ADMIN_ID, email: "ada@example.com" },
        planApprovalStale: false,
      },
    });
    renderDetail();

    expect(await screen.findByText(/plan approved by ada@example\.com/i)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Revoke approval" }));

    await waitFor(() => expect(state.revokeApprovalCalls).toBe(1));
    await waitFor(() =>
      expect(screen.queryByText(/plan approved by ada@example\.com/i)).not.toBeInTheDocument(),
    );
    expect(
      await screen.findByRole("button", { name: "Approve plan in advance" }),
    ).toBeInTheDocument();
  });

  it("pre-approvazione SCADUTA (piano cambiato dopo l'approvazione): frase dedicata, non 'approvato da'", async () => {
    mockDetailApi({
      ticket: {
        ...ticketFixture,
        implementationPlan: "1. Piano nuovo, diverso da quello approvato.",
        planApprovedAt: "2026-06-09T12:00:00.000Z",
        planApprovedBy: { id: ADMIN_ID, email: "ada@example.com" },
        planApprovalStale: true,
      },
    });
    renderDetail();

    expect(
      await screen.findByText(/plan changed after approval: it needs a new go-ahead/i),
    ).toBeInTheDocument();
    expect(screen.queryByText(/ready to start/i)).not.toBeInTheDocument();
    // Scaduta ⇒ come "mai approvata" agli occhi del bottone: si può riapprovare.
    expect(screen.getByRole("button", { name: "Approve plan in advance" })).toBeInTheDocument();
  });

  it("pre-approvazione: nessuna riga di stato se il piano non è mai stato approvato", async () => {
    mockDetailApi({
      ticket: { ...ticketFixture, implementationPlan: "1. Fai questo." },
    });
    renderDetail();

    await screen.findByRole("heading", { name: "TypeError al checkout" });
    expect(screen.queryByText(/ready to start/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/needs a new go-ahead/i)).not.toBeInTheDocument();
  });

  it("pre-approvazione: un operatore non vede i bottoni (il server risponderebbe 403)", async () => {
    mockDetailApi({
      ticket: { ...ticketFixture, implementationPlan: "1. Fai questo." },
      role: "member",
    });
    renderDetail();

    await screen.findByRole("heading", { name: "TypeError al checkout" });
    expect(
      screen.queryByRole("button", { name: "Approve plan in advance" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Revoke approval" })).not.toBeInTheDocument();
  });

  it("pre-approvazione: nessun bottone su un ticket chiuso", async () => {
    mockDetailApi({
      ticket: { ...ticketFixture, status: "closed", implementationPlan: "1. Fai questo." },
    });
    renderDetail();

    await screen.findByRole("heading", { name: "TypeError al checkout" });
    expect(
      screen.queryByRole("button", { name: "Approve plan in advance" }),
    ).not.toBeInTheDocument();
  });

  it("ticket REVIEW: niente «Start AI fix» (la review di una PR esterna si legge, non si lavora)", async () => {
    mockDetailApi({ ticket: { ...ticketFixture, type: "review" }, jobs: [] });
    renderDetail();
    await screen.findByRole("heading", { name: "TypeError al checkout" });
    expect(screen.queryByRole("button", { name: "Start AI fix" })).not.toBeInTheDocument();
  });

  it("ticket REVIEW con un job di correzione FALLITO (PR adottata): niente rilancio, che avvierebbe un fix", async () => {
    mockDetailApi({ ticket: { ...ticketFixture, type: "review" }, jobs: [failedJobFixture] });
    renderDetail();
    await screen.findByRole("heading", { name: "TypeError al checkout" });
    expect(
      screen.queryByRole("button", { name: "Relaunch with instructions" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Start AI fix" })).not.toBeInTheDocument();
  });

  it("stesso job FALLITO su un ticket NON review: il rilancio c'è (verso opposto)", async () => {
    mockDetailApi({ ticket: { ...ticketFixture, type: "bug" }, jobs: [failedJobFixture] });
    renderDetail();
    expect(
      await screen.findByRole("button", { name: "Relaunch with instructions" }),
    ).toBeInTheDocument();
  });

  it("ticket REVIEW con prAdoption e canManage: la sezione «Corrections by Stubwise» col bottone", async () => {
    mockDetailApi({
      ticket: {
        ...ticketFixture,
        type: "review",
        prAdoption: {
          repositoryId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
          prNumber: 7,
          prUrl: "https://github.com/acme/repo/pull/7",
          state: "available",
          canManage: true,
        },
      },
      jobs: [],
    });
    renderDetail();
    expect(await screen.findByRole("button", { name: "Let Stubwise fix it" })).toBeInTheDocument();
  });

  it("ticket NON review senza job: «Start AI fix» c'è (il verso opposto del test sopra)", async () => {
    mockDetailApi({ ticket: { ...ticketFixture, type: "bug" }, jobs: [] });
    renderDetail();
    expect(await screen.findByRole("button", { name: "Start AI fix" })).toBeInTheDocument();
  });

  it("operatore: con un piano pre-approvato l'avviso dice che il run partirà davvero", async () => {
    mockDetailApi({
      jobs: [heldJobFixture],
      role: "member",
      ticket: {
        ...ticketFixture,
        implementationPlan: "1. Fai questo.",
        planApprovedAt: "2026-06-09T12:00:00.000Z",
        planApprovedBy: { id: ADMIN_ID, email: "ada@example.com" },
        planApprovalStale: false,
      },
    });
    renderDetail();

    await screen.findByRole("button", { name: "Start AI fix" });
    expect(
      screen.getByText(/the plan is already approved: the run will actually start/i),
    ).toBeInTheDocument();
    expect(screen.queryByText(/the run will stop on the plan/i)).not.toBeInTheDocument();
  });

  it("sezione Repository/PR: elenca repo, stato PR e link alla PR (fix eseguito)", async () => {
    mockDetailApi({
      ticket: { ...ticketFixture, repositories: ticketRepositoriesFixture },
    });
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
    // Server senza il ciclo di correzione: la sezione resta intera, e nessun
    // bottone compare (il web difende `cycle` con `?? null`, non si fida del
    // `.default` dello schema che qui non gira).
    expect(
      within(section).queryByRole("button", { name: "Request changes" }),
    ).not.toBeInTheDocument();
  });

  it("sezione Repository/PR: sotto una PR di Stubwise, la riga del ciclo e il bottone", async () => {
    const [openPr, mergedPr] = ticketRepositoriesFixture;
    mockDetailApi({
      ticket: {
        ...ticketFixture,
        repositories: [
          {
            ...openPr!,
            cycle: {
              state: "stopped_at_cap",
              round: 3,
              maxRounds: 3,
              pendingRequest: false,
              lastRequest: null,
              canRequestCorrection: true,
            },
          },
          { ...mergedPr!, cycle: null },
        ],
      },
    });
    renderDetail();

    const section = await screen.findByRole("region", { name: "Repository / PR" });
    expect(
      within(section).getByText("Cycle stopped after 3 automatic corrections"),
    ).toBeInTheDocument();
    // Un bottone solo: la PR mergiata ha `cycle: null`.
    expect(within(section).getAllByRole("button", { name: "Request changes" })).toHaveLength(1);
  });

  it("sezione Repository/PR: cambiando ticket senza smontare la pagina, il modulo della riga riparte chiuso e vuoto", async () => {
    // Stesso repository su due ticket: la `<li>` ha la stessa key
    // (`repositoryId`) e TanStack Router non rismonta la pagina sulla stessa
    // rotta. Solo la key ticket+repository della riga la fa ripartire.
    const OTHER_TICKET_ID = "66666666-6666-4666-8666-666666666666";
    const [openPr] = ticketRepositoriesFixture;
    const repoWithCycle: TicketRepository = {
      ...openPr!,
      cycle: {
        state: "changes_requested",
        round: 0,
        maxRounds: 3,
        pendingRequest: false,
        lastRequest: null,
        canRequestCorrection: true,
      },
    };
    mockDetailApi({ ticket: { ...ticketFixture, repositories: [repoWithCycle] } });
    // Il ticket B riusa le risposte di A per tutto il resto (commenti, job…):
    // cambia solo il dettaglio, con un titolo suo per sapere quando è a schermo.
    const base = fetchMock.getMockImplementation()!;
    const ticketB: Ticket = {
      ...ticketFixture,
      id: OTHER_TICKET_ID,
      number: 8,
      title: "Secondo ticket",
      repositories: [repoWithCycle],
    };
    fetchMock.mockImplementation((input, init) => {
      const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const url = new URL(raw, "http://test.local");
      if ((init?.method ?? "GET") === "GET" && url.pathname === `/api/tickets/${OTHER_TICKET_ID}`) {
        return Promise.resolve(jsonResponse(200, ticketB));
      }
      return base(url.href.replace(OTHER_TICKET_ID, TICKET_ID), init);
    });
    const { router } = renderDetail();

    const user = userEvent.setup();
    await screen.findByRole("heading", { name: /TypeError al checkout/ });
    await user.click(screen.getByRole("button", { name: "Request changes" }));
    await user.type(screen.getByLabelText("Note for the agent (optional)"), "nota del ticket A");
    // Un nodo della pagina FUORI dalla riga: se dopo il cambio è lo stesso, la
    // pagina non si è rismontata — è proprio il caso che la key deve coprire.
    const sectionOnA = screen.getByRole("region", { name: "Repository / PR" });

    await router.navigate({ to: "/tickets/$id", params: { id: OTHER_TICKET_ID } });
    await screen.findByRole("heading", { name: /Secondo ticket/ });

    expect(screen.getByRole("region", { name: "Repository / PR" })).toBe(sectionOnA);
    // Su B il modulo è chiuso, e riaprendolo la nota di A non c'è.
    expect(screen.queryByLabelText("Note for the agent (optional)")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Request changes" }));
    expect(screen.getByLabelText("Note for the agent (optional)")).toHaveValue("");
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
    expect(within(panel).getByText("Waiting to start")).toBeInTheDocument();

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

  describe("job 'held' che è una CORREZIONE ferma (G5)", () => {
    /** Ciclo con una correzione ferma; `heldJobId` lo decide il chiamante. */
    function heldCorrectionRepo(heldJobId: string): TicketRepository {
      const [openPr] = ticketRepositoriesFixture;
      return {
        ...openPr!,
        cycle: {
          state: "correcting",
          round: 1,
          maxRounds: 3,
          pendingRequest: false,
          lastRequest: null,
          canRequestCorrection: false,
          heldReason: "limit",
          canResume: true,
          heldJobId,
        },
      };
    }

    it("l'ultimo job è la correzione ferma: niente rilancio generico, solo «Riprendi»", async () => {
      const state = mockDetailApi({
        jobs: [heldJobFixture],
        role: "member",
        ticket: { ...ticketFixture, repositories: [heldCorrectionRepo(heldJobFixture.id)] },
      });
      renderDetail();

      const section = await screen.findByRole("region", { name: "Repository / PR" });
      expect(
        within(section).getByRole("button", { name: "Resume correction" }),
      ).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Start AI fix" })).not.toBeInTheDocument();
      expect(
        screen.queryByRole("button", { name: "Relaunch with instructions" }),
      ).not.toBeInTheDocument();
      // Nemmeno l'avviso da operatore sul run generico: quel run non c'è.
      expect(
        screen.queryByText("The run will stop on the plan: a maintainer has to approve it."),
      ).not.toBeInTheDocument();
      expect(state.runAiCalls).toEqual([]);
    });

    it("heldJobId di un altro job: il rilancio generico resta, come prima", async () => {
      mockDetailApi({
        jobs: [heldJobFixture],
        ticket: {
          ...ticketFixture,
          repositories: [heldCorrectionRepo("eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee")],
        },
      });
      renderDetail();

      expect(await screen.findByRole("button", { name: "Start AI fix" })).toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: "Relaunch with instructions" }),
      ).toBeInTheDocument();
    });

    it("nessun ciclo sul repository: il rilancio generico resta", async () => {
      const [openPr] = ticketRepositoriesFixture;
      mockDetailApi({
        jobs: [heldJobFixture],
        ticket: { ...ticketFixture, repositories: [{ ...openPr!, cycle: null }] },
      });
      renderDetail();

      expect(await screen.findByRole("button", { name: "Start AI fix" })).toBeInTheDocument();
    });

    it("server vecchio (niente `cycle` né `heldJobId`): il rilancio generico resta", async () => {
      // Fixture SENZA i due campi: la regola li legge e deve tacere, non
      // lanciare (un `repo.cycle.heldJobId` senza difesa farebbe saltare la
      // pagina). Due voci: una senza `cycle`, una con un ciclo senza `heldJobId`.
      const [openPr, mergedPr] = ticketRepositoriesFixture;
      const withoutHeldJobId = heldCorrectionRepo(heldJobFixture.id);
      delete withoutHeldJobId.cycle!.heldJobId;
      expect("cycle" in openPr!).toBe(false);
      expect("heldJobId" in withoutHeldJobId.cycle!).toBe(false);
      mockDetailApi({
        jobs: [heldJobFixture],
        ticket: {
          ...ticketFixture,
          repositories: [openPr!, { ...withoutHeldJobId, repositoryId: mergedPr!.repositoryId }],
        },
      });
      renderDetail();

      expect(await screen.findByRole("button", { name: "Start AI fix" })).toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: "Relaunch with instructions" }),
      ).toBeInTheDocument();
    });
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

  it("job 'awaiting_plan_approval': Rifiuta apre il campo istruzioni e le manda nel body", async () => {
    const state = mockDetailApi({ jobs: [awaitingPlanJobFixture] });
    renderDetail();

    // Il primo click NON rifiuta: apre il campo (le istruzioni diventeranno un
    // commento del team che il re-plan rilegge).
    const reject = await screen.findByRole("button", { name: "Reject" });
    await userEvent.click(reject);
    expect(state.rejectCalls).toBe(0);

    const box = screen.getByLabelText(/instructions for the new plan/i);
    await userEvent.type(box, "Usa la coda esistente");
    await userEvent.click(screen.getByRole("button", { name: "Reject plan" }));

    await waitFor(() => expect(state.rejectCalls).toBe(1));
    expect(state.rejectBodies).toEqual([{ instructions: "Usa la coda esistente" }]);
    // A rifiuto avvenuto il campo si richiude.
    await waitFor(() =>
      expect(screen.queryByLabelText(/instructions for the new plan/i)).not.toBeInTheDocument(),
    );
  });

  it("job 'awaiting_plan_approval': Rifiuta senza istruzioni manda un body vuoto", async () => {
    const state = mockDetailApi({ jobs: [awaitingPlanJobFixture] });
    renderDetail();

    await userEvent.click(await screen.findByRole("button", { name: "Reject" }));
    await userEvent.click(screen.getByRole("button", { name: "Reject plan" }));

    await waitFor(() => expect(state.rejectCalls).toBe(1));
    // Campo vuoto = nessuna istruzione: la POST parte senza corpo.
    expect(state.rejectBodies).toEqual([undefined]);
  });

  it("job 'awaiting_plan_approval': Annulla chiude il campo senza rifiutare", async () => {
    const state = mockDetailApi({ jobs: [awaitingPlanJobFixture] });
    renderDetail();

    await userEvent.click(await screen.findByRole("button", { name: "Reject" }));
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(screen.queryByLabelText(/instructions for the new plan/i)).not.toBeInTheDocument();
    expect(state.rejectCalls).toBe(0);
  });

  it("operatore: niente Approva/Rifiuta sul piano, solo l'avviso di attesa", async () => {
    mockDetailApi({ jobs: [awaitingPlanJobFixture], role: "member" });
    renderDetail();

    expect(
      await screen.findByText(/waiting for a maintainer to approve the plan/i),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Approve" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Reject" })).not.toBeInTheDocument();
  });

  it("maintainer: sul piano in attesa NON compare l'avviso da operatore", async () => {
    mockDetailApi({ jobs: [awaitingPlanJobFixture] });
    renderDetail();

    await screen.findByRole("button", { name: "Approve" });
    expect(
      screen.queryByText(/waiting for a maintainer to approve the plan/i),
    ).not.toBeInTheDocument();
  });

  it("operatore: 'Avvia fix AI' avvisa che il run si fermerà sul piano", async () => {
    mockDetailApi({ jobs: [heldJobFixture], role: "member" });
    renderDetail();

    await screen.findByRole("button", { name: "Start AI fix" });
    expect(screen.getByText(/the run will stop on the plan/i)).toBeInTheDocument();
  });

  it("operatore: dopo il run, il 202 'awaiting_plan_approval' lo dice subito", async () => {
    mockDetailApi({
      jobs: [heldJobFixture],
      role: "member",
      // Un run chiesto da un operatore su un ticket con piano nasce già fermo
      // sul gate: il 202 lo distingue da un run in coda.
      runAiResponse: () => jsonResponse(202, { jobId: "j3", status: "awaiting_plan_approval" }),
    });
    renderDetail();

    await userEvent.click(await screen.findByRole("button", { name: "Start AI fix" }));

    expect(
      await screen.findByText(/the plan is now waiting for a maintainer/i),
    ).toBeInTheDocument();
  });

  it("run-ai 409 job_in_flight: messaggio localizzato dal code, non dal message del server", async () => {
    mockDetailApi({
      jobs: [heldJobFixture],
      runAiResponse: () =>
        jsonResponse(409, { code: "job_in_flight", message: "A job is already in flight" }),
    });
    renderDetail();

    await userEvent.click(await screen.findByRole("button", { name: "Start AI fix" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("A job is already running on this ticket");
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

  describe("modificare ed eliminare un commento (0084, C1)", () => {
    const mine: Comment = {
      id: "c1",
      ticketId: TICKET_ID,
      authorType: "user",
      authorId: ADMIN_ID,
      body: "Riprodotto anche su staging.",
      createdAt: "2026-06-02T09:00:00.000Z",
      canEdit: true,
      canDelete: true,
    };

    it("fixture SENZA i campi nuovi (server vecchio): nessun «Edit»/«Delete», nessun crash", async () => {
      // `commentsFixture` NON ha canEdit/canDelete/deletedAt/…, APPOSTA: il
      // web fa un cast, e il `?? false`/`?? null` nel punto di lettura è ciò
      // che regge. Non «completarla».
      mockDetailApi();
      renderDetail();
      const feed = await screen.findByRole("region", { name: "Activity" });
      expect(await within(feed).findByText("Riprodotto anche su staging.")).toBeInTheDocument();
      expect(within(feed).queryByRole("button", { name: /^Edit / })).not.toBeInTheDocument();
      expect(within(feed).queryByRole("button", { name: /^Delete / })).not.toBeInTheDocument();
      expect(within(feed).queryByText(/Comment deleted/)).not.toBeInTheDocument();
    });

    it("«Edit» apre l'editor col testo; «Save» manda PATCH { body }", async () => {
      const state = mockDetailApi({ comments: [mine, commentsFixture[1]!] });
      renderDetail();
      const user = userEvent.setup();
      const feed = await screen.findByRole("region", { name: "Activity" });
      await user.click(
        await within(feed).findByRole("button", { name: "Edit the comment by ada@example.com" }),
      );
      const editor = within(feed).getByLabelText("Edit the comment");
      expect(editor).toHaveValue("Riprodotto anche su staging.");
      // Il fuoco va sull'editor: si scrive subito.
      await waitFor(() => expect(editor).toHaveFocus());
      // Mentre si modifica, «Reply» su QUEL commento non c'è.
      expect(
        within(feed).queryByRole("button", { name: "Reply to ada@example.com" }),
      ).not.toBeInTheDocument();
      await user.clear(editor);
      await user.type(editor, "Riprodotto anche in produzione.");
      await user.click(within(feed).getByRole("button", { name: "Save" }));
      await waitFor(() =>
        expect(state.commentPatches).toEqual([
          { id: "c1", body: { body: "Riprodotto anche in produzione." } },
        ]),
      );
      await waitFor(() =>
        expect(within(feed).queryByLabelText("Edit the comment")).not.toBeInTheDocument(),
      );
      // Chiuso l'editor, il fuoco torna al bottone da cui si era partiti.
      await waitFor(() =>
        expect(
          within(feed).getByRole("button", { name: "Edit the comment by ada@example.com" }),
        ).toHaveFocus(),
      );
    });

    it("«Cancel» chiude l'editor senza chiamare il server", async () => {
      const state = mockDetailApi({ comments: [mine] });
      renderDetail();
      const user = userEvent.setup();
      const feed = await screen.findByRole("region", { name: "Activity" });
      await user.click(
        await within(feed).findByRole("button", { name: "Edit the comment by ada@example.com" }),
      );
      await user.click(within(feed).getByRole("button", { name: "Cancel editing" }));
      expect(within(feed).queryByLabelText("Edit the comment")).not.toBeInTheDocument();
      await waitFor(() =>
        expect(
          within(feed).getByRole("button", { name: "Edit the comment by ada@example.com" }),
        ).toHaveFocus(),
      );
      expect(state.commentPatches).toEqual([]);
    });

    it("409 comment_deleted alla modifica: il feed riletto mostra il segnaposto, e l'errore si vede", async () => {
      // Il 409 è VERO solo se nel frattempo qualcuno l'ha eliminato: il mock
      // lo elimina anche nello stato, come farebbe il server.
      const state = mockDetailApi({
        comments: [mine],
        commentEditResponse: () => {
          state.comments = state.comments.map((c) =>
            c.id === "c1"
              ? {
                  ...c,
                  body: "",
                  deletedAt: "2026-06-09T12:00:00.000Z",
                  deletedBy: { name: "bob@example.com" },
                  canEdit: false,
                  canDelete: false,
                }
              : c,
          );
          return jsonResponse(409, {
            code: "comment_deleted",
            message: "Comment has been deleted",
          });
        },
      });
      renderDetail();
      const user = userEvent.setup();
      const feed = await screen.findByRole("region", { name: "Activity" });
      await user.click(
        await within(feed).findByRole("button", { name: "Edit the comment by ada@example.com" }),
      );
      await user.type(within(feed).getByLabelText("Edit the comment"), " altro");
      await user.click(within(feed).getByRole("button", { name: "Save" }));
      await waitFor(() => {
        const placeholder = within(feed).getByText("Comment deleted · by bob@example.com");
        expect(
          within(placeholder.closest("li")!).getByText("Comment has been deleted"),
        ).toBeInTheDocument();
      });
      expect(within(feed).queryByLabelText("Edit the comment")).not.toBeInTheDocument();
    });

    it("«Delete» chiede conferma; confermato manda DELETE; senza registro decisioni nessun avviso", async () => {
      const state = mockDetailApi({ comments: [mine] });
      renderDetail();
      const user = userEvent.setup();
      const feed = await screen.findByRole("region", { name: "Activity" });
      await user.click(
        await within(feed).findByRole("button", { name: "Delete the comment by ada@example.com" }),
      );
      expect(state.commentDeletes).toEqual([]);
      expect(within(feed).queryByText(/decision log/)).not.toBeInTheDocument();
      await user.click(within(feed).getByRole("button", { name: "Confirm deleting the comment" }));
      await waitFor(() => expect(state.commentDeletes).toEqual(["c1"]));
      expect(
        await within(feed).findByText("Comment deleted · by ada@example.com"),
      ).toBeInTheDocument();
    });

    it("L1: le istruzioni di un rifiuto del piano — la conferma dice che il testo resta nel registro decisioni", async () => {
      mockDetailApi({ comments: [{ ...mine, inDecisionLog: true }] });
      renderDetail();
      const user = userEvent.setup();
      const feed = await screen.findByRole("region", { name: "Activity" });
      await user.click(
        await within(feed).findByRole("button", { name: "Delete the comment by ada@example.com" }),
      );
      expect(
        within(feed).getByText(
          "This text was the instruction of a rejected plan: it stays in the decision log, which is never rewritten.",
        ),
      ).toBeInTheDocument();
    });

    it("un eliminato: segnaposto con chi, niente testo né «Reply»; le risposte dicono «un commento eliminato»", async () => {
      mockDetailApi({
        comments: [
          {
            ...mine,
            body: "",
            deletedAt: "2026-06-03T09:00:00.000Z",
            deletedBy: { name: null },
            canEdit: false,
            canDelete: false,
          },
          {
            id: "c3",
            ticketId: TICKET_ID,
            authorType: "user",
            authorId: MEMBER_ID,
            body: "Ci penso io.",
            createdAt: "2026-06-04T09:00:00.000Z",
            replyTo: {
              id: "c1",
              authorType: "user",
              authorName: "ada@example.com",
              excerpt: "",
              deleted: true,
            },
          },
        ],
      });
      renderDetail();
      const feed = await screen.findByRole("region", { name: "Activity" });
      const placeholder = await within(feed).findByText("Comment deleted · by Removed user");
      const row = placeholder.closest("li")!;
      expect(within(row).queryByRole("button", { name: /Reply to/ })).not.toBeInTheDocument();
      expect(
        within(feed).getByRole("link", { name: "In reply to a deleted comment" }),
      ).toHaveAttribute("href", "#comment-c1");
    });

    it("segnaposto con una riga «sporca» (corpo residuo, permessi veri): niente corpo, niente Edit/Delete", async () => {
      // Il CHECK della 0084 impedisce un corpo su un eliminato; qui si prova
      // che il web non si appoggia a quella garanzia per decidere cosa mostrare.
      mockDetailApi({
        comments: [
          {
            ...mine,
            body: "TESTO-RESIDUO",
            deletedAt: "2026-06-03T09:00:00.000Z",
            deletedBy: { name: "ada@example.com" },
            canEdit: true,
            canDelete: true,
          },
        ],
      });
      renderDetail();
      const feed = await screen.findByRole("region", { name: "Activity" });
      await within(feed).findByText("Comment deleted · by ada@example.com");
      expect(within(feed).queryByText("TESTO-RESIDUO")).not.toBeInTheDocument();
      expect(
        within(feed).queryByRole("button", { name: /^Edit the comment/ }),
      ).not.toBeInTheDocument();
      expect(
        within(feed).queryByRole("button", { name: /^Delete the comment/ }),
      ).not.toBeInTheDocument();
    });

    it("un modificato: «edited» accanto alla data, con l'ora della modifica nel title", async () => {
      mockDetailApi({ comments: [{ ...mine, editedAt: "2026-06-05T09:00:00.000Z" }] });
      renderDetail();
      const feed = await screen.findByRole("region", { name: "Activity" });
      const edited = await within(feed).findByText("edited");
      expect(edited).toHaveAttribute("title");
      expect(edited.getAttribute("title")).not.toBe("");
      // Lo screen reader non legge il title: l'ora della modifica è anche testo.
      expect(within(feed).getByText(/^, edited on /)).toHaveClass("sr-only");
    });

    it("«Relaunch with instructions»: un commento di una persona ELIMINATO non conta, l'hint torna", async () => {
      mockDetailApi({
        jobs: [heldJobFixture],
        comments: [
          { ...mine, body: "", deletedAt: "2026-06-03T09:00:00.000Z", deletedBy: { name: null } },
          commentsFixture[1]!,
        ],
      });
      renderDetail();
      await screen.findByRole("button", { name: "Relaunch with instructions" });
      expect(
        await screen.findByText("Add a comment with the instructions first."),
      ).toBeInTheDocument();
    });
  });

  describe("rispondere a un commento (C1)", () => {
    it("fixture SENZA replyTo (server vecchio): i commenti si vedono, nessuna riga «In reply to»", async () => {
      // `commentsFixture` NON ha `replyTo`, apposta: il web fa un cast, e
      // questo è il caso che il `?? null` nel punto di lettura deve reggere.
      mockDetailApi();
      renderDetail();
      const feed = await screen.findByRole("region", { name: "Activity" });
      expect(await within(feed).findByText("Riprodotto anche su staging.")).toBeInTheDocument();
      expect(within(feed).queryByText(/In reply to/)).not.toBeInTheDocument();
    });

    it("una risposta mostra «In reply to …» con il link all'originale", async () => {
      mockDetailApi({
        comments: [
          ...commentsFixture,
          {
            id: "c3",
            ticketId: TICKET_ID,
            authorType: "user",
            authorId: ADMIN_ID,
            body: "Confermo.",
            createdAt: "2026-06-02T10:00:00.000Z",
            replyTo: {
              id: "c1",
              authorType: "user",
              authorName: "ada@example.com",
              excerpt: "Riprodotto anche su staging.",
            },
          },
          {
            id: "c4",
            ticketId: TICKET_ID,
            authorType: "user",
            authorId: ADMIN_ID,
            body: "Anche io.",
            createdAt: "2026-06-02T11:00:00.000Z",
            replyTo: { id: "gone", authorType: "ai", authorName: null, excerpt: "Fix pronto" },
          },
        ],
      });
      renderDetail();
      const feed = await screen.findByRole("region", { name: "Activity" });
      const link = await within(feed).findByRole("link", {
        name: "In reply to ada@example.com: “Riprodotto anche su staging.”",
      });
      expect(link).toHaveAttribute("href", "#comment-c1");
      expect(feed.querySelector("#comment-c1")).not.toBeNull();
      // Originale non più nel feed: la riga resta, come testo.
      expect(within(feed).getByText("In reply to Stubwise: “Fix pronto”").tagName).not.toBe("A");
    });

    it("«Reply» apre il campo SOTTO il commento, col fuoco; nessun banner, nessun salto; invio con replyToCommentId", async () => {
      const state = mockDetailApi();
      const scrolled = vi.fn();
      const original = Element.prototype.scrollIntoView;
      Element.prototype.scrollIntoView = scrolled;
      try {
        renderDetail();
        const user = userEvent.setup();
        const feed = await screen.findByRole("region", { name: "Activity" });
        await within(feed).findByText("Riprodotto anche su staging.");

        await user.click(within(feed).getByRole("button", { name: "Reply to ada@example.com" }));
        const row = feed.querySelector("#comment-c1") as HTMLElement;
        const input = within(row).getByLabelText("Your reply to ada@example.com");
        // Il campo è DENTRO il commento, ha il fuoco, e sostituisce i bottoni.
        await waitFor(() => expect(input).toHaveFocus());
        expect(
          within(row).queryByRole("button", { name: "Reply to ada@example.com" }),
        ).not.toBeInTheDocument();
        expect(screen.queryByText(/Replying to/)).not.toBeInTheDocument();
        expect(screen.getByLabelText("Add a comment")).not.toHaveFocus();
        expect(scrolled).not.toHaveBeenCalled();

        await user.type(input, "Confermo");
        await user.click(within(row).getByRole("button", { name: "Reply" }));
        await waitFor(() =>
          expect(state.postedPayloads).toEqual([{ body: "Confermo", replyToCommentId: "c1" }]),
        );
        // Invio riuscito: il campo si chiude, i bottoni tornano.
        await waitFor(() =>
          expect(
            within(feed).queryByLabelText("Your reply to ada@example.com"),
          ).not.toBeInTheDocument(),
        );
        // (Il mock aggiunge la risposta, anch'essa di ada: si guarda la riga di c1.)
        expect(
          within(row).getByRole("button", { name: "Reply to ada@example.com" }),
        ).toBeInTheDocument();

        // «Cancel» chiude senza inviare; il campo in cima manda solo { body }.
        await user.click(within(feed).getByRole("button", { name: "Reply to Stubwise" }));
        await user.type(within(feed).getByLabelText("Your reply to Stubwise"), "bozza");
        await user.click(within(feed).getByRole("button", { name: "Cancel the reply" }));
        expect(within(feed).queryByLabelText("Your reply to Stubwise")).not.toBeInTheDocument();
        expect(state.postedPayloads).toHaveLength(1);
        await user.type(screen.getByLabelText("Add a comment"), "Senza risposta");
        await user.click(screen.getByRole("button", { name: "Comment" }));
        await waitFor(() => expect(state.postedPayloads).toHaveLength(2));
        expect(state.postedPayloads[1]).toEqual({ body: "Senza risposta" });
        expect(Object.keys(state.postedPayloads[1] as object)).toEqual(["body"]);
      } finally {
        Element.prototype.scrollIntoView = original;
      }
    });

    it("422 reply_target_invalid: errore sotto il campo della risposta, che resta aperto con la bozza", async () => {
      mockDetailApi({
        commentResponse: () =>
          jsonResponse(422, {
            code: "reply_target_invalid",
            message: "Reply target is not a comment of this ticket",
          }),
      });
      renderDetail();
      const user = userEvent.setup();
      const feed = await screen.findByRole("region", { name: "Activity" });
      await within(feed).findByText("Riprodotto anche su staging.");
      await user.click(within(feed).getByRole("button", { name: "Reply to ada@example.com" }));
      const row = feed.querySelector("#comment-c1") as HTMLElement;
      await user.type(within(row).getByLabelText("Your reply to ada@example.com"), "Confermo");
      await user.click(within(row).getByRole("button", { name: "Reply" }));

      expect(
        await within(row).findByText(/Reply target is not a comment of this ticket/),
      ).toBeInTheDocument();
      expect(within(row).getByLabelText("Your reply to ada@example.com")).toHaveValue("Confermo");
    });

    it("risposta e modifica si escludono: aprirne una chiude l'altra", async () => {
      mockDetailApi({
        comments: [{ ...commentsFixture[0]!, canEdit: true, canDelete: true }, commentsFixture[1]!],
      });
      renderDetail();
      const user = userEvent.setup();
      const feed = await screen.findByRole("region", { name: "Activity" });
      await user.click(
        await within(feed).findByRole("button", { name: "Edit the comment by ada@example.com" }),
      );
      expect(within(feed).getByLabelText("Edit the comment")).toBeInTheDocument();

      await user.click(within(feed).getByRole("button", { name: "Reply to Stubwise" }));
      expect(within(feed).queryByLabelText("Edit the comment")).not.toBeInTheDocument();
      await waitFor(() =>
        expect(within(feed).getByLabelText("Your reply to Stubwise")).toHaveFocus(),
      );

      await user.click(
        within(feed).getByRole("button", { name: "Edit the comment by ada@example.com" }),
      );
      expect(within(feed).queryByLabelText("Your reply to Stubwise")).not.toBeInTheDocument();
      expect(within(feed).getByLabelText("Edit the comment")).toBeInTheDocument();
    });

    it("card delle risposte sotto l'originale, dalla più recente; cliccata scorre alla risposta", async () => {
      mockDetailApi({
        comments: [
          ...commentsFixture,
          {
            id: "c3",
            ticketId: TICKET_ID,
            authorType: "user",
            authorId: ADMIN_ID,
            body: "Confermo, lo vedo anche io.",
            createdAt: "2026-06-02T10:00:00.000Z",
            replyTo: {
              id: "c1",
              authorType: "user",
              authorName: "ada@example.com",
              excerpt: "Riprodotto anche su staging.",
            },
          },
          {
            id: "c4",
            ticketId: TICKET_ID,
            authorType: "user",
            authorId: MEMBER_ID,
            body: "Ci guardo **io**.",
            createdAt: "2026-06-02T11:00:00.000Z",
            replyTo: {
              id: "c1",
              authorType: "user",
              authorName: "ada@example.com",
              excerpt: "Riprodotto anche su staging.",
            },
          },
        ],
      });
      const scrolled = vi.fn(function (this: Element) {
        return this.id;
      });
      const original = Element.prototype.scrollIntoView;
      Element.prototype.scrollIntoView = scrolled;
      try {
        renderDetail();
        const user = userEvent.setup();
        const feed = await screen.findByRole("region", { name: "Activity" });
        await within(feed).findByText("Riprodotto anche su staging.");
        const row = feed.querySelector("#comment-c1") as HTMLElement;
        // Chi guarda è ada (ADMIN_ID): la sua è «Your reply», l'altra porta il nome.
        const mine = within(row).getByRole("button", { name: /^↳ Your reply · / });
        const bobs = within(row).getByRole("button", { name: /^↳ Reply from bob@example\.com · / });
        expect(within(bobs).getByText("Ci guardo io.")).toBeInTheDocument();
        expect(within(mine).getByText("Confermo, lo vedo anche io.")).toBeInTheDocument();
        // Dalla più recente: c4 (11:00) prima di c3 (10:00).
        expect(precedes(bobs, mine)).toBe(true);
        // Il commento senza risposte non ha card.
        const aiRow = feed.querySelector("#comment-c2") as HTMLElement;
        expect(within(aiRow).queryByRole("button", { name: /^↳/ })).not.toBeInTheDocument();

        await user.click(mine);
        expect(scrolled).toHaveBeenCalledTimes(1);
        expect(scrolled.mock.contexts[0]).toBe(feed.querySelector("#comment-c3"));
      } finally {
        Element.prototype.scrollIntoView = original;
      }
    });

    it("le card delle risposte restano sotto il segnaposto di un commento eliminato", async () => {
      mockDetailApi({
        comments: [
          {
            ...commentsFixture[0]!,
            body: "",
            deletedAt: "2026-06-03T09:00:00.000Z",
            deletedBy: { name: "ada@example.com" },
          },
          {
            id: "c3",
            ticketId: TICKET_ID,
            authorType: "user",
            authorId: MEMBER_ID,
            body: "Ci penso io.",
            createdAt: "2026-06-04T09:00:00.000Z",
            replyTo: {
              id: "c1",
              authorType: "user",
              authorName: "ada@example.com",
              excerpt: "",
              deleted: true,
            },
          },
        ],
      });
      renderDetail();
      const feed = await screen.findByRole("region", { name: "Activity" });
      const placeholder = await within(feed).findByText("Comment deleted · by ada@example.com");
      const row = placeholder.closest("li")!;
      expect(
        within(row).getByRole("button", { name: /^↳ Reply from bob@example\.com · / }),
      ).toBeInTheDocument();
    });
  });

  describe("feed dal più recente, azioni con icone (allineamento all'app)", () => {
    it("il campo per un commento nuovo sta IN CIMA, e il feed va dal più recente", async () => {
      mockDetailApi();
      renderDetail();
      const feed = await screen.findByRole("region", { name: "Activity" });
      await within(feed).findByText("Riprodotto anche su staging.");
      const composer = screen.getByLabelText("Add a comment");
      const list = within(feed).getByRole("list");
      expect(precedes(composer, list)).toBe(true);
      const c1 = feed.querySelector("#comment-c1")!;
      const c2 = feed.querySelector("#comment-c2")!;
      // c2 (09:05) prima di c1 (09:00).
      expect(precedes(c2, c1)).toBe(true);
      // Il primo elemento del feed è il più recente di tutti: il job del 3 giugno.
      const first = list.querySelector("li")!;
      expect(first.querySelector("time")).toHaveAttribute("dateTime", "2026-06-03T10:00:00.000Z");
    });

    it("Reply, Edit e Delete a destra, con le icone dell'app e i colori del tono", async () => {
      mockDetailApi({ comments: [{ ...commentsFixture[0]!, canEdit: true, canDelete: true }] });
      renderDetail();
      const feed = await screen.findByRole("region", { name: "Activity" });
      const reply = await within(feed).findByRole("button", { name: "Reply to ada@example.com" });
      const edit = within(feed).getByRole("button", {
        name: "Edit the comment by ada@example.com",
      });
      const del = within(feed).getByRole("button", {
        name: "Delete the comment by ada@example.com",
      });
      expect(reply.parentElement).toBe(edit.parentElement);
      expect(reply.parentElement).toBe(del.parentElement);
      expect(reply.parentElement).toHaveClass("justify-end");
      expect(reply).toHaveTextContent("Reply");
      expect(edit).toHaveTextContent("Edit");
      expect(del).toHaveTextContent("Delete");
      expect(reply.querySelector('svg[data-icon="reply"]')).not.toBeNull();
      expect(edit.querySelector('svg[data-icon="edit"]')).not.toBeNull();
      expect(del.querySelector('svg[data-icon="delete"]')).not.toBeNull();
      expect(reply.querySelector("svg")).toHaveAttribute("viewBox", "0 -960 960 960");
      expect(reply.querySelector("path")!.getAttribute("d")).toMatch(/^M760-200v-160/);
      expect(reply).toHaveClass("text-signal");
      expect(edit).toHaveClass("text-fg-muted");
      expect(del).toHaveClass("text-danger");
    });

    it("senza canEdit/canDelete (campi assenti): solo Reply, con la sua icona", async () => {
      // `commentsFixture` NON ha canEdit/canDelete, apposta (`?? false`).
      mockDetailApi();
      renderDetail();
      const feed = await screen.findByRole("region", { name: "Activity" });
      const reply = await within(feed).findByRole("button", { name: "Reply to ada@example.com" });
      expect(reply.parentElement!.querySelectorAll("button")).toHaveLength(1);
      expect(reply.querySelector('svg[data-icon="reply"]')).not.toBeNull();
    });
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
    expect(within(panel).getByText("PR open")).toBeInTheDocument();
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
    await waitFor(() => expect(invalidate).toHaveBeenCalledWith({ queryKey: ticketKeys.boards() }));
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

    await userEvent.click(await screen.findByRole("button", { name: /remove label pagamenti/i }));

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
    expect(within(feed).getByText("PR open")).toBeInTheDocument();
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

describe("dettaglio ticket — domanda dell'agente", () => {
  it("il richiedente vede il pannello e risponde dalla pagina", async () => {
    const state = mockDetailApi({
      jobs: [awaitingInputJobFixture],
      role: "member",
      questions: [openQuestionFixture],
    });
    renderDetail();

    const panel = await screen.findByRole("region", { name: "AI activity" });
    expect(within(panel).getByText("Waiting for an answer")).toBeInTheDocument();
    // La domanda si legge per intero: sulla pagina ticket non c'è il testo
    // localizzato della notifica a ripeterla.
    expect(within(panel).getByText("Quale coda uso per i job del grafo?")).toBeInTheDocument();
    expect(within(panel).getByText("Nessuna migrazione")).toBeInTheDocument();

    // Conferma a due passi: selezione, poi invio.
    await userEvent.click(screen.getByRole("radio", { name: /Una coda nuova/ }));
    await userEvent.click(screen.getByRole("button", { name: "Send answer" }));

    // Il body porta la domanda MOSTRATA: il server rifiuta se nel frattempo
    // il job ne ha aperta un'altra.
    await waitFor(() =>
      expect(state.answerBodies).toEqual([
        { optionIndex: 1, questionId: openQuestionFixture.questionId },
      ]),
    );
  });

  it("risposta in testo libero: manda { text } dalla pagina", async () => {
    const state = mockDetailApi({
      jobs: [awaitingInputJobFixture],
      role: "member",
      questions: [openQuestionFixture],
    });
    renderDetail();

    await screen.findByText("Quale coda uso per i job del grafo?");
    await userEvent.click(screen.getByRole("radio", { name: "Other…" }));
    await userEvent.type(screen.getByLabelText("Your answer"), "Fanne una terza");
    await userEvent.click(screen.getByRole("button", { name: "Send answer" }));

    await waitFor(() =>
      expect(state.answerBodies).toEqual([
        { text: "Fanne una terza", questionId: openQuestionFixture.questionId },
      ]),
    );
  });

  it("un altro operatore: solo la riga informativa, nessun pannello", async () => {
    // Il run l'ha chiesto il maintainer: l'operatore che passa di qui NON è
    // quello a cui la domanda è rivolta, e il server gli risponderebbe 403.
    mockDetailApi({
      jobs: [{ ...awaitingInputJobFixture, requestedByUserId: ADMIN_ID }],
      role: "member",
      questions: [openQuestionFixture],
    });
    renderDetail();

    expect(
      await screen.findByText(/waiting for an answer from ada@example.com/i),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Send answer" })).not.toBeInTheDocument();
  });

  it("job automatico (nessun richiedente): l'operatore vede la riga senza nome", async () => {
    mockDetailApi({
      jobs: [{ ...awaitingInputJobFixture, requestedByUserId: null }],
      role: "member",
      questions: [openQuestionFixture],
    });
    renderDetail();

    expect(await screen.findByText(/waiting for a maintainer to answer/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Send answer" })).not.toBeInTheDocument();
  });

  it("il maintainer risponde anche alla domanda di un collega", async () => {
    const state = mockDetailApi({
      jobs: [awaitingInputJobFixture],
      questions: [openQuestionFixture],
    });
    renderDetail();

    await userEvent.click(await screen.findByRole("radio", { name: /Quella esistente/ }));
    await userEvent.click(screen.getByRole("button", { name: "Send answer" }));

    await waitFor(() =>
      expect(state.answerBodies).toEqual([
        { optionIndex: 0, questionId: openQuestionFixture.questionId },
      ]),
    );
    // Nessuna riga informativa: chi può rispondere ha il pannello, non
    // l'avviso (`awaitingAnswerFrom`/`awaitingAnswerUnknown`). Non basta
    // cercare "waiting for an answer": dalla fase 7 quella stessa frase è
    // anche l'etichetta di stato del job nel pannello, che qui è presente
    // di proposito.
    expect(
      screen.queryByText(
        /waiting for an answer from|waiting for a maintainer to answer the ai's question/i,
      ),
    ).not.toBeInTheDocument();
  });

  it("409 già risposta: il pannello dice chi ha risposto", async () => {
    mockDetailApi({
      jobs: [awaitingInputJobFixture],
      questions: [openQuestionFixture],
      answerResponse: () =>
        jsonResponse(409, {
          code: "already_handled",
          message: "Already answered by bob@example.com",
          handledBy: { id: MEMBER_ID, email: "bob@example.com" },
        }),
    });
    renderDetail();

    await userEvent.click(await screen.findByRole("radio", { name: /Quella esistente/ }));
    await userEvent.click(screen.getByRole("button", { name: "Send answer" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Already answered by bob@example.com",
    );
  });

  it("409 con un round nuovo: la pagina si riallinea senza ricaricare", async () => {
    // Lo scenario stantio: un collega risponde per primo e il worker apre
    // SUBITO il round 2 sullo STESSO job. `awaitingInput` non viene mai
    // osservato falso e `latestJob.id` non cambia, quindi l'effetto che ricarica
    // le Q&A sul cambio di stato non rifirerebbe mai: senza il refetch sul 409
    // la pagina resterebbe sul round 1 fino a un ricaricamento a mano.
    const round2: TicketQuestion = {
      ...openQuestionFixture,
      questionId: "99999999-9999-4999-8999-999999999999",
      round: 3,
      question: "E il TTL della cache?",
      options: [{ label: "Un'ora" }, { label: "Un giorno" }],
    };
    // `state` è referenziata dentro `answerResponse`, che gira DOPO: la
    // chiusura la vede già assegnata.
    const state: MockState = mockDetailApi({
      jobs: [awaitingInputJobFixture],
      questions: [openQuestionFixture],
      answerResponse: () => {
        // Il server ha già chiuso il round mostrato e ne ha aperto un altro.
        state.questions = [
          {
            ...openQuestionFixture,
            answer: { optionIndex: 0 },
            answeredAt: "2026-06-07T10:01:00.000Z",
            answeredBy: { id: ADMIN_ID, email: "ada@example.com" },
          },
          round2,
        ];
        return jsonResponse(409, {
          code: "already_handled",
          message: "Already answered by ada@example.com",
          handledBy: { id: ADMIN_ID, email: "ada@example.com" },
        });
      },
    });
    renderDetail();

    await userEvent.click(await screen.findByRole("radio", { name: /Quella esistente/ }));
    await userEvent.click(screen.getByRole("button", { name: "Send answer" }));

    // La domanda nuova arriva da sola: nessun reload, nessuna azione utente.
    expect(await screen.findByText("E il TTL della cache?")).toBeInTheDocument();
    expect(screen.queryByText("Quale coda uso per i job del grafo?")).not.toBeInTheDocument();
  });

  it("senza job 'awaiting_input' non c'è né pannello né riga informativa", async () => {
    mockDetailApi({ jobs: [heldJobFixture], questions: [answeredQuestionFixture] });
    renderDetail();

    await screen.findByRole("button", { name: "Start AI fix" });
    expect(screen.queryByRole("button", { name: "Send answer" })).not.toBeInTheDocument();
    expect(screen.queryByText(/waiting for an answer/i)).not.toBeInTheDocument();
  });

  it("Q&A passate: sezione collassabile con risposta e autore", async () => {
    mockDetailApi({
      jobs: [awaitingInputJobFixture],
      questions: [answeredQuestionFixture, openQuestionFixture],
    });
    renderDetail();

    const toggle = await screen.findByRole("button", { name: /Past questions/i });
    // Chiusa di default: lo storico è consultazione, non la decisione da fare.
    expect(screen.queryByText("Quali colonne devo toccare?")).not.toBeInTheDocument();

    await userEvent.click(toggle);
    const entry = screen.getByText("Quali colonne devo toccare?").closest("li");
    expect(entry).not.toBeNull();
    // La risposta è l'ETICHETTA dell'opzione scelta, non il suo indice.
    expect(within(entry!).getByText("Le nuove")).toBeInTheDocument();
    expect(within(entry!).getByText(/Answered by ada@example\.com/)).toBeInTheDocument();
    // La domanda ancora aperta NON finisce nello storico: si risponde nel
    // pannello, e vederla due volte confonderebbe.
    expect(
      within(entry!).queryByText("Quale coda uso per i job del grafo?"),
    ).not.toBeInTheDocument();
  });

  it("Q&A passate: una risposta illeggibile resta una risposta data", async () => {
    // `answer: null` con `answeredAt` valorizzato = jsonb di una versione
    // precedente. Guardare `answer` direbbe "mai risposta": è `answeredAt` a
    // dire la verità.
    mockDetailApi({
      jobs: [awaitingInputJobFixture],
      questions: [{ ...answeredQuestionFixture, answer: null }, openQuestionFixture],
    });
    renderDetail();

    await userEvent.click(await screen.findByRole("button", { name: /Past questions/i }));

    expect(screen.getByText("Quali colonne devo toccare?")).toBeInTheDocument();
    expect(screen.getByText(/answer is no longer readable/i)).toBeInTheDocument();
  });

  it("domanda aperta in markdown: testo, etichette e conseguenze formattati, nomi accessibili leggibili", async () => {
    mockDetailApi({
      jobs: [awaitingInputJobFixture],
      role: "member",
      questions: [
        {
          ...openQuestionFixture,
          question: "Uso la coda `graph_jobs` o **una nuova**?",
          options: [
            { label: "Usa `graph_jobs`", consequence: "Nessuna migrazione su `ai_jobs`" },
            { label: "Una coda nuova" },
          ],
        },
      ],
    });
    renderDetail();

    const panel = await screen.findByRole("region", { name: "AI activity" });
    expect((await within(panel).findByText("graph_jobs", { selector: "p code" })).tagName).toBe(
      "CODE",
    );
    expect(within(panel).getByText("una nuova").tagName).toBe("STRONG");
    expect(within(panel).getByRole("radio", { name: /^Usa graph_jobs/ })).toBeInTheDocument();
    expect(within(panel).getByText("ai_jobs").tagName).toBe("CODE");
    expect(panel.textContent).not.toContain("`");
  });

  it("Q&A passate in markdown: la domanda e l'etichetta scelta formattate", async () => {
    mockDetailApi({
      jobs: [awaitingInputJobFixture],
      questions: [
        {
          ...answeredQuestionFixture,
          question: "Tocco `users.role`?",
          options: [{ label: "Le vecchie" }, { label: "Solo `role`" }],
        },
        openQuestionFixture,
      ],
    });
    renderDetail();

    await userEvent.click(await screen.findByRole("button", { name: /Past questions/i }));
    const entry = screen.getByText("users.role").closest("li");
    expect(entry).not.toBeNull();
    expect(within(entry!).getByText("users.role").tagName).toBe("CODE");
    expect(within(entry!).getByText("role").tagName).toBe("CODE");
    expect(entry!.textContent).not.toContain("`");
  });

  it("Q&A passate: un'immagine nella domanda o nell'etichetta scelta non si carica, resta l'alt", async () => {
    mockDetailApi({
      jobs: [awaitingInputJobFixture],
      questions: [
        {
          ...answeredQuestionFixture,
          question: "Is ![the chart](https://x.test/q.png) right?",
          options: [{ label: "Le vecchie" }, { label: "See ![pixel](https://x.test/l.png)" }],
        },
        openQuestionFixture,
      ],
    });
    renderDetail();

    await userEvent.click(await screen.findByRole("button", { name: /Past questions/i }));
    const entry = screen.getByText(/the chart/).closest("li");
    expect(entry).not.toBeNull();
    expect(entry!.querySelector("img")).toBeNull();
    expect(entry!.innerHTML).not.toContain("x.test");
    expect(entry!.textContent).toContain("See pixel");
  });

  it("Q&A passate: una risposta in testo libero resta il testo scritto da chi ha risposto", async () => {
    mockDetailApi({
      jobs: [awaitingInputJobFixture],
      questions: [{ ...answeredQuestionFixture, answer: { text: "Usa `x`" } }, openQuestionFixture],
    });
    renderDetail();

    await userEvent.click(await screen.findByRole("button", { name: /Past questions/i }));
    expect(screen.getByText("Usa `x`")).toBeInTheDocument();
  });

  it("nessuna Q&A chiusa: la sezione dello storico non compare", async () => {
    mockDetailApi({ jobs: [awaitingInputJobFixture], questions: [openQuestionFixture] });
    renderDetail();

    await screen.findByText("Quale coda uso per i job del grafo?");
    expect(screen.queryByRole("button", { name: /Past questions/i })).not.toBeInTheDocument();
  });
});
