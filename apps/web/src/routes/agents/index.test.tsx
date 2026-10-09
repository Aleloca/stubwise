import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAppRouter } from "../../router";

/** `/agents` (piano B, Task 5): «Al lavoro ora» e «Concluse». Stile di `release.test.tsx`. */

function jsonResponse(status: number, body: unknown): Response {
  return new Response(status === 204 ? null : JSON.stringify(body), {
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

type Handler = (url: URL, init?: RequestInit) => Response | Promise<Response>;

function mockApi(handlers: Record<string, Handler>) {
  fetchMock.mockImplementation((input, init) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(raw, "http://test.local");
    const method = init?.method ?? "GET";
    const exact = handlers[`${method} ${url.pathname}`];
    if (exact) return Promise.resolve(exact(url, init));
    throw new Error(`fetch non mockata per ${method} ${raw}`);
  });
}

const PROJECT_ID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const TICKET_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const NOW = Date.now();

const LIVE = {
  id: "11111111-1111-4111-8111-111111111111",
  kind: "ai_job",
  title: "Fix the bug",
  projectId: PROJECT_ID,
  projectName: "Apollo",
  ticketId: TICKET_ID,
  ticketNumber: 42,
  startedAt: new Date(NOW - 75 * 60_000).toISOString(),
  lastEventAt: new Date(NOW - 5_000).toISOString(),
  state: "working",
  activeSegment: "execute",
  lastActivity: { kind: "edit", target: "routes/tickets.ts" },
  aiJobId: "22222222-2222-4222-8222-222222222222",
  outcome: null,
};

// Un server del solo piano A più vecchio: niente lastActivity, aiJobId, outcome.
const LEGACY_LIVE = {
  id: "33333333-3333-4333-8333-333333333333",
  kind: "pr_review",
  title: "Legacy review",
  projectId: null,
  projectName: null,
  ticketId: null,
  ticketNumber: null,
  startedAt: new Date(NOW - 10 * 60_000).toISOString(),
  lastEventAt: null,
  state: "queued",
};

const DONE = {
  id: "44444444-4444-4444-8444-444444444444",
  kind: "ai_job",
  title: "Done one",
  projectId: PROJECT_ID,
  projectName: "Apollo",
  ticketId: TICKET_ID,
  ticketNumber: 7,
  startedAt: new Date(NOW - 3 * 3600_000).toISOString(),
  lastEventAt: new Date(NOW - 2 * 3600_000).toISOString(),
  state: "ended",
  outcome: "completed",
};
const FAILED = { ...DONE, id: "55555555-5555-4555-8555-555555555555", title: "Broken one", outcome: "failed" };

function meHandler(role: "admin" | "member" = "admin"): Handler {
  return () => jsonResponse(200, { user: { id: "u1", email: "ada@example.com", role, language: "en" } });
}

function baseApi(overrides: Record<string, Handler> = {}): Record<string, Handler> {
  return {
    "GET /api/auth/me": meHandler(),
    "GET /api/inbox/unread-count": () => jsonResponse(200, { count: 0 }),
    "GET /api/projects": () =>
      jsonResponse(200, [{ id: PROJECT_ID, name: "Apollo", slug: "apollo", description: null }]),
    "GET /api/agent-sessions": () => jsonResponse(200, { live: [LIVE], recent: [DONE, FAILED] }),
    ...overrides,
  };
}

function renderAgents() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, retryDelay: 0 } } });
  const router = createAppRouter(queryClient, createMemoryHistory({ initialEntries: ["/agents"] }));
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return router;
}

describe("/agents", () => {
  it("una sessione viva mostra tipo, ticket, stato, durata e l'ultima azione a parole", async () => {
    mockApi(baseApi());
    renderAgents();

    await screen.findByText(/is editing routes\/tickets\.ts/);
    expect(screen.getByText("Fix the bug")).toBeInTheDocument();
    const row = screen.getByRole("link", { name: /Fix the bug/ });
    expect(within(row).getByText(/Apollo #42/)).toBeInTheDocument();
    expect(within(row).getByText("Fix")).toBeInTheDocument();
    expect(within(row).getByText("working")).toBeInTheDocument();
    expect(screen.getByText(/for 1 h 15 min/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Fix the bug/ })).toHaveAttribute(
      "href",
      `/agents/${LIVE.id}`,
    );
  });

  it("una sessione senza lastActivity, aiJobId e outcome (server più vecchio) rende la riga", async () => {
    mockApi(
      baseApi({
        "GET /api/agent-sessions": () =>
          jsonResponse(200, { live: [LEGACY_LIVE], recent: [] }),
      }),
    );
    renderAgents();

    await screen.findByText("Legacy review");
    expect(screen.getByText("queued")).toBeInTheDocument();
  });

  it("404 senza code (server senza le rotte): «non disponibile», nessuna lista", async () => {
    mockApi(
      baseApi({
        "GET /api/agent-sessions": () =>
          jsonResponse(404, {
            message: "Route GET:/api/agent-sessions not found",
            error: "Not Found",
            statusCode: 404,
          }),
      }),
    );
    renderAgents();

    await screen.findByText(/not available on this instance/i);
    expect(screen.queryByText(/no agent at work/)).not.toBeInTheDocument();
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
  });

  it("un 404 con code not_found non è «non disponibile»", async () => {
    mockApi(
      baseApi({
        "GET /api/agent-sessions": () =>
          jsonResponse(404, { code: "not_found", message: "no" }),
      }),
    );
    renderAgents();

    await waitFor(() =>
      expect(screen.queryByText(/not available on this instance/i)).not.toBeInTheDocument(),
    );
    await screen.findByRole("alert");
  });

  it("un 500 non è «non disponibile»: mostra l'errore", async () => {
    mockApi(
      baseApi({ "GET /api/agent-sessions": () => jsonResponse(500, { code: "boom", message: "x" }) }),
    );
    renderAgents();

    await screen.findByRole("alert");
    expect(screen.queryByText(/not available on this instance/i)).not.toBeInTheDocument();
  });

  it("filtro esito «failed»: resta solo la sessione fallita", async () => {
    mockApi(baseApi());
    renderAgents();
    await screen.findByText("Done one");

    await userEvent.selectOptions(screen.getByLabelText("Outcome"), "failed");

    expect(screen.queryByText("Done one")).not.toBeInTheDocument();
    expect(screen.getByText("Broken one")).toBeInTheDocument();
    // La sezione viva non è toccata dal filtro delle concluse.
    expect(screen.getByText("Fix the bug")).toBeInTheDocument();
  });

  it("filtro progetto: la richiesta parte con ?projectId=", async () => {
    mockApi(baseApi());
    renderAgents();
    await screen.findByText("Done one");
    await screen.findByRole("option", { name: "Apollo" });

    await userEvent.selectOptions(screen.getByLabelText("Project"), PROJECT_ID);

    await waitFor(() => {
      const urls = fetchMock.mock.calls.map(([i]) => String(i));
      expect(urls.some((u) => u.includes(`/api/agent-sessions?projectId=${PROJECT_ID}`))).toBe(true);
    });
  });

  it("le concluse mostrano esito e niente durata", async () => {
    mockApi(baseApi());
    renderAgents();
    const row = (await screen.findByText("Done one")).closest("li") as HTMLElement;
    expect(within(row).getByText("completed")).toBeInTheDocument();
    const section = row.closest("section") as HTMLElement;
    expect(within(section).queryByText(/^for /)).not.toBeInTheDocument();
  });

  it("un member vede la sezione", async () => {
    mockApi(baseApi({ "GET /api/auth/me": meHandler("member") }));
    renderAgents();
    await screen.findByText("Fix the bug");
  });
});
