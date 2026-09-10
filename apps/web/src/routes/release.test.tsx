import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAppRouter } from "../router";

/**
 * `/release` (fase 8, Task 10): la coda di rilascio, "una pagina sola, per il
 * maintainer" (design §4). Stesso stile di `calendar.test.tsx`.
 */

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

const TICKET_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const REPOSITORY_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

const ITEM = {
  ticketId: TICKET_ID,
  ticketNumber: 42,
  ticketTitle: "Fix the bug",
  repositoryId: REPOSITORY_ID,
  repositoryName: "demo-shop",
  projectId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
  projectName: "Apollo",
  branch: "stubwise/ticket-42",
  prUrl: "https://github.com/acme/demo-shop/pull/42",
  prNumber: 42,
  createdAt: "2026-09-10T08:00:00.000Z",
  reviewVerdict: "approve",
  reviewSummary: "Cambia solo la formula del totale.",
  checks: { status: "success", checks: [{ name: "ci", status: "success" }] },
  testStatus: "passed",
  risk: "low",
  riskReason: "nessun file sensibile, un solo repository",
  deployedOn: [],
};

function meHandler(role: "admin" | "member" = "admin"): Handler {
  return () => jsonResponse(200, { user: { id: "u1", email: "ada@example.com", role, language: "en" } });
}

function baseApi(overrides: Record<string, Handler> = {}): Record<string, Handler> {
  return {
    "GET /api/auth/me": meHandler(),
    "GET /api/inbox/unread-count": () => jsonResponse(200, { count: 0 }),
    "GET /api/release-queue": () => jsonResponse(200, { items: [ITEM] }),
    ...overrides,
  };
}

function renderRelease() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createAppRouter(queryClient, createMemoryHistory({ initialEntries: ["/release"] }));
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return router;
}

describe("/release — lista", () => {
  it("mostra la PR con le colonne review/check/test/rischio", async () => {
    mockApi(baseApi());
    renderRelease();

    await screen.findByText(/Fix the bug/);
    expect(screen.getByText(/Apollo/)).toBeInTheDocument();
    expect(screen.getByText(/demo-shop/)).toBeInTheDocument();
    expect(screen.getByText(/Approved/)).toBeInTheDocument();
    expect(screen.getByText(/Green/)).toBeInTheDocument();
    expect(screen.getByText(/Passed/i)).toBeInTheDocument();
    expect(screen.getByText(/Low/)).toBeInTheDocument();
  });

  it("senza PR aperte mostra il vuoto", async () => {
    mockApi(baseApi({ "GET /api/release-queue": () => jsonResponse(200, { items: [] }) }));
    renderRelease();
    await screen.findByText(/no open PRs/i);
  });

  it("un member viene reindirizzato (requireAdmin), non vede la coda", async () => {
    mockApi(baseApi({ "GET /api/auth/me": meHandler("member") }));
    const router = renderRelease();

    // requireAdmin manda a /settings/account per un non-admin.
    await waitFor(() => expect(router.state.location.pathname).toBe("/settings/account"));
    expect(screen.queryByText(/Fix the bug/)).not.toBeInTheDocument();
  });
});

describe("/release — rilascia", () => {
  it("richiede conferma, poi POST e invalida la lista", async () => {
    const user = userEvent.setup();
    let released = false;
    mockApi(
      baseApi({
        "GET /api/release-queue": () => jsonResponse(200, released ? { items: [] } : { items: [ITEM] }),
        [`POST /api/tickets/${TICKET_ID}/repositories/${REPOSITORY_ID}/release`]: () => {
          released = true;
          return jsonResponse(200, { merged: true, sha: "deadbeef" });
        },
      }),
    );
    renderRelease();

    await screen.findByText(/Fix the bug/);
    await user.click(screen.getByRole("button", { name: "Release" }));
    // Prima del click di conferma il POST non deve partire.
    expect(fetchMock.mock.calls.some((c) => String(c[0]).includes("/release") && c[1]?.method === "POST")).toBe(
      false,
    );
    await user.click(screen.getByRole("button", { name: "Confirm merge" }));

    await screen.findByText(/no open PRs/i);
  });

  it("check rossi: il rilascio fallisce con un messaggio dedicato", async () => {
    const user = userEvent.setup();
    mockApi(
      baseApi({
        [`POST /api/tickets/${TICKET_ID}/repositories/${REPOSITORY_ID}/release`]: () =>
          jsonResponse(409, { code: "checks_failed", message: "checks are red" }),
      }),
    );
    renderRelease();

    await screen.findByText(/Fix the bug/);
    await user.click(screen.getByRole("button", { name: "Release" }));
    await user.click(screen.getByRole("button", { name: "Confirm merge" }));

    await screen.findByText(/cannot be released/i);
  });

  it("annullare la conferma non invia nulla", async () => {
    const user = userEvent.setup();
    mockApi(baseApi());
    renderRelease();

    await screen.findByText(/Fix the bug/);
    await user.click(screen.getByRole("button", { name: "Release" }));
    await user.click(screen.getByRole("button", { name: "Cancel" }));

    expect(screen.getByRole("button", { name: "Release" })).toBeInTheDocument();
    expect(fetchMock.mock.calls.some((c) => c[1]?.method === "POST")).toBe(false);
  });
});
