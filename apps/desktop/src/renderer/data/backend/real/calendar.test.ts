import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { calendar } from "./calendar";
import { session, setAppClientForTests } from "./client";
import { installFakeServer, ME_ID, PROJECT_ID } from "./fakeServer";

// Il Calendario in lettura nella build app (area 6, fetta 1): gli
// appuntamenti che il poller ha VISTO (`/api/me/calendar/range`) e le serie
// riconosciute (`/series`), dentro la finestra letta. Nessuna scrittura verso
// Google (F4): solo la configurazione delle serie, che è di Stubwise.

const ACC = "aaaaaaaa-1111-4111-8111-111111111111";
const EV = "eeeeeeee-1111-4111-8111-111111111111";
const EV2 = "eeeeeeee-2222-4222-8222-222222222222";

const item = (over: Record<string, unknown> = {}) => ({
  id: EV,
  accountId: ACC,
  accountEmail: "ada@acme.test",
  recurringEventId: null,
  projectId: PROJECT_ID,
  projectName: "Audin AI",
  title: "Sprint review",
  organizer: "bob@acme.test",
  attendees: [
    { email: "bob@acme.test", responseStatus: "accepted" },
    { email: "ada@acme.test", responseStatus: "tentative" },
  ],
  startsAt: "2026-11-12T14:00:00.000Z",
  endsAt: "2026-11-12T15:00:00.000Z",
  allDay: false,
  status: "proposed",
  outcome: null,
  error: null,
  url: "https://calendar.google.com/day",
  eventUrl: "https://calendar.google.com/event?eid=1",
  reproposable: false,
  descriptionHtml: "<p>Agenda</p>",
  descriptionText: "Agenda",
  location: "Sala 2",
  hangoutLink: "https://meet.google.com/abc",
  conferenceEntryPoints: [],
  reminders: [{ method: "popup", minutes: 10 }],
  remindersUseDefault: false,
  recurrence: [],
  ...over,
});

const series = (over: Record<string, unknown> = {}) => ({
  accountId: ACC,
  accountEmail: "ada@acme.test",
  recurringEventId: "rec-1",
  title: "Standup",
  occurrenceCount: 12,
  nextOccurrenceAt: "2026-11-13T08:00:00.000Z",
  enabled: false,
  projectId: null,
  projectName: null,
  action: "milestone",
  leadDays: 2,
  auto: false,
  ...over,
});

const account = (over: Record<string, unknown> = {}) => ({
  id: ACC,
  email: "ada@acme.test",
  workspaceId: "11111111-1111-4111-8111-111111111111",
  workspaceName: "Acme",
  scopes: [],
  proposalsEnabled: true,
  connectedAt: "2026-11-01T09:00:00.000Z",
  lastSyncAt: "2026-11-12T09:58:00.000Z",
  disabledAt: null,
  disabledReason: null,
  missingScopes: [],
  ...over,
});

const range = (items: unknown[]) => ({ body: { items, nextCursor: null } });
const query = (path: string) => new URLSearchParams(path.split("?")[1] ?? "");

beforeEach(() => {
  setAppClientForTests(null);
  vi.stubEnv("VITE_STUBWISE_BUILD", "app");
  session.personId = ME_ID;
});
afterEach(() => {
  session.personId = null;
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  setAppClientForTests(null);
});

describe("il Calendario in lettura: gli eventi", () => {
  it("un evento visto: la mia risposta, l'organizzatore, il mio calendario, Meet, promemoria, niente scheda", async () => {
    installFakeServer({ "GET /api/me/calendar/range": range([item()]) });
    const [e] = await calendar.listEvents({ from: "2026-11-12T00:00:00Z", to: "2026-11-13T00:00:00Z" });
    expect(e).toMatchObject({
      id: EV,
      calendarPersonIds: [ME_ID],
      title: "Sprint review",
      description: "Agenda",
      startsAt: "2026-11-12T14:00:00.000Z",
      endsAt: "2026-11-12T15:00:00.000Z",
      allDay: false,
      location: "Sala 2",
      meetUrl: "https://meet.google.com/abc",
      reminders: [{ minutes: 10, method: "popup" }],
      seriesId: null,
      projectId: PROJECT_ID,
      projectBy: "model",
      myResponse: "tentative",
      isOrganizer: false,
      calendarEmail: "ada@acme.test",
      hasPrep: false,
      googleUrl: "https://calendar.google.com/event?eid=1",
    });
    expect(e!.attendees).toEqual([
      { email: "bob@acme.test", name: "bob@acme.test", personId: null, response: "accepted", organizer: true },
      { email: "ada@acme.test", name: "ada@acme.test", personId: ME_ID, response: "tentative", organizer: false },
    ]);
  });

  it("organizzatore io; promemoria predefiniti; una risposta che Google non dice è «da rispondere»; senza eventUrl il link della giornata", async () => {
    installFakeServer({
      "GET /api/me/calendar/range": range([
        item({
          organizer: "ada@acme.test",
          attendees: [{ email: "carl@x.test", responseStatus: null }],
          remindersUseDefault: true,
          reminders: [],
          eventUrl: null,
          hangoutLink: null,
          projectId: null,
          projectName: null,
        }),
      ]),
    });
    const [e] = await calendar.listEvents({ from: "2026-11-12T00:00:00Z", to: "2026-11-13T00:00:00Z" });
    expect(e).toMatchObject({
      isOrganizer: true,
      myResponse: null,
      reminders: "default",
      meetUrl: null,
      projectId: null,
      projectBy: null,
      googleUrl: "https://calendar.google.com/day",
    });
    expect(e!.attendees[0]).toMatchObject({ response: "needsAction", organizer: false });
  });

  it("un'occorrenza di una serie porta l'id della SUA serie (casella + serie Google)", async () => {
    installFakeServer({ "GET /api/me/calendar/range": range([item({ recurringEventId: "rec-1" })]) });
    const [e] = await calendar.listEvents({ from: "2026-11-12T00:00:00Z", to: "2026-11-13T00:00:00Z" });
    expect(e!.seriesId).toBe(`${ACC}:rec-1`);
  });

  it("l'intervallo chiesto si taglia alla finestra letta; dalla più vecchia", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-12T10:00:00Z"));
    const { seen } = installFakeServer({
      "GET /api/me/calendar/range": range([item({ id: EV2, startsAt: "2026-11-12T16:00:00.000Z", endsAt: "2026-11-12T17:00:00.000Z" }), item()]),
    });
    const w = calendar.calendarWindow();
    const list = await calendar.listEvents({ from: "2026-01-01T00:00:00Z", to: "2027-12-01T00:00:00Z" });
    expect(query(seen[0]!.path).get("from")).toBe(w.from);
    expect(query(seen[0]!.path).get("to")).toBe(w.to);
    expect(list.map((e) => e.id)).toEqual([EV, EV2]);
  });

  it("la finestra: da 30 giorni fa a 60 giorni da oggi compresi, a mezzanotti UTC", () => {
    const w = calendar.calendarWindow();
    const days = (Date.parse(w.to) - Date.parse(w.from)) / 86_400_000;
    expect(days).toBe(91);
    expect(w.from).toMatch(/T00:00:00Z$/);
  });

  it("un intervallo non valido è `invalid: range`, senza chiamare il server", async () => {
    const { seen } = installFakeServer({});
    await expect(calendar.listEvents({ from: "x", to: "y" })).rejects.toThrow("invalid: range");
    expect(seen).toHaveLength(0);
  });

  it("un evento senza fine (righe vecchie): un «tutto il giorno» dura il suo giorno, uno con orario resta un istante", async () => {
    installFakeServer({
      "GET /api/me/calendar/range": range([
        item({ endsAt: null }),
        item({ id: EV2, allDay: true, startsAt: "2026-11-12T00:00:00.000Z", endsAt: null }),
      ]),
    });
    const list = await calendar.listEvents({ from: "2026-11-12T00:00:00Z", to: "2026-11-13T00:00:00Z" });
    expect(list.find((e) => e.id === EV2)!.endsAt).toBe("2026-11-13T00:00:00.000Z");
    expect(list.find((e) => e.id === EV)!.endsAt).toBe("2026-11-12T14:00:00.000Z");
  });
});

describe("il Calendario in lettura: un evento, le serie, i calendari", () => {
  it("un evento per id (la rotta della F1.4), con la sua serie", async () => {
    const { seen } = installFakeServer({
      [`GET /api/me/calendar/events/${EV}`]: { body: item({ recurringEventId: "rec-1" }) },
      "GET /api/me/calendar/series": { body: { items: [series()] } },
    });
    const e = await calendar.getEvent(EV);
    expect(e.id).toBe(EV);
    expect(e.series).toMatchObject({ id: `${ACC}:rec-1`, title: "Standup" });
    expect(seen.some((r) => r.path.startsWith("/api/me/calendar/range"))).toBe(false);
  });

  it("un evento altrui o inesistente (404): `not_found`", async () => {
    installFakeServer({
      [`GET /api/me/calendar/events/${EV2}`]: { status: 404, body: { code: "not_found", message: "x" } },
    });
    await expect(calendar.getEvent(EV2)).rejects.toThrow("not_found");
  });

  it("un evento fuori dalla finestra letta: `not_found`, come nel prototipo", async () => {
    installFakeServer({
      [`GET /api/me/calendar/events/${EV}`]: { body: item({ startsAt: "2020-01-01T10:00:00.000Z", endsAt: "2020-01-01T11:00:00.000Z" }) },
    });
    await expect(calendar.getEvent(EV)).rejects.toThrow("not_found");
  });

  it("le serie: spenta di default, il vocabolario delle azioni del prototipo, la prossima data", async () => {
    installFakeServer({
      "GET /api/me/calendar/series": {
        body: {
          items: [
            series(),
            series({ recurringEventId: "rec-2", title: "Board", enabled: true, projectId: PROJECT_ID, action: "backlog_item", auto: true }),
            series({ recurringEventId: "rec-3", title: null, action: "reminder", nextOccurrenceAt: null }),
          ],
        },
      },
    });
    const list = await calendar.listSeries();
    expect(list.map((s) => [s.title, s.action])).toEqual([
      ["", "remind"],
      ["Board", "request"],
      ["Standup", "milestone"],
    ]);
    expect(list.find((s) => s.title === "Standup")).toMatchObject({
      id: `${ACC}:rec-1`,
      rule: "",
      enabled: false,
      projectId: null,
      leadDays: 2,
      auto: false,
      occurrencesInWindow: 12,
      nextAt: "2026-11-13T08:00:00.000Z",
    });
  });

  it("configurare una serie: la configurazione INTERA, con la casella e l'azione del server", async () => {
    const { seen } = installFakeServer({
      "GET /api/me/calendar/series": { body: { items: [series()] } },
      "PUT /api/me/calendar/series/rec-1": { body: { ok: true } },
    });
    await calendar.configureSeries(`${ACC}:rec-1`, { enabled: true, projectId: PROJECT_ID, action: "request" });
    const put = seen.find((r) => r.method === "PUT")!;
    expect(put.body).toEqual({ accountId: ACC, enabled: true, projectId: PROJECT_ID, action: "backlog_item", leadDays: 2, auto: false });
  });

  it("accesa senza progetto: `choose_project_first`, senza scrivere", async () => {
    const { seen } = installFakeServer({ "GET /api/me/calendar/series": { body: { items: [series()] } } });
    await expect(calendar.configureSeries(`${ACC}:rec-1`, { enabled: true })).rejects.toThrow("choose_project_first");
    expect(seen.some((r) => r.method === "PUT")).toBe(false);
  });

  it("una serie che non è fra le mie: `not_found`", async () => {
    installFakeServer({ "GET /api/me/calendar/series": { body: { items: [series()] } } });
    await expect(calendar.configureSeries(`${ACC}:rec-9`, { enabled: false })).rejects.toThrow("not_found");
  });

  it("una casella senza gli scope nuovi legge ancora: non è scaduta (il cassetto chiede di ricollegarla)", async () => {
    installFakeServer({
      "GET /api/me/google/accounts": { body: [account({ missingScopes: ["https://www.googleapis.com/auth/gmail.modify"] })] },
    });
    expect((await calendar.listCalendars())[0]!.expired).toBe(false);
  });

  it("i miei calendari: uno per casella, vecchio oltre 5 minuti, scaduto se va ricollegata", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-12T10:00:00Z"));
    installFakeServer({
      "GET /api/me/google/accounts": {
        body: [account(), account({ id: "aaaaaaaa-2222-4222-8222-222222222222", email: "ada@beta.test", lastSyncAt: "2026-11-12T09:00:00.000Z", disabledAt: "2026-11-11T00:00:00.000Z" })],
      },
    });
    expect(await calendar.listCalendars()).toEqual([
      { personId: ME_ID, email: "ada@acme.test", syncedAt: "2026-11-12T09:58:00.000Z", sync: "ok", stale: false, expired: false },
      { personId: ME_ID, email: "ada@beta.test", syncedAt: "2026-11-12T09:00:00.000Z", sync: "ok", stale: true, expired: true },
    ]);
  });
});

describe("«Prossimi appuntamenti» della Home", () => {
  it("da adesso a fine di domani (giorni locali), senza quelli che ho rifiutato", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-12T10:00:00Z"));
    const { seen } = installFakeServer({
      "GET /api/me/calendar/range": range([
        item(),
        item({ id: EV2, attendees: [{ email: "ada@acme.test", responseStatus: "declined" }] }),
      ]),
    });
    const list = await calendar.listUpcomingEvents();
    expect(list.map((e) => e.id)).toEqual([EV]);
    const q = query(seen[0]!.path);
    expect(q.get("from")).toBe("2026-11-12T10:00:00.000Z");
    const end = new Date(2026, 10, 14);
    expect(q.get("to")).toBe(end.toISOString());
  });
});
