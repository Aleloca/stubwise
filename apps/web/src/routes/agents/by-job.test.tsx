import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAppRouter } from "../../router";

/** `/agents/job/$jobId` (piano B, Task 8): trova la sessione di un job e ci va. */

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  // Le pagine di arrivo (ticket, sessione) rispondono 404 qui, di proposito:
  // il router lo dice con un warning che non è l'oggetto di queste prove.
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  fetchMock.mockReset();
});

const JOB_ID = "22222222-2222-4222-8222-222222222222";
const SESSION_ID = "11111111-1111-4111-8111-111111111111";
const TICKET_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

const SUMMARY = {
  id: SESSION_ID,
  kind: "ai_job",
  title: "Fix",
  projectId: null,
  projectName: null,
  ticketId: TICKET_ID,
  ticketNumber: 7,
  startedAt: "2026-06-03T10:00:05.000Z",
  lastEventAt: null,
  state: "working",
  aiJobId: JOB_ID,
  outcome: null,
};

/**
 * Il lookup per job risponde come dice il test; tutto il resto (ticket,
 * sessione, utente...) risponde 404 generico: a queste prove interessa solo
 * dove finisce la navigazione, non cosa disegna la pagina di arrivo.
 */
function mockLookup(lookup: () => Response) {
  fetchMock.mockImplementation((input) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(raw, "http://test.local");
    if (url.pathname === "/api/agent-sessions") {
      expect(url.searchParams.get("aiJobId")).toBe(JOB_ID);
      return Promise.resolve(lookup());
    }
    if (url.pathname === "/api/auth/me") {
      return Promise.resolve(
        jsonResponse(200, { user: { id: "u1", email: "a@b.c", role: "admin", language: "en" } }),
      );
    }
    return Promise.resolve(jsonResponse(404, { error: "not_found", message: "Not found" }));
  });
}

function renderAt(entry: string) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createAppRouter(queryClient, createMemoryHistory({ initialEntries: [entry] }));
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return router;
}

describe("/agents/job/$jobId", () => {
  it("con una sessione va su /agents/<id>#question", async () => {
    mockLookup(() => jsonResponse(200, { live: [SUMMARY], recent: [] }));
    const router = renderAt(`/agents/job/${JOB_ID}?ticketId=${TICKET_ID}`);

    await waitFor(() => expect(router.state.location.pathname).toBe(`/agents/${SESSION_ID}`));
    expect(router.state.location.hash).toBe("question");
  });

  it("una sessione conclusa (solo in `recent`) vale come trovata", async () => {
    mockLookup(() => jsonResponse(200, { live: [], recent: [{ ...SUMMARY, state: "ended" }] }));
    const router = renderAt(`/agents/job/${JOB_ID}?ticketId=${TICKET_ID}`);

    await waitFor(() => expect(router.state.location.pathname).toBe(`/agents/${SESSION_ID}`));
  });

  it("senza sessioni va al ticket", async () => {
    mockLookup(() => jsonResponse(200, { live: [], recent: [] }));
    const router = renderAt(`/agents/job/${JOB_ID}?ticketId=${TICKET_ID}`);

    await waitFor(() => expect(router.state.location.pathname).toBe(`/tickets/${TICKET_ID}`));
  });

  it("server senza le rotte (404 senza code) va al ticket", async () => {
    mockLookup(() => jsonResponse(404, { error: "not_found", message: "Not found" }));
    const router = renderAt(`/agents/job/${JOB_ID}?ticketId=${TICKET_ID}`);

    await waitFor(() => expect(router.state.location.pathname).toBe(`/tickets/${TICKET_ID}`));
  });

  it("senza sessione e senza ?ticketId= va a /agents", async () => {
    mockLookup(() => jsonResponse(200, { live: [], recent: [] }));
    const router = renderAt(`/agents/job/${JOB_ID}`);

    await waitFor(() => expect(router.state.location.pathname).toBe("/agents"));
  });
});
