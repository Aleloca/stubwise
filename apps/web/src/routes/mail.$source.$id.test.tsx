import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAppRouter } from "../router";

/**
 * `/mail/:source/:id` (fase 7b, Task 8): il dettaglio di un'email — l'estratto
 * subito, l'originale su richiesta. Stesso stile di `mail.test.tsx`: router
 * reale + memory history, API mockata via fetch.
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

const EMAIL_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

const DETAIL = {
  id: EMAIL_ID,
  source: "email" as const,
  accountId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  accountEmail: "mailbox@acme.test",
  from: "Laura <laura@cliente.test>",
  to: ["me@acme.test"],
  subject: "Ship next week?",
  receivedAt: "2026-08-31T09:00:00.000Z",
  labels: [],
  textExcerpt: "Possiamo spostare il rilascio?",
  url: "https://mail.google.com/mail/u/mailbox@acme.test/#all/t1",
};

function baseApi(overrides: Record<string, Handler> = {}): Record<string, Handler> {
  return {
    "GET /api/auth/me": () =>
      jsonResponse(200, { user: { id: "u1", email: "ada@example.com", role: "admin", language: "en" } }),
    "GET /api/inbox/unread-count": () => jsonResponse(200, { count: 0 }),
    [`GET /api/me/mail/email/${EMAIL_ID}`]: () => jsonResponse(200, DETAIL),
    ...overrides,
  };
}

function renderDetail(source: "email" | "email_triage" = "email", id: string = EMAIL_ID) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider
        router={createAppRouter(queryClient, createMemoryHistory({ initialEntries: [`/mail/${source}/${id}`] }))}
      />
    </QueryClientProvider>,
  );
  return queryClient;
}

describe("pagina /mail/:source/:id", () => {
  it("mostra l'estratto subito, senza chiamare Gmail", async () => {
    mockApi(baseApi());
    renderDetail();

    await screen.findByRole("heading", { name: "Ship next week?" });
    expect(screen.getByText("Possiamo spostare il rilascio?")).toBeInTheDocument();
    expect(fetchMock.mock.calls.some((call) => String(call[0]).includes("/original"))).toBe(false);
  });

  it("un messaggio senza estratto mostra l'avviso, non un vuoto", async () => {
    mockApi(baseApi({ [`GET /api/me/mail/email/${EMAIL_ID}`]: () => jsonResponse(200, { ...DETAIL, textExcerpt: null }) }));
    renderDetail();

    await screen.findByRole("heading", { name: "Ship next week?" });
    expect(screen.getByText("No extract saved for this message.")).toBeInTheDocument();
  });

  it("messaggio inesistente: pagina 'not found', non un errore generico", async () => {
    mockApi(
      baseApi({
        [`GET /api/me/mail/email/${EMAIL_ID}`]: () => jsonResponse(404, { code: "not_found", message: "Message not found" }),
      }),
    );
    renderDetail();

    await screen.findByText("This message was not found.");
  });

  it("'Read original' rilegge da Gmail su richiesta e mostra il corpo grezzo", async () => {
    mockApi(
      baseApi({
        [`GET /api/me/mail/email/${EMAIL_ID}/original`]: () =>
          jsonResponse(200, {
            subject: "Ship next week?",
            from: "Laura <laura@cliente.test>",
            to: ["me@acme.test"],
            cc: [],
            bodyText: "Corpo completo.\n--\nLaura, Cliente SRL",
            attachments: [{ filename: "contratto.pdf", mimeType: "application/pdf" }],
          }),
      }),
    );
    renderDetail();
    await screen.findByRole("heading", { name: "Ship next week?" });

    await userEvent.click(screen.getByRole("button", { name: "Read original on Gmail" }));

    await screen.findByText(/Laura, Cliente SRL/);
    expect(screen.getByText("contratto.pdf")).toBeInTheDocument();
  });

  it.each([
    ["message_gone", 409, "This message no longer exists on Gmail."],
    ["token_expired", 409, "This Google account needs to be reconnected."],
    ["google_unavailable", 502, "Could not reach Google. Try again in a moment."],
  ])("errore %s sulla rilettura → messaggio dedicato", async (code, status, expected) => {
    mockApi(
      baseApi({
        [`GET /api/me/mail/email/${EMAIL_ID}/original`]: () => jsonResponse(status, { code, message: "x" }),
      }),
    );
    renderDetail();
    await screen.findByRole("heading", { name: "Ship next week?" });

    await userEvent.click(screen.getByRole("button", { name: "Read original on Gmail" }));

    await screen.findByText(expected);
  });
});
