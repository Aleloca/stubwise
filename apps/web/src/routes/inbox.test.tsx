import type { InboxItem } from "@stubwise/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAppRouter } from "../router";

/**
 * Pagina `/inbox`: sezioni, azioni per riga ed esiti (successo, conflitto,
 * ottimismo). Router reale + memory history, API mockata via fetch; asserzioni
 * sulle stringhe inglesi (i18n inizializzato in `en`).
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

/**
 * Come le altre suite di rotta, ma con i path parametrici: una chiave che
 * contiene `:id` (es. `POST /api/inbox/:id/read`) matcha per pattern, così non
 * serve registrare un handler per ogni notifica.
 */
function mockApi(handlers: Record<string, Handler>) {
  fetchMock.mockImplementation((input, init) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(raw, "http://test.local");
    const method = init?.method ?? "GET";
    const exact = handlers[`${method} ${url.pathname}`];
    if (exact) return Promise.resolve(exact(url, init));
    for (const [key, handler] of Object.entries(handlers)) {
      const [handlerMethod, pattern] = key.split(" ");
      if (handlerMethod !== method || pattern === undefined) continue;
      if (!pattern.includes(":id")) continue;
      if (new RegExp(`^${pattern.replaceAll(":id", "[^/]+")}$`).test(url.pathname)) {
        return Promise.resolve(handler(url, init));
      }
    }
    throw new Error(`fetch non mockata per ${method} ${raw}`);
  });
}

const PROJECT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const DECIDE_ID = "11111111-1111-4111-8111-111111111111";
const KNOW_ID = "22222222-2222-4222-8222-222222222222";
const EXTRA_ID = "33333333-3333-4333-8333-333333333333";

const PROJECTS = [{ id: PROJECT_ID, name: "Apollo", slug: "apollo" }];

function item(overrides: Partial<InboxItem> & Pick<InboxItem, "id">): InboxItem {
  return {
    kind: "job.plan_review",
    status: "open",
    text: "Plan awaiting approval",
    actions: [],
    projectId: PROJECT_ID,
    ticketId: null,
    jobId: null,
    createdAt: "2026-08-31T10:00:00.000Z",
    readAt: null,
    snoozedUntil: null,
    handledAt: null,
    handledBy: null,
    ...overrides,
  };
}

/** Riga che chiede una DECISIONE (ha azioni decisionali fra le sue `actions`). */
const DECIDE = item({
  id: DECIDE_ID,
  kind: "job.plan_review",
  text: "Plan awaiting approval for TCK-1",
  actions: ["approve_plan", "reject_plan", "open", "snooze", "handled"],
  url: "/tickets/tck-1",
});

/** Riga di sola informazione: nessuna azione decisionale. */
const KNOW = item({
  id: KNOW_ID,
  kind: "job.pr_opened",
  text: "PR opened for TCK-2",
  actions: ["open", "snooze", "handled"],
  url: "https://github.com/acme/web/pull/9",
});

function baseApi(overrides: Record<string, Handler> = {}): Record<string, Handler> {
  return {
    "GET /api/auth/me": () =>
      jsonResponse(200, {
        user: { id: "u1", email: "ada@example.com", role: "admin", language: "en" },
      }),
    "GET /api/projects": () => jsonResponse(200, PROJECTS),
    "GET /api/inbox/unread-count": () => jsonResponse(200, { count: 2 }),
    "GET /api/inbox": () => jsonResponse(200, { items: [DECIDE, KNOW], nextCursor: null }),
    "POST /api/inbox/:id/read": () => jsonResponse(204, null),
    ...overrides,
  };
}

function renderInbox() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider
        router={createAppRouter(queryClient, createMemoryHistory({ initialEntries: ["/inbox"] }))}
      />
    </QueryClientProvider>,
  );
  return queryClient;
}

/** La sezione (region) col titolo dato: le card si cercano dentro la loro sezione. */
function section(name: string): HTMLElement {
  return screen.getByRole("region", { name });
}

describe("pagina /inbox", () => {
  it("divide le aperte fra 'To decide' e 'To know' e marca lette le non lette", async () => {
    const read: string[] = [];
    mockApi(
      baseApi({
        "POST /api/inbox/:id/read": (url) => {
          read.push(url.pathname);
          return jsonResponse(204, null);
        },
      }),
    );
    renderInbox();

    expect(await screen.findByRole("heading", { name: "Inbox" })).toBeInTheDocument();

    expect(
      within(section("To decide")).getByText("Plan awaiting approval for TCK-1"),
    ).toBeInTheDocument();
    expect(within(section("To know")).getByText("PR opened for TCK-2")).toBeInTheDocument();
    // La riga decisionale NON compare anche fra quelle di sola informazione.
    expect(within(section("To know")).queryByText("Plan awaiting approval for TCK-1")).toBeNull();

    // Il progetto è risolto in nome (metadato mono della card).
    expect(within(section("To decide")).getByText("Apollo")).toBeInTheDocument();

    // Entrambe le righe sono `readAt: null`: la pagina le marca lette al mount.
    await waitFor(() => expect(read).toHaveLength(2));
    expect(read).toContain(`/api/inbox/${DECIDE_ID}/read`);
    expect(read).toContain(`/api/inbox/${KNOW_ID}/read`);
  });

  it("rende i soli bottoni dichiarati in `actions`", async () => {
    mockApi(baseApi());
    renderInbox();
    await screen.findByRole("heading", { name: "Inbox" });

    const decide = within(section("To decide"));
    expect(decide.getByRole("button", { name: "Approve plan" })).toBeInTheDocument();
    expect(decide.getByRole("button", { name: "Reject" })).toBeInTheDocument();
    // `relaunch` non è fra le actions di questa riga: niente bottone.
    expect(decide.queryByRole("button", { name: "Relaunch" })).toBeNull();
    expect(decide.getByRole("link", { name: "Open" })).toHaveAttribute("href", "/tickets/tck-1");

    const know = within(section("To know"));
    expect(know.queryByRole("button", { name: "Approve plan" })).toBeNull();
    expect(know.getByRole("button", { name: "Snooze" })).toBeInTheDocument();
    expect(know.getByRole("button", { name: "Handled" })).toBeInTheDocument();
  });

  it("approva il piano: chiama l'API e la riga passa a gestita", async () => {
    let approved = false;
    const calls: string[] = [];
    mockApi(
      baseApi({
        "GET /api/inbox": () =>
          jsonResponse(200, {
            // Dopo l'approvazione il server restituisce la riga CHIUSA (senza
            // più azioni): la card resta a schermo, attenuata, con l'autore.
            items: approved
              ? [
                  {
                    ...DECIDE,
                    status: "handled",
                    actions: [],
                    readAt: "2026-08-31T10:01:00.000Z",
                    handledAt: "2026-08-31T10:02:00.000Z",
                    handledBy: { id: "u1", email: "ada@example.com" },
                  },
                  KNOW,
                ]
              : [DECIDE, KNOW],
            nextCursor: null,
          }),
        "POST /api/inbox/:id/actions/approve_plan": (url) => {
          approved = true;
          calls.push(url.pathname);
          return jsonResponse(200, {
            kind: "job.plan_review",
            jobId: "44444444-4444-4444-8444-444444444444",
            changedNotificationIds: [DECIDE_ID],
          });
        },
      }),
    );
    renderInbox();
    await screen.findByRole("heading", { name: "Inbox" });

    await userEvent.click(screen.getByRole("button", { name: "Approve plan" }));

    await waitFor(() => expect(calls).toEqual([`/api/inbox/${DECIDE_ID}/actions/approve_plan`]));
    expect(await screen.findByText("handled by ada@example.com")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Approve plan" })).toBeNull();
  });

  it("rifiuta: apre il campo e invia le istruzioni nel body", async () => {
    let body: unknown = null;
    mockApi(
      baseApi({
        "POST /api/inbox/:id/actions/reject_plan": (_url, init) => {
          body = JSON.parse(String(init?.body));
          return jsonResponse(200, {
            kind: "job.plan_review",
            changedNotificationIds: [DECIDE_ID],
          });
        },
      }),
    );
    renderInbox();
    await screen.findByRole("heading", { name: "Inbox" });

    // Il campo non c'è finché non si sceglie di rifiutare.
    expect(screen.queryByLabelText(/Instructions for the next attempt/)).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Reject" }));

    const textarea = await screen.findByLabelText(/Instructions for the next attempt/);
    await userEvent.type(textarea, "Split the migration in two");
    await userEvent.click(screen.getByRole("button", { name: "Send rejection" }));

    await waitFor(() => expect(body).toEqual({ instructions: "Split the migration in two" }));
  });

  it("409 already_handled: dice chi l'ha gestita e ricarica la lista", async () => {
    let listCalls = 0;
    mockApi(
      baseApi({
        "GET /api/inbox": () => {
          listCalls += 1;
          return jsonResponse(200, { items: [DECIDE, KNOW], nextCursor: null });
        },
        "POST /api/inbox/:id/actions/approve_plan": () =>
          jsonResponse(409, {
            code: "already_handled",
            message: "Already handled",
            // UUID vero: `handledByFromError` VALIDA il body del 409 con lo
            // schema condiviso prima di fidarsene, e un id non-uuid ricadrebbe
            // (correttamente) sul messaggio generico.
            handledBy: { id: "55555555-5555-4555-8555-555555555555", email: "bea@example.com" },
          }),
      }),
    );
    renderInbox();
    await screen.findByRole("heading", { name: "Inbox" });
    const before = listCalls;

    await userEvent.click(screen.getByRole("button", { name: "Approve plan" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Already handled by bea@example.com",
    );
    // Perso il testa a testa, quello che vediamo è stantio: si ricarica comunque.
    await waitFor(() => expect(listCalls).toBeGreaterThan(before));
  });

  it("posticipa: la riga sparisce subito, senza attendere la risposta", async () => {
    let snoozeBody: unknown = null;
    mockApi(
      baseApi({
        // Risposta che non arriva mai: quello che si vede dopo il click è
        // esclusivamente l'aggiornamento ottimistico.
        "POST /api/inbox/:id/snooze": (_url, init) => {
          snoozeBody = JSON.parse(String(init?.body));
          return new Promise<Response>(() => {});
        },
      }),
    );
    renderInbox();
    await screen.findByRole("heading", { name: "Inbox" });

    const know = within(section("To know"));
    await userEvent.click(know.getByRole("button", { name: "Snooze" }));
    await userEvent.click(know.getByRole("button", { name: "1 hour" }));

    await waitFor(() => expect(screen.queryByText("PR opened for TCK-2")).toBeNull());
    expect(snoozeBody).toEqual({ until: "1h" });
    // L'altra riga resta dov'è.
    expect(screen.getByText("Plan awaiting approval for TCK-1")).toBeInTheDocument();
  });

  it("'Load more' chiede la pagina successiva col cursore e la accoda", async () => {
    const cursors: (string | null)[] = [];
    mockApi(
      baseApi({
        "GET /api/inbox": (url) => {
          const cursor = url.searchParams.get("cursor");
          cursors.push(cursor);
          return cursor === null
            ? jsonResponse(200, { items: [KNOW], nextCursor: "cursor-2" })
            : jsonResponse(200, {
                items: [
                  item({
                    id: EXTRA_ID,
                    kind: "job.failed",
                    text: "Fix failed on TCK-9",
                    actions: ["handled"],
                  }),
                ],
                nextCursor: null,
              });
        },
      }),
    );
    renderInbox();
    await screen.findByRole("heading", { name: "Inbox" });

    await userEvent.click(screen.getByRole("button", { name: "Load more" }));

    expect(await screen.findByText("Fix failed on TCK-9")).toBeInTheDocument();
    // La prima pagina resta a schermo: la seconda si accoda, non sostituisce.
    expect(screen.getByText("PR opened for TCK-2")).toBeInTheDocument();
    expect(cursors).toEqual([null, "cursor-2"]);
    // Esaurito il cursore, il bottone sparisce.
    expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
  });

  it("la tab Snoozed chiede lo stato snoozed; una sezione senza righe mostra il vuoto", async () => {
    const statuses: (string | null)[] = [];
    mockApi(
      baseApi({
        "GET /api/inbox": (url) => {
          const status = url.searchParams.get("status");
          statuses.push(status);
          return jsonResponse(200, { items: [], nextCursor: null });
        },
      }),
    );
    renderInbox();
    await screen.findByRole("heading", { name: "Inbox" });

    // Vuoto per sezione, non un vuoto unico per la pagina.
    expect(within(section("To decide")).getByText("// no notifications")).toBeInTheDocument();
    expect(within(section("To know")).getByText("// no notifications")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("tab", { name: "Snoozed" }));

    expect(await screen.findByRole("region", { name: "Snoozed" })).toBeInTheDocument();
    // Lo stato è SEMPRE esplicito, anche per la vista d'ingresso.
    await waitFor(() => expect(statuses).toEqual(["open", "snoozed"]));
  });

  it("errore di caricamento: messaggio e retry", async () => {
    let fail = true;
    mockApi(
      baseApi({
        "GET /api/inbox": () =>
          fail
            ? jsonResponse(500, { code: "internal", message: "boom" })
            : jsonResponse(200, { items: [KNOW], nextCursor: null }),
      }),
    );
    renderInbox();

    expect(await screen.findByText("Could not load the inbox.")).toBeInTheDocument();

    fail = false;
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));

    expect(await screen.findByText("PR opened for TCK-2")).toBeInTheDocument();
  });
});
