import { fireEvent, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { now } from "../../dates";
import { renderRoute } from "../../../test/renderRoute";
import { setAppClientForTests } from "./client";
import { installFakeServer, me, ME_ID, PROJECT_ID, serverProject, type SeenRequest } from "./fakeServer";

// Il Calendario nella build app (area 6, fetta 1), davanti a un server finto:
// in LETTURA. Nessun gesto che scrive su Google (nuova riunione, sposta,
// modifica, elimina, rispondi, progetto a mano: F4), niente «Aggiorna ora»
// finché la F1.2 non c'è, niente note della riunione (F5). Le serie si
// configurano (sono di Stubwise). «Apri in Google Calendar» apre l'evento.
vi.mock("@backend/api", async () => await import("./index"));

const ACC = "aaaaaaaa-1111-4111-8111-111111111111";
const EV = "eeeeeeee-1111-4111-8111-111111111111";
const PAST = "eeeeeeee-2222-4222-8222-222222222222";

/** Le 14 locali di `days` giorni da oggi (l'oggi della pagina: `@backend/clock`). */
function at(days: number, hour = 14): string {
  const d = new Date(now());
  d.setHours(hour, 0, 0, 0);
  d.setDate(d.getDate() + days);
  return d.toISOString();
}

const item = (over: Record<string, unknown> = {}) => ({
  id: EV,
  accountId: ACC,
  accountEmail: "ada@acme.test",
  recurringEventId: null,
  projectId: PROJECT_ID,
  projectName: "Audin AI",
  title: "Sprint review",
  organizer: "ada@acme.test",
  attendees: [
    { email: "ada@acme.test", responseStatus: "accepted" },
    { email: "bob@acme.test", responseStatus: "needsAction" },
  ],
  startsAt: at(1),
  endsAt: at(1, 15),
  allDay: false,
  status: "proposed",
  outcome: null,
  error: null,
  url: "https://calendar.google.com/day",
  eventUrl: "https://calendar.google.com/event?eid=1",
  reproposable: false,
  descriptionHtml: null,
  descriptionText: "Agenda",
  location: null,
  hangoutLink: null,
  conferenceEntryPoints: [],
  reminders: [],
  remindersUseDefault: true,
  recurrence: [],
  ...over,
});

const account = {
  id: ACC,
  email: "ada@acme.test",
  workspaceId: "11111111-1111-4111-8111-111111111111",
  workspaceName: "Acme",
  scopes: [],
  proposalsEnabled: true,
  connectedAt: "2026-11-01T09:00:00.000Z",
  lastSyncAt: new Date().toISOString(),
  disabledAt: null,
  disabledReason: null,
  missingScopes: [],
};

/** Il pannello dell'evento: in questa larghezza un foglio modale sopra la griglia. */
const eventPanel = () => screen.findByRole("dialog", { name: "Event" });

let events: unknown[] = [];
const byId = (id: string) => {
  const found = events.find((e) => (e as { id: string }).id === id);
  return found ? { body: found } : { status: 404, body: { code: "not_found", message: "x" } };
};
let seen: SeenRequest[] = [];

beforeEach(() => {
  setAppClientForTests(null);
  vi.stubEnv("VITE_STUBWISE_BUILD", "app");
  events = [item(), item({ id: PAST, title: "Retro", startsAt: at(-1), endsAt: at(-1, 15) })];
  seen = installFakeServer({
    "GET /api/auth/me": { body: me() },
    "GET /api/projects": { body: [serverProject({ memberIds: [ME_ID] })] },
    "GET /api/me/follows": { body: { projectIds: [PROJECT_ID] } },
    "GET /api/people": { body: [{ id: ME_ID, name: "Ada", initials: "AD", departmentIds: [], email: "ada@example.com" }] },
    "GET /api/departments": { body: [] },
    "GET /api/inbox": { body: { items: [], nextCursor: null } },
    "GET /api/me/google/accounts": { body: [account] },
    "GET /api/me/calendar/range": () => ({ body: { items: events, nextCursor: null } }),
    // F1.4: un evento per id; uno che non è fra i miei è 404, come sul server.
    [`GET /api/me/calendar/events/${EV}`]: () => byId(EV),
    [`GET /api/me/calendar/events/${PAST}`]: () => byId(PAST),
    "GET /api/me/calendar/series": { body: { items: [] } },
  }).seen;
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  setAppClientForTests(null);
});

describe("il Calendario nella build app", () => {
  it("si apre, con gli eventi visti; niente «Nuova riunione» né «Aggiorna ora»", async () => {
    renderRoute("/calendar");
    await screen.findByRole("heading", { level: 1, name: "Calendar" });
    expect(await screen.findAllByText("Sprint review")).not.toHaveLength(0);
    expect(screen.queryByRole("button", { name: "New meeting" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Refresh now" })).toBeNull();
  });

  it("il dettaglio in lettura: niente modifica, elimina, risposta, progetto a mano; «Apri in Google Calendar» apre l'evento", async () => {
    const open = vi.fn();
    window.open = open as never;
    renderRoute(`/calendar?event=${EV}`);
    const panel = await eventPanel();
    await within(panel).findByRole("heading", { name: "Sprint review" });
    expect(within(panel).queryByRole("button", { name: "Edit" })).toBeNull();
    expect(within(panel).queryByRole("button", { name: /Delete|More actions/ })).toBeNull();
    expect(within(panel).queryByRole("group", { name: "Going?" })).toBeNull();
    expect(within(panel).queryByRole("button", { name: /^(Change|Choose)$/ })).toBeNull();
    fireEvent.click(within(panel).getByRole("button", { name: /Open in Google Calendar/ }));
    expect(open).toHaveBeenCalledWith("https://calendar.google.com/event?eid=1", "_blank", "noopener");
  });

  it("un invitato: niente «Andrai?» né la frase «puoi cambiare solo la tua risposta»", async () => {
    events = [item({ organizer: "bob@acme.test" })];
    renderRoute(`/calendar?event=${EV}`);
    const panel = await eventPanel();
    await within(panel).findByRole("heading", { name: "Sprint review" });
    expect(within(panel).queryByRole("group", { name: "Going?" })).toBeNull();
    expect(panel).not.toHaveTextContent("you can change only your answer");
  });

  it("una riunione passata: nessun riassunto né task nate (F5), nessuna lettura non integrata", async () => {
    renderRoute(`/calendar?event=${PAST}`);
    const panel = await eventPanel();
    await within(panel).findByRole("heading", { name: "Retro" });
    expect(panel).not.toHaveTextContent(/summary|Tasks from this meeting/i);
    expect(seen.every((r) => !r.path.includes("transcript"))).toBe(true);
  });
});
