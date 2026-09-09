import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAppRouter } from "../router";

/**
 * `/calendar` (fase 7b, Task 9): serie ricorrenti (spente di default) +
 * appuntamenti visti. Stesso stile di `mail.test.tsx`.
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

const PROJECT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ACCOUNT_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const PROJECTS = [{ id: PROJECT_ID, name: "Apollo", slug: "apollo" }];
const GOOGLE_ACCOUNTS = [
  {
    id: ACCOUNT_ID,
    email: "mailbox@acme.test",
    workspaceId: "e0000000-0000-4000-8000-000000000000",
    workspaceName: "Acme",
    scopes: [],
    proposalsEnabled: true,
    connectedAt: "2026-08-01T00:00:00.000Z",
    lastSyncAt: null,
    disabledAt: null,
    disabledReason: null,
  },
];

const OFF_SERIES = {
  accountId: ACCOUNT_ID,
  accountEmail: "mailbox@acme.test",
  recurringEventId: "serie-1",
  title: "Pianificazione task",
  occurrenceCount: 730,
  nextOccurrenceAt: null,
  enabled: false,
  projectId: null,
  projectName: null,
  action: "milestone",
  leadDays: 2,
  auto: false,
};

const EVENT = {
  id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  accountId: ACCOUNT_ID,
  accountEmail: "mailbox@acme.test",
  recurringEventId: null,
  projectId: PROJECT_ID,
  projectName: "Apollo",
  title: "Demo col cliente",
  organizer: "laura@cliente.test",
  startsAt: "2026-09-20T10:00:00.000Z",
  status: "new",
  outcome: null,
  error: null,
  url: "https://calendar.google.com/calendar/u/mailbox@acme.test/r/day/2026/9/20",
  reproposable: false,
};

function baseApi(overrides: Record<string, Handler> = {}): Record<string, Handler> {
  return {
    "GET /api/auth/me": () =>
      jsonResponse(200, { user: { id: "u1", email: "ada@example.com", role: "admin", language: "en" } }),
    "GET /api/projects": () => jsonResponse(200, PROJECTS),
    "GET /api/inbox/unread-count": () => jsonResponse(200, { count: 0 }),
    "GET /api/me/google/accounts": () => jsonResponse(200, GOOGLE_ACCOUNTS),
    "GET /api/me/calendar/series": () => jsonResponse(200, { items: [OFF_SERIES] }),
    "GET /api/me/calendar": () => jsonResponse(200, { items: [EVENT], nextCursor: null }),
    ...overrides,
  };
}

function renderCalendar() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider
        router={createAppRouter(queryClient, createMemoryHistory({ initialEntries: ["/calendar"] }))}
      />
    </QueryClientProvider>,
  );
  return queryClient;
}

describe("pagina /calendar", () => {
  it("elenca serie e appuntamenti; una serie mai accesa mostra 'Off'", async () => {
    mockApi(baseApi());
    renderCalendar();

    await screen.findByRole("heading", { name: "Calendar" });
    expect(screen.getByText("Pianificazione task")).toBeInTheDocument();
    expect(screen.getByText("Off")).toBeInTheDocument();
    expect(screen.getByText(/Demo col cliente/)).toBeInTheDocument();
  });

  it("le 730 occorrenze passate compaiono come una serie spenta, non un fantasma", async () => {
    mockApi(baseApi());
    renderCalendar();

    await screen.findByText("Pianificazione task");
    expect(screen.getByTestId("series-meta")).toHaveTextContent("730 occurrences tracked · nothing upcoming");
  });

  it("accendere una serie senza progetto è rifiutato lato client, prima di chiamare il server", async () => {
    mockApi(baseApi());
    renderCalendar();
    await screen.findByText("Pianificazione task");

    await userEvent.click(screen.getByRole("button", { name: "Turn on" }));
    await userEvent.click(screen.getByRole("checkbox", { name: "Enabled" }));
    await userEvent.click(screen.getByRole("button", { name: "Save" }));

    await screen.findByText("Choose a project before turning this series on.");
    expect(fetchMock.mock.calls.some((call) => String(call[0]).includes("/series/serie-1"))).toBe(false);
  });

  it("accendere una serie con progetto scelto: PUT con enabled true e il progetto", async () => {
    let putBody: unknown;
    mockApi(
      baseApi({
        "PUT /api/me/calendar/series/serie-1": (_url, init) => {
          putBody = JSON.parse(String(init?.body));
          return jsonResponse(200, { ok: true });
        },
      }),
    );
    renderCalendar();
    await screen.findByText("Pianificazione task");

    await userEvent.click(screen.getByRole("button", { name: "Turn on" }));
    const panel = screen.getByText("Enabled").closest("div")!.parentElement!;
    await userEvent.click(screen.getByRole("checkbox", { name: "Enabled" }));
    await userEvent.selectOptions(within(panel).getByLabelText("Project"), "Apollo");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(putBody).toMatchObject({ accountId: ACCOUNT_ID, enabled: true, projectId: PROJECT_ID });
  });

  it("la copy dice esplicitamente che una serie è spenta di default e perché", async () => {
    mockApi(baseApi());
    renderCalendar();
    await screen.findByText("Pianificazione task");
    await userEvent.click(screen.getByRole("button", { name: "Turn on" }));

    expect(
      screen.getByText(/Off by default — turning this on lets Stubwise act on every future occurrence/),
    ).toBeInTheDocument();
  });

  it("nessuna serie: messaggio esplicito, non una lista vuota silenziosa", async () => {
    mockApi(baseApi({ "GET /api/me/calendar/series": () => jsonResponse(200, { items: [] }) }));
    renderCalendar();

    await screen.findByRole("heading", { name: "Calendar" });
    await screen.findByText("No recurring series seen yet.");
  });
});
