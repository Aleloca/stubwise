import type { MailItem } from "@stubwise/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import { render, screen, waitFor } from "@testing-library/react";
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
  title: "Demo col cliente",
  from: "laura@cliente.test",
  url: "https://calendar.google.com/calendar/u/mailbox@acme.test/r/day/2026/9/20",
  status: "failed",
  error: "boom",
  reproposable: true,
});

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

describe("pagina /mail", () => {
  it("elenca posta e calendario, con progetto, segnale e stato", async () => {
    mockApi(baseApi());
    renderMail();
    await screen.findByRole("heading", { name: "Mail" });

    expect(screen.getByText(/Ship next week\?/)).toBeInTheDocument();
    expect(screen.getByText(/Demo col cliente/)).toBeInTheDocument();
    // "Apollo" compare anche come opzione del filtro progetto: si conta solo
    // sulle righe (span del nome progetto in ciascuna card).
    expect(screen.getAllByText("Apollo", { selector: "span" })).toHaveLength(2);
    expect(screen.getByText("Decision")).toBeInTheDocument();
    // "Classified"/"Failed" compaiono anche come opzioni del filtro stato: si
    // scopre solo lo `<span>` della riga.
    expect(screen.getByText("Classified", { selector: "span" })).toBeInTheDocument();
    expect(screen.getByText("Failed", { selector: "span" })).toBeInTheDocument();
  });

  it("il link 'Open' apre in una scheda nuova", async () => {
    mockApi(baseApi());
    renderMail();
    await screen.findByRole("heading", { name: "Mail" });

    const links = screen.getAllByRole("link", { name: "Open" });
    for (const link of links) {
      expect(link).toHaveAttribute("target", "_blank");
      expect(link).toHaveAttribute("rel", "noopener noreferrer");
    }
    expect(links[0]).toHaveAttribute(
      "href",
      "https://mail.google.com/mail/u/mailbox@acme.test/#all/t1",
    );
  });

  it("'Repropose' compare solo sulla riga failed/ignored", async () => {
    mockApi(baseApi());
    renderMail();
    await screen.findByRole("heading", { name: "Mail" });

    // Solo una riga (quella failed) ha il bottone.
    expect(screen.getAllByRole("button", { name: "Repropose" })).toHaveLength(1);
  });

  it("riproponi: chiama la rotta giusta (source/id), esce dai falliti e mostra l'esito", async () => {
    let called: { method: string; url: string } | null = null;
    // Il GET rilegge lo stato REALE dopo la POST (come farebbe il server: la
    // riga torna `new`, non più riproponibile): un mock statico farebbe
    // ricomparire "Repropose" al refetch che segue l'invalidazione, cosa che
    // il server vero non farebbe mai.
    mockApi(
      baseApi({
        [`POST /api/me/mail/calendar/${CALENDAR_ID}/repropose`]: (url, init) => {
          called = { method: init?.method ?? "", url: url.pathname };
          return jsonResponse(200, { ok: true });
        },
        "GET /api/me/mail": () =>
          jsonResponse(200, {
            items: [
              EMAIL_ITEM,
              called
                ? { ...CALENDAR_ITEM, status: "new", error: null, reproposable: false }
                : CALENDAR_ITEM,
            ],
            nextCursor: null,
          }),
      }),
    );
    renderMail();
    await screen.findByRole("heading", { name: "Mail" });

    await userEvent.click(screen.getByRole("button", { name: "Repropose" }));

    await waitFor(() =>
      expect(called).toEqual({ method: "POST", url: `/api/me/mail/calendar/${CALENDAR_ID}/repropose` }),
    );
    expect(await screen.findByText("Reproposed — check the inbox for the new proposal")).toBeInTheDocument();
    // La riga resta a schermo (`title` invariato) ma non è più riproponibile.
    await waitFor(() => expect(screen.queryByRole("button", { name: "Repropose" })).toBeNull());
    expect(screen.getByText(/Demo col cliente/)).toBeInTheDocument();
  });

  it("errore di riproposta: messaggio dedicato, la riga resta", async () => {
    mockApi(
      baseApi({
        [`POST /api/me/mail/calendar/${CALENDAR_ID}/repropose`]: () =>
          jsonResponse(409, { code: "not_reproposable", message: "Cannot repropose" }),
      }),
    );
    renderMail();
    await screen.findByRole("heading", { name: "Mail" });

    await userEvent.click(screen.getByRole("button", { name: "Repropose" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Could not repropose this item",
    );
    expect(screen.getByText(/Demo col cliente/)).toBeInTheDocument();
  });

  it("il filtro progetto invia project= alla query", async () => {
    const seenUrls: string[] = [];
    mockApi(
      baseApi({
        "GET /api/me/mail": (url) => {
          seenUrls.push(url.search);
          return jsonResponse(200, { items: [EMAIL_ITEM, CALENDAR_ITEM], nextCursor: null });
        },
      }),
    );
    renderMail();
    await screen.findByRole("heading", { name: "Mail" });

    await userEvent.selectOptions(screen.getByLabelText("Project"), "Apollo");

    await waitFor(() => expect(seenUrls.some((s) => s.includes(`project=${PROJECT_ID}`))).toBe(true));
  });

  it("contatore delle proposte aperte nell'intestazione", async () => {
    mockApi(
      baseApi({
        "GET /api/me/mail/summary": () =>
          jsonResponse(200, { openProposals: 3, failed: 1, ignored: 0 }),
      }),
    );
    renderMail();
    await screen.findByRole("heading", { name: "Mail" });

    expect(await screen.findByTestId("mail-open-proposals-badge")).toHaveTextContent("3 open");
  });

  it("lista vuota: il vuoto, non un errore", async () => {
    mockApi(baseApi({ "GET /api/me/mail": () => jsonResponse(200, { items: [], nextCursor: null }) }));
    renderMail();
    await screen.findByRole("heading", { name: "Mail" });

    expect(await screen.findByText("// no mail")).toBeInTheDocument();
  });

  it("errore di caricamento: messaggio e retry", async () => {
    let fail = true;
    mockApi(
      baseApi({
        "GET /api/me/mail": () =>
          fail
            ? jsonResponse(500, { code: "internal", message: "boom" })
            : jsonResponse(200, { items: [EMAIL_ITEM], nextCursor: null }),
      }),
    );
    renderMail();

    expect(await screen.findByText("Could not load Mail.")).toBeInTheDocument();

    fail = false;
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));

    expect(await screen.findByText(/Ship next week\?/)).toBeInTheDocument();
  });
});
