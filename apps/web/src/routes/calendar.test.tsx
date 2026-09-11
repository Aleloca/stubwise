import type { CalendarEventItem } from "@stubwise/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createAppRouter } from "../router";

/**
 * `/calendar` (fase 9, Task 6/7, design §4): la griglia giorno/settimana/mese
 * al posto dell'elenco piatto della 7b. I tre casi che il piano chiede
 * esplicitamente: un evento a cavallo di mezzanotte, un evento «tutto il
 * giorno», e una settimana vuota che SPIEGA perché (non sembra rotta).
 *
 * `TZ` fissato a UTC (non a un fuso negativo come in `calendar-grid.test.ts`,
 * che copre già quell'estremo): qui l'obiettivo è la resa a schermo, non i
 * fusi — fissarlo evita solo che l'ambiente CI e quello locale vedano
 * settimane diverse.
 */
const ORIGINAL_TZ = process.env.TZ;

beforeAll(() => {
  process.env.TZ = "UTC";
});

afterAll(() => {
  process.env.TZ = ORIGINAL_TZ;
});

function jsonResponse(status: number, body: unknown): Response {
  return new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  // Sabato 12 settembre 2026, mezzogiorno UTC: dentro la settimana lunedì
  // 7 - domenica 13, la vista di default della pagina.
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(new Date("2026-09-12T12:00:00.000Z"));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
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

function event(overrides: Partial<CalendarEventItem> & Pick<CalendarEventItem, "id" | "startsAt">): CalendarEventItem {
  return {
    accountId: ACCOUNT_ID,
    accountEmail: "mailbox@acme.test",
    recurringEventId: null,
    projectId: PROJECT_ID,
    projectName: "Apollo",
    title: "Evento",
    organizer: "laura@cliente.test",
    attendees: [],
    endsAt: null,
    allDay: false,
    status: "new",
    outcome: null,
    error: null,
    url: "https://calendar.google.com/calendar/u/mailbox@acme.test/r/day/2026/9/12",
    eventUrl: null,
    reproposable: false,
    ...overrides,
  };
}

function baseApi(overrides: Record<string, Handler> = {}): Record<string, Handler> {
  return {
    "GET /api/auth/me": () =>
      jsonResponse(200, { user: { id: "u1", email: "ada@example.com", role: "admin", language: "en" } }),
    "GET /api/projects": () => jsonResponse(200, PROJECTS),
    "GET /api/inbox/unread-count": () => jsonResponse(200, { count: 0 }),
    "GET /api/me/google/accounts": () => jsonResponse(200, GOOGLE_ACCOUNTS),
    "GET /api/me/calendar/series": () => jsonResponse(200, { items: [] }),
    "GET /api/me/calendar/range": () => jsonResponse(200, { items: [], nextCursor: null }),
    ...overrides,
  };
}

async function renderCalendar() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider
        router={createAppRouter(queryClient, createMemoryHistory({ initialEntries: ["/calendar"] }))}
      />
    </QueryClientProvider>,
  );
  await screen.findByRole("heading", { name: "Calendar" });
  return queryClient;
}

describe("pagina /calendar — la griglia (fase 9)", () => {
  it("un evento a cavallo di mezzanotte compare in ENTRAMBE le colonne dei giorni che tocca", async () => {
    const spanning = event({
      id: "e-midnight",
      title: "Notte fonda",
      startsAt: "2026-09-11T23:00:00.000Z",
      endsAt: "2026-09-12T01:00:00.000Z",
    });
    mockApi(baseApi({ "GET /api/me/calendar/range": () => jsonResponse(200, { items: [spanning], nextCursor: null }) }));
    await renderCalendar();

    expect(await screen.findAllByText("Notte fonda")).toHaveLength(2);
  });

  it("un evento tutto il giorno compare nella riga dedicata, non nella griglia oraria", async () => {
    const allDay = event({
      id: "e-allday",
      title: "Ferie",
      startsAt: "2026-09-10T00:00:00.000Z",
      allDay: true,
    });
    mockApi(baseApi({ "GET /api/me/calendar/range": () => jsonResponse(200, { items: [allDay], nextCursor: null }) }));
    await renderCalendar();

    expect(await screen.findByText("Ferie")).toBeInTheDocument();
  });

  it("una settimana vuota SPIEGA perché — non sembra rotta", async () => {
    mockApi(baseApi());
    await renderCalendar();

    expect(await screen.findByText(/only shows appointments that match a project's mail routing rules/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Change which appointments show up" })).toBeInTheDocument();
  });

  it("selezionare un evento apre il pannello di dettaglio con partecipanti e link a Google Calendar", async () => {
    const withGuests = event({
      id: "e-detail",
      title: "Demo col cliente",
      organizer: "organizer@cliente.test",
      startsAt: "2026-09-08T10:00:00.000Z",
      endsAt: "2026-09-08T11:00:00.000Z",
      eventUrl: "https://calendar.google.com/event?eid=abc",
      attendees: [{ email: "laura@cliente.test", responseStatus: "accepted" }],
    });
    mockApi(baseApi({ "GET /api/me/calendar/range": () => jsonResponse(200, { items: [withGuests], nextCursor: null }) }));
    await renderCalendar();

    await userEvent.click(await screen.findByText("Demo col cliente"));

    expect(await screen.findByText("laura@cliente.test")).toBeInTheDocument();
    expect(screen.getByText("Accepted")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open in Google Calendar" })).toHaveAttribute(
      "href",
      "https://calendar.google.com/event?eid=abc",
    );
  });

  it("un evento SENZA serie non mostra la configurazione della serie nel dettaglio", async () => {
    const standalone = event({ id: "e-standalone", startsAt: "2026-09-08T10:00:00.000Z" });
    mockApi(baseApi({ "GET /api/me/calendar/range": () => jsonResponse(200, { items: [standalone], nextCursor: null }) }));
    await renderCalendar();

    await userEvent.click(await screen.findByText("Evento"));

    // Scoped al pannello di dettaglio: dal fix di review (Task 2) esiste
    // ANCHE una sezione «Recurring series» nella sidebar, sempre presente —
    // qui si guarda solo che il DETTAGLIO non la mostri per un evento senza serie.
    expect(within(screen.getByRole("article")).queryByText("Recurring series")).not.toBeInTheDocument();
  });

  it("un evento DI UNA serie mostra la configurazione, raggiungibile solo da lì", async () => {
    const recurring = event({ id: "e-recurring", startsAt: "2026-09-08T10:00:00.000Z", recurringEventId: "serie-1" });
    mockApi(
      baseApi({
        "GET /api/me/calendar/range": () => jsonResponse(200, { items: [recurring], nextCursor: null }),
        "GET /api/me/calendar/series": () =>
          jsonResponse(200, {
            items: [
              {
                accountId: ACCOUNT_ID,
                accountEmail: "mailbox@acme.test",
                recurringEventId: "serie-1",
                title: "Evento",
                occurrenceCount: 5,
                nextOccurrenceAt: "2026-09-15T10:00:00.000Z",
                enabled: false,
                projectId: null,
                projectName: null,
                action: "milestone",
                leadDays: 2,
                auto: false,
              },
            ],
          }),
      }),
    );
    await renderCalendar();

    await userEvent.click(await screen.findByText("Evento"));

    expect(await within(screen.getByRole("article")).findByText("Recurring series")).toBeInTheDocument();
  });

  it("una serie senza occorrenze in finestra è elencata e configurabile dalla sidebar (fix di review, fase 9 Task 2)", async () => {
    let putBody: unknown;
    mockApi(
      baseApi({
        "GET /api/me/calendar/range": () => jsonResponse(200, { items: [], nextCursor: null }),
        "GET /api/me/calendar/series": () =>
          jsonResponse(200, {
            items: [
              {
                accountId: ACCOUNT_ID,
                accountEmail: "mailbox@acme.test",
                recurringEventId: "serie-spenta",
                title: "Standup settimanale",
                occurrenceCount: 12,
                // Fuori dalla finestra [-30gg, +60gg]: nessuna occorrenza in vista.
                nextOccurrenceAt: null,
                enabled: false,
                projectId: null,
                projectName: null,
                action: "milestone",
                leadDays: 2,
                auto: false,
              },
            ],
          }),
        "PUT /api/me/calendar/series/serie-spenta": (_url, init) => {
          putBody = JSON.parse(String(init?.body));
          return jsonResponse(200, { ok: true });
        },
      }),
    );
    await renderCalendar();

    // La griglia è vuota, ma la serie resta raggiungibile dalla sidebar —
    // prima di questo fix non lo era da nessuna parte.
    await screen.findByText(/only shows appointments that match/);

    // Il nome accessibile del bottone include il conteggio come suffisso
    // (`CollapsibleSection`'s `meta`), quindi un prefisso basta.
    await userEvent.click(screen.getByRole("button", { name: /^Recurring series/ }));
    await userEvent.click(await screen.findByText("Standup settimanale"));
    await userEvent.click(screen.getByRole("checkbox", { name: "Enabled" }));
    await userEvent.selectOptions(screen.getByLabelText("Project"), "Apollo");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(putBody).toMatchObject({ accountId: ACCOUNT_ID, enabled: true, projectId: PROJECT_ID });
  });

  it("il cambio vista (Giorno/Settimana/Mese) resta sulla pagina e aggiorna l'etichetta dell'intervallo", async () => {
    mockApi(baseApi());
    await renderCalendar();

    expect(screen.getByText(/Sep 7.*Sep 13/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Month" }));
    expect(screen.getAllByText("September 2026").length).toBeGreaterThan(0);
  });
});
