import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { AiJobStatus } from "@stubwise/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deriveNextStep, WorkNextStep, type NextStepKind } from "./work-next-step";

/**
 * `deriveNextStep` è PURA e deterministica (design fase 7 §4): questi test la
 * coprono esaustivamente prima di quelli del componente, perché è lì che vive
 * l'invariante — nessun testo generato da un modello.
 */
describe("deriveNextStep", () => {
  it("voce archiviata: nessuna riga (null)", () => {
    expect(deriveNextStep({ itemStatus: "archived", ticketId: null, latestJobStatus: null })).toBeNull();
  });

  it.each(["new", "refining"] as const)("voce '%s': clarify", (itemStatus) => {
    expect(deriveNextStep({ itemStatus, ticketId: null, latestJobStatus: null })).toBe("clarify");
  });

  it("voce 'ready': readyToConvert", () => {
    expect(deriveNextStep({ itemStatus: "ready", ticketId: null, latestJobStatus: null })).toBe(
      "readyToConvert",
    );
  });

  it("convertita ma il link al ticket non è ancora arrivato: null (non convertedNoJob)", () => {
    expect(
      deriveNextStep({ itemStatus: "converted", ticketId: null, latestJobStatus: null }),
    ).toBeNull();
  });

  it("convertita, ticket collegato, nessun job ancora: convertedNoJob", () => {
    expect(
      deriveNextStep({ itemStatus: "converted", ticketId: "t1", latestJobStatus: null }),
    ).toBe("convertedNoJob");
  });

  const CASES: Array<[AiJobStatus, NextStepKind]> = [
    ["queued", "preparingPlan"],
    ["triaging", "preparingPlan"],
    ["fixing", "executing"],
    ["held", "needsAttention"],
    ["awaiting_input", "needsAttention"],
    ["awaiting_plan_approval", "awaitingApproval"],
    ["pr_opened", "prReady"],
    ["pr_merged", "done"],
    ["failed", "needsAttention"],
    ["skipped", "needsAttention"],
    ["pr_closed", "needsAttention"],
  ];
  it.each(CASES)("job '%s' → %s", (status, expected) => {
    expect(deriveNextStep({ itemStatus: "converted", ticketId: "t1", latestJobStatus: status })).toBe(
      expected,
    );
  });
});

/**
 * Test del componente: montato col router vero (serve `Link` verso il
 * ticket) e fetch mockata per metodo+path, come le pagine backlog/ticket.
 */
const ITEM_ID = "11111111-1111-4111-8111-111111111111";
const TICKET_ID = "22222222-2222-4222-8222-222222222222";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
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

function mockApi(jobs: Array<{ status: AiJobStatus }>, convertCalls: { count: number } = { count: 0 }) {
  fetchMock.mockImplementation((input, init) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(raw, "http://test.local");
    const method = init?.method ?? "GET";
    if (method === "GET" && url.pathname === `/api/tickets/${TICKET_ID}/jobs`) {
      return Promise.resolve(
        jsonResponse(
          200,
          jobs.map((job, index) => ({
            id: `j${index}`,
            ticketId: TICKET_ID,
            status: job.status,
            log: "",
            prUrl: null,
            error: null,
            createdAt: "2026-07-21T10:00:00.000Z",
            startedAt: null,
            finishedAt: null,
            providerLabel: null,
            providerKind: null,
            requestedByUserId: null,
          })),
        ),
      );
    }
    if (method === "POST" && url.pathname === `/api/backlog/${ITEM_ID}/convert`) {
      convertCalls.count += 1;
      return Promise.resolve(jsonResponse(200, { ticketId: TICKET_ID, ticketNumber: 7 }));
    }
    throw new Error(`fetch non mockata per ${method} ${url.pathname}`);
  });
}

/**
 * Router MINIMALE, non l'app intera: una root che rende `WorkNextStep`
 * direttamente + una rotta finta `/tickets/$id` (mai montata, serve solo a
 * far risolvere l'`href` del `<Link>` verso il ticket — stesso pattern di
 * `docs-releases.test.tsx`).
 */
function renderNextStep(props: {
  itemStatus: "new" | "refining" | "ready" | "converted" | "archived";
  ticketId?: string | null;
  ticketNumber?: number | null;
}) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const rootRoute = createRootRoute({
    component: () => (
      <QueryClientProvider client={queryClient}>
        <WorkNextStep
          itemId={ITEM_ID}
          itemStatus={props.itemStatus}
          ticketId={props.ticketId ?? null}
          ticketNumber={props.ticketNumber ?? null}
        />
      </QueryClientProvider>
    ),
  });
  const ticketsRoute = createRoute({ getParentRoute: () => rootRoute, path: "/tickets/$id" });
  const router = createRouter({
    routeTree: rootRoute.addChildren([ticketsRoute]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  return render(<RouterProvider router={router} />);
}

describe("WorkNextStep", () => {
  it("voce 'new': frase 'clarify', nessun bottone", async () => {
    mockApi([]);
    renderNextStep({ itemStatus: "new" });
    expect(await screen.findByText(/idea to clarify/i)).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });

  it("voce 'ready': frase + bottone Converti che chiama POST /convert", async () => {
    const convertCalls = { count: 0 };
    mockApi([], convertCalls);
    const user = userEvent.setup();
    renderNextStep({ itemStatus: "ready" });

    expect(await screen.findByText(/shall I turn it into a task/i)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Convert to task" }));
    await waitFor(() => expect(convertCalls.count).toBe(1));
  });

  it("voce 'converted' senza job: frase 'convertedNoJob' + link al ticket", async () => {
    mockApi([]);
    renderNextStep({ itemStatus: "converted", ticketId: TICKET_ID, ticketNumber: 7 });
    expect(await screen.findByText(/task created/i)).toBeInTheDocument();
    const link = screen.getByRole("link", { name: /go to ticket #7/i });
    expect(link).toHaveAttribute("href", `/tickets/${TICKET_ID}`);
  });

  it("job awaiting_plan_approval: frase 'awaitingApproval'", async () => {
    mockApi([{ status: "awaiting_plan_approval" }]);
    renderNextStep({ itemStatus: "converted", ticketId: TICKET_ID, ticketNumber: 7 });
    expect(await screen.findByText(/waiting for a maintainer to approve it/i)).toBeInTheDocument();
  });

  it("job pr_opened: frase 'prReady'", async () => {
    mockApi([{ status: "pr_opened" }]);
    renderNextStep({ itemStatus: "converted", ticketId: TICKET_ID, ticketNumber: 7 });
    expect(await screen.findByText(/releasing it is up to a maintainer/i)).toBeInTheDocument();
  });

  it("voce archiviata: non rende nulla", async () => {
    mockApi([]);
    const { container } = renderNextStep({ itemStatus: "archived" });
    // `waitFor` invece di un'asserzione sincrona: il router ha un primo giro
    // di match/render prima di stabilizzarsi (stesso motivo per cui gli altri
    // test usano `findByText`), e un DOM vuoto in quella finestra non prova
    // ancora nulla.
    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });
});
