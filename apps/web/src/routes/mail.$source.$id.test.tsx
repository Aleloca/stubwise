import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAppRouter } from "../router";

/**
 * `/mail/:source/:id` (fase 7b, Task 8; fase 9, Task 5): il dettaglio di
 * un'email — l'estratto subito, l'originale su richiesta — dentro la STESSA
 * pagina a tre colonne di `/mail` (`MailWorkspace`): la lista al centro
 * resta visibile, non si naviga più via da lei. `baseApi()` per questo
 * mocka anche le rotte della lista/filtri (progetti, caselle, riepilogo,
 * lista posta), non solo il dettaglio: senza, le `useSuspenseQuery`
 * condivise con `/mail` non avrebbero una risposta. Stesso stile di
 * `mail.test.tsx`: router reale + memory history, API mockata via fetch.
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
    // La stessa pagina a tre colonne di `/mail` (fase 9, Task 5): queste
    // rotte alimentano la colonna sinistra (filtri) e quella centrale
    // (lista), visibili ANCHE quando si arriva già su un messaggio preciso.
    "GET /api/projects": () => jsonResponse(200, []),
    "GET /api/me/google/accounts": () => jsonResponse(200, []),
    "GET /api/me/mail/summary": () => jsonResponse(200, { openProposals: 0, failed: 0, ignored: 0 }),
    "GET /api/me/mail": () =>
      jsonResponse(200, {
        items: [
          {
            kind: "proposal",
            id: EMAIL_ID,
            source: "email",
            accountId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
            accountEmail: "mailbox@acme.test",
            projectId: null,
            projectName: null,
            title: "Ship next week?",
            from: "laura@cliente.test",
            date: "2026-08-31T09:00:00.000Z",
            status: "classified",
            signal: null,
            outcome: null,
            error: null,
            url: "https://mail.google.com/mail/u/mailbox@acme.test/#all/t1",
            reproposable: false,
          },
        ],
        nextCursor: null,
      }),
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
  it("la lista resta visibile ACCANTO al dettaglio (tre colonne, fase 9, Task 5)", async () => {
    mockApi(baseApi());
    renderDetail();

    await screen.findByRole("heading", { name: "Ship next week?" });
    // La riga della lista (colonna centrale) è ANCORA a schermo, non
    // sostituita dal dettaglio: è la differenza rispetto alla vecchia
    // pagina separata.
    expect(screen.getByRole("link", { name: "Read in Stubwise" })).toBeInTheDocument();
    expect(screen.getByLabelText("Mailbox")).toBeInTheDocument();
  });

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

  it("fix di review: la nota sulla rilettura si legge PRIMA del click, accanto al bottone", async () => {
    mockApi(baseApi());
    renderDetail();

    await screen.findByRole("heading", { name: "Ship next week?" });
    // Prima di qualunque click: il bottone c'è E la nota anche, non solo
    // l'etichetta "su Gmail" del bottone da sola.
    expect(screen.getByRole("button", { name: "Read original on Gmail" })).toBeInTheDocument();
    expect(
      screen.getByText("Asking Google for this message now — nothing is saved."),
    ).toBeInTheDocument();
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

  it("con bodyHtml: rende un iframe in sandbox, senza allow-scripts né allow-same-origin (fase 9, Task 5)", async () => {
    mockApi(
      baseApi({
        [`GET /api/me/mail/email/${EMAIL_ID}/original`]: () =>
          jsonResponse(200, {
            subject: "Ship next week?",
            from: "Laura <laura@cliente.test>",
            to: ["me@acme.test"],
            cc: [],
            bodyText: "Corpo completo.",
            bodyHtml: '<p><b>Ciao</b></p><img alt="" data-src="https://tracker.example/pixel.gif">',
            attachments: [],
          }),
      }),
    );
    renderDetail();
    await screen.findByRole("heading", { name: "Ship next week?" });

    await userEvent.click(screen.getByRole("button", { name: "Read original on Gmail" }));

    const frame = await screen.findByTitle("Message body");
    const sandbox = frame.getAttribute("sandbox") ?? "";
    expect(sandbox).not.toContain("allow-scripts");
    expect(sandbox).not.toContain("allow-same-origin");
    // L'immagine remota è bloccata di default: il bottone "mostra immagini" c'è.
    expect(screen.getByRole("button", { name: "Show images" })).toBeInTheDocument();
  });

  it("'mostra immagini': il comando sparisce dopo il click (le immagini restano bloccate finché non lo premi)", async () => {
    mockApi(
      baseApi({
        [`GET /api/me/mail/email/${EMAIL_ID}/original`]: () =>
          jsonResponse(200, {
            subject: "Ship next week?",
            from: "Laura <laura@cliente.test>",
            to: [],
            cc: [],
            bodyText: null,
            bodyHtml: '<img alt="" data-src="https://tracker.example/pixel.gif">',
            attachments: [],
          }),
      }),
    );
    renderDetail();
    await screen.findByRole("heading", { name: "Ship next week?" });
    await userEvent.click(screen.getByRole("button", { name: "Read original on Gmail" }));

    await userEvent.click(await screen.findByRole("button", { name: "Show images" }));

    expect(screen.queryByRole("button", { name: "Show images" })).toBeNull();
  });

  it("senza bodyHtml (solo testo): niente iframe, il corpo grezzo in <pre>", async () => {
    mockApi(
      baseApi({
        [`GET /api/me/mail/email/${EMAIL_ID}/original`]: () =>
          jsonResponse(200, {
            subject: "Ship next week?",
            from: "Laura <laura@cliente.test>",
            to: [],
            cc: [],
            bodyText: "Solo testo.",
            bodyHtml: null,
            attachments: [],
          }),
      }),
    );
    renderDetail();
    await screen.findByRole("heading", { name: "Ship next week?" });
    await userEvent.click(screen.getByRole("button", { name: "Read original on Gmail" }));

    await screen.findByText("Solo testo.");
    expect(screen.queryByTitle("Message body")).toBeNull();
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

  it("passando da un messaggio all'altro, l'originale riletto NON resta stantio (bug bloccante trovato dalla review Stubwise)", async () => {
    const EMAIL_ID_2 = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
    const DETAIL_2 = {
      id: EMAIL_ID_2,
      source: "email" as const,
      accountId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      accountEmail: "mailbox@acme.test",
      from: "Marco <marco@cliente.test>",
      to: ["me@acme.test"],
      subject: "Fattura di settembre",
      receivedAt: "2026-09-01T09:00:00.000Z",
      labels: [],
      textExcerpt: "In allegato la fattura.",
      url: "https://mail.google.com/mail/u/mailbox@acme.test/#all/t2",
    };
    mockApi(
      baseApi({
        "GET /api/me/mail": () =>
          jsonResponse(200, {
            items: [
              {
                kind: "proposal",
                id: EMAIL_ID,
                source: "email",
                accountId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
                accountEmail: "mailbox@acme.test",
                projectId: null,
                projectName: null,
                title: "Ship next week?",
                from: "laura@cliente.test",
                date: "2026-08-31T09:00:00.000Z",
                status: "classified",
                signal: null,
                outcome: null,
                error: null,
                url: "https://mail.google.com/mail/u/mailbox@acme.test/#all/t1",
                reproposable: false,
              },
              {
                kind: "proposal",
                id: EMAIL_ID_2,
                source: "email",
                accountId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
                accountEmail: "mailbox@acme.test",
                projectId: null,
                projectName: null,
                title: "Fattura di settembre",
                from: "marco@cliente.test",
                date: "2026-09-01T09:00:00.000Z",
                status: "classified",
                signal: null,
                outcome: null,
                error: null,
                url: "https://mail.google.com/mail/u/mailbox@acme.test/#all/t2",
                reproposable: false,
              },
            ],
            nextCursor: null,
          }),
        [`GET /api/me/mail/email/${EMAIL_ID_2}`]: () => jsonResponse(200, DETAIL_2),
        [`GET /api/me/mail/email/${EMAIL_ID}/original`]: () =>
          jsonResponse(200, {
            subject: "Ship next week?",
            from: "Laura <laura@cliente.test>",
            to: ["me@acme.test"],
            cc: [],
            bodyText: "Corpo del primo messaggio.",
            attachments: [],
          }),
      }),
    );
    renderDetail();
    await screen.findByRole("heading", { name: "Ship next week?" });

    await userEvent.click(screen.getByRole("button", { name: "Read original on Gmail" }));
    await screen.findByText("Corpo del primo messaggio.");

    // Passa al secondo messaggio SENZA aver chiuso/ricaricato la pagina —
    // esattamente lo scenario del bug: stesso componente, prop `id` cambiata.
    // La riga della lista non è linkata sull'oggetto, ma su "Read in
    // Stubwise": scoped alla riga per non ambiguità con quella del primo
    // messaggio, che porta lo stesso testo.
    const secondRow = screen.getByText(/Fattura di settembre/).closest("article")!;
    await userEvent.click(within(secondRow).getByRole("link", { name: "Read in Stubwise" }));

    await screen.findByRole("heading", { name: "Fattura di settembre" });
    // Il corpo del PRIMO messaggio non deve restare in vista...
    expect(screen.queryByText("Corpo del primo messaggio.")).not.toBeInTheDocument();
    // ...e il comando di rilettura deve ripresentarsi per il messaggio nuovo,
    // non restare "già letto" per via dello stato mai resettato.
    expect(await screen.findByRole("button", { name: "Read original on Gmail" })).toBeInTheDocument();
  });
});
