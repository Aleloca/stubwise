import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import { render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAppRouter } from "../../router";

/**
 * Vista «cosa aspetta me» sulla lista progetti (fase 7, Task 10): la riga di
 * polso per progetto, consumata da `GET /api/projects/pulse`. La logica pura
 * (priorità, testo, tono) è testata a fondo in `lib/pulse-line.test.ts`; qui
 * si verifica solo che il componente la colleghi al progetto giusto — i
 * quattro stati (aspetta te / sta lavorando / fermo / tranquillo), uno a
 * progetto, così ogni riga prova un caso diverso.
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

function project(id: string, name: string) {
  return {
    id,
    name,
    slug: name.toLowerCase(),
    description: null,
    aiProviderId: null,
    docAutoUpdate: false,
    dailyReportEnabled: false,
    backlogEnabled: false,
    pulseEnabled: false,
    pulseEveryDays: 3,
    ingestionKey: "ik_test",
    nextTicketNumber: 1,
    createdAt: "2026-06-01T10:00:00.000Z",
    repositoryCount: 2,
  };
}

const WAITING_ID = "11111111-1111-4111-8111-111111111111";
const RUNNING_ID = "22222222-2222-4222-8222-222222222222";
const IDLE_ID = "33333333-3333-4333-8333-333333333333";
const OK_ID = "44444444-4444-4444-8444-444444444444";
const TICKET_ID = "55555555-5555-4555-8555-555555555555";

function pulseSummaries() {
  return [
    {
      projectId: WAITING_ID,
      projectName: "Attesa",
      waitingForYou: [
        {
          kind: "question",
          ticketId: TICKET_ID,
          ticketNumber: 12,
          title: "Quale coda uso?",
          notificationId: "66666666-6666-4666-8666-666666666666",
        },
      ],
      waitingForOthers: [],
      running: [],
      failedCount: 0,
      backlogReadyCount: 0,
      idleDays: 0,
      lastReportDate: null,
    },
    {
      projectId: RUNNING_ID,
      projectName: "Corsa",
      waitingForYou: [],
      waitingForOthers: [],
      running: [{ ticketId: TICKET_ID, ticketNumber: 13, title: "Export CSV degli ordini", sinceMinutes: 5 }],
      failedCount: 0,
      backlogReadyCount: 0,
      idleDays: 0,
      lastReportDate: null,
    },
    {
      projectId: IDLE_ID,
      projectName: "Fermo",
      waitingForYou: [],
      waitingForOthers: [],
      running: [],
      failedCount: 0,
      backlogReadyCount: 0,
      idleDays: 6,
      lastReportDate: null,
    },
    {
      projectId: OK_ID,
      projectName: "Tranquillo",
      waitingForYou: [],
      waitingForOthers: [],
      running: [],
      failedCount: 0,
      backlogReadyCount: 0,
      idleDays: 0,
      lastReportDate: null,
    },
  ];
}

function baseApi(): Record<string, Handler> {
  return {
    "GET /api/auth/me": () =>
      jsonResponse(200, { user: { id: "u1", email: "ada@example.com", role: "member" } }),
    "GET /api/inbox/unread-count": () => jsonResponse(200, { count: 0 }),
    "GET /api/projects": () =>
      jsonResponse(200, [
        project(WAITING_ID, "Attesa"),
        project(RUNNING_ID, "Corsa"),
        project(IDLE_ID, "Fermo"),
        project(OK_ID, "Tranquillo"),
      ]),
    "GET /api/projects/pulse": () => jsonResponse(200, pulseSummaries()),
  };
}

function renderApp(initialPath: string) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createAppRouter(queryClient, createMemoryHistory({ initialEntries: [initialPath] }));
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return router;
}

describe("ProjectsPage — vista «cosa aspetta me»", () => {
  it("mostra la riga di polso giusta per ciascuno dei quattro stati", async () => {
    mockApi(baseApi());
    renderApp("/projects");

    await screen.findByRole("heading", { name: "Projects" });

    const waitingRow = (await screen.findByText("Attesa")).closest("a")!;
    expect(within(waitingRow).getByText(/needs you — 1 agent question/i)).toBeInTheDocument();

    const runningRow = screen.getByText("Corsa").closest("a")!;
    expect(within(runningRow).getByText(/working — Export CSV degli ordini/i)).toBeInTheDocument();

    const idleRow = screen.getByText("Fermo").closest("a")!;
    expect(within(idleRow).getByText(/idle for 6 days/i)).toBeInTheDocument();

    const okRow = screen.getByText("Tranquillo").closest("a")!;
    expect(within(okRow).getByText(/all quiet/i)).toBeInTheDocument();
  });

  it("una GET /api/projects/pulse che fallisce non rompe la lista: nessuna riga di polso, i progetti restano", async () => {
    mockApi({
      ...baseApi(),
      "GET /api/projects/pulse": () => jsonResponse(500, { code: "internal", message: "boom" }),
    });
    renderApp("/projects");

    await screen.findByText("Attesa");
    expect(screen.getByText("Corsa")).toBeInTheDocument();
    expect(screen.queryByText(/needs you|working —|idle for|all quiet/i)).not.toBeInTheDocument();
  });
});
