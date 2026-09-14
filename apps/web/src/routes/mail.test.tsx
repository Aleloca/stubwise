import type { MailItem } from "@stubwise/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAppRouter } from "../router";

/**
 * Pagina `/mail` (fase 6, Task 12): lista unificata posta+calendario, filtri,
 * «Riproponi» solo su `failed`/`ignored`, contatore delle proposte aperte.
 * Stesso stile di `inbox.test.tsx`: router reale + memory history, API
 * mockata via fetch, asserzioni sulle stringhe inglesi.
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
const EMAIL_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const CALENDAR_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

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

function mailItem(overrides: Partial<MailItem> & Pick<MailItem, "id" | "source">): MailItem {
  return {
    kind: "proposal",
    threadId: null,
    accountId: ACCOUNT_ID,
    accountEmail: "mailbox@acme.test",
    projectId: PROJECT_ID,
    projectName: "Apollo",
    title: "Ship next week?",
    from: "laura@cliente.test",
    date: "2026-09-07T08:14:00.000Z",
    status: "new",
    signal: null,
    outcome: null,
    error: null,
    url: "https://mail.google.com/mail/u/mailbox@acme.test/#all/t1",
    reproposable: false,
    ...overrides,
  };
}

const EMAIL_ITEM = mailItem({
  id: EMAIL_ID,
  source: "email",
  status: "classified",
  signal: "decision",
});

const CALENDAR_ITEM = mailItem({
  id: CALENDAR_ID,
  source: "calendar",
  kind: "calendar",
  title: "Demo col cliente",
  from: "laura@cliente.test",
  url: "https://calendar.google.com/calendar/u/mailbox@acme.test/r/day/2026/9/20",
  status: "failed",
  error: "boom",
  reproposable: true,
});

/** Una conversazione della lista per thread («la posta si legge per conversazione» §4). */
const THREAD_ITEM = {
  threadId: "thread-1",
  accountId: ACCOUNT_ID,
  accountEmail: "mailbox@acme.test",
  subject: "Re: Ship next week?",
  lastFrom: "marco@cliente.test",
  lastReceivedAt: "2026-09-09T09:00:00.000Z",
  messageCount: 3,
  openProposals: 1,
  projectNames: ["Apollo"],
};

function baseApi(overrides: Record<string, Handler> = {}): Record<string, Handler> {
  return {
    "GET /api/auth/me": () =>
      jsonResponse(200, {
        user: { id: "u1", email: "ada@example.com", role: "admin", language: "en" },
      }),
    "GET /api/projects": () => jsonResponse(200, PROJECTS),
    "GET /api/inbox/unread-count": () => jsonResponse(200, { count: 0 }),
    "GET /api/me/google/accounts": () => jsonResponse(200, GOOGLE_ACCOUNTS),
    "GET /api/me/mail/summary": () => jsonResponse(200, { openProposals: 0, failed: 0, ignored: 0 }),
    "GET /api/me/mail": () => jsonResponse(200, { items: [EMAIL_ITEM, CALENDAR_ITEM], nextCursor: null }),
    "GET /api/me/mail/threads": () => jsonResponse(200, { items: [THREAD_ITEM], nextCursor: null }),
    ...overrides,
  };
}

function renderMail() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider
        router={createAppRouter(queryClient, createMemoryHistory({ initialEntries: ["/mail"] }))}
      />
    </QueryClientProvider>,
  );
  return queryClient;
}

/**
 * ⚠️ I test della vista per MESSAGGI sono stati RIMOSSI, non riscritti: dal
 * 14 set 2026 il web elenca solo conversazioni (decisione del maintainer,
 * design §4), e con la vista se ne sono andati i filtri per stato e per
 * progetto, la lista fusa col calendario, «Riproponi» e i badge di riga.
 * Non c'era niente da adattare — quel comportamento la pagina non ce l'ha
 * più.
 *
 * Quello che resta vero è testato sotto sulla vista nuova (intestazione,
 * vuoto, errore). Le capacità tolte da QUESTA pagina non sono sparite dal
 * prodotto: «Riproponi» vive sulla card in inbox e sull'app, il calendario
 * ha la sua pagina `/calendar`, e `GET /api/me/mail` per messaggio resta
 * viva sul server per l'app già installata.
 */
describe("pagina /mail", () => {
  it("contatore delle proposte aperte nell'intestazione", async () => {
    mockApi(
      baseApi({
        "GET /api/me/mail/summary": () =>
          jsonResponse(200, { openProposals: 3, failed: 1, ignored: 0 }),
      }),
    );
    renderMail();

    expect(await screen.findByTestId("mail-open-proposals-badge")).toHaveTextContent("3 open");
  });

  it("nessuna conversazione: il vuoto, non un errore", async () => {
    mockApi(
      baseApi({ "GET /api/me/mail/threads": () => jsonResponse(200, { items: [], nextCursor: null }) }),
    );
    renderMail();

    expect(await screen.findByText("// no mail")).toBeInTheDocument();
  });

  it("errore di caricamento: messaggio e retry", async () => {
    let fail = true;
    mockApi(
      baseApi({
        "GET /api/me/mail/threads": () =>
          fail
            ? jsonResponse(500, { code: "internal", message: "boom" })
            : jsonResponse(200, { items: [THREAD_ITEM], nextCursor: null }),
      }),
    );
    renderMail();

    expect(await screen.findByText("Could not load Mail.")).toBeInTheDocument();

    fail = false;
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));

    expect(await screen.findByText("Re: Ship next week?")).toBeInTheDocument();
  });
});

describe("pagina /mail — la vista per CONVERSAZIONI (§4)", () => {
  it("è la vista di DEFAULT: si aprono conversazioni, non messaggi", async () => {
    mockApi(baseApi());
    renderMail();
    await screen.findByRole("heading", { name: "Mail" });

    expect(await screen.findByTestId("mail-thread-list")).toBeInTheDocument();
    expect(screen.getByText("Re: Ship next week?")).toBeInTheDocument();
    expect(screen.getByText("marco@cliente.test")).toBeInTheDocument();
    // Quanti messaggi contiene e quante proposte aspettano una decisione.
    expect(screen.getByText("3 messages")).toBeInTheDocument();
    expect(screen.getByText("1 open proposal")).toBeInTheDocument();
  });

  it("aprendo una conversazione si leggono i messaggi IN ORDINE, col contesto dichiarato", async () => {
    mockApi(
      baseApi({
        "GET /api/me/mail/threads/thread-1": () =>
          jsonResponse(200, {
            threadId: "thread-1",
            accountId: ACCOUNT_ID,
            accountEmail: "mailbox@acme.test",
            subject: "Re: Ship next week?",
            url: "https://mail.google.com/x",
            messages: [
              {
                id: "11111111-1111-4111-8111-111111111111",
                from: "laura@cliente.test",
                to: [],
                receivedAt: "2026-09-07T09:00:00.000Z",
                textExcerpt: "La PRIMA email della conversazione",
                admitted: false,
                proposalIds: [],
              },
              {
                id: "22222222-2222-4222-8222-222222222222",
                from: "marco@cliente.test",
                to: [],
                receivedAt: "2026-09-09T09:00:00.000Z",
                textExcerpt: "L'ULTIMA email",
                admitted: true,
                proposalIds: [],
              },
            ],
          }),
      }),
    );
    renderMail();
    await screen.findByTestId("mail-thread-list");

    await userEvent.click(screen.getByTestId("mail-thread-row-thread-1"));

    const pane = await screen.findByTestId("mail-thread-pane");
    expect(within(pane).getByText("La PRIMA email della conversazione")).toBeInTheDocument();
    expect(within(pane).getByText("L'ULTIMA email")).toBeInTheDocument();
    // Un messaggio di CONTESTO si dichiara: non è uno che «non ha ancora»
    // prodotto una proposta, è uno che non ne produrrà mai.
    expect(within(pane).getByText(/Context message/)).toBeInTheDocument();
  });

  it("chiudendo la conversazione si torna al prompt di selezione", async () => {
    mockApi(
      baseApi({
        "GET /api/me/mail/threads/thread-1": () =>
          jsonResponse(200, {
            threadId: "thread-1",
            accountId: ACCOUNT_ID,
            accountEmail: "mailbox@acme.test",
            url: "https://mail.google.com/x",
            messages: [],
          }),
      }),
    );
    renderMail();
    await screen.findByTestId("mail-thread-list");
    await userEvent.click(screen.getByTestId("mail-thread-row-thread-1"));
    await screen.findByTestId("mail-thread-pane");

    await userEvent.click(screen.getByTestId("mail-thread-close"));
    await waitFor(() => expect(screen.queryByTestId("mail-thread-pane")).not.toBeInTheDocument());
  });
});
