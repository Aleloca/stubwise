import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { calendarEventItemSchema } from "@stubwise/shared";
import { now } from "../../dates";
import { renderRoute } from "../../../test/renderRoute";
import { setAppClientForTests } from "./client";
import {
  calendarRangeRoute,
  installFakeServer,
  me,
  ME_ID,
  PROJECT_ID,
  serverProject,
  type SeenRequest,
} from "./fakeServer";

// Il Calendario nella build app (area 6, fetta 1), davanti a un server finto:
// in LETTURA. Nessun gesto che scrive su Google (nuova riunione, sposta,
// modifica, elimina, rispondi, progetto a mano: F4), niente note della
// riunione (F5); «Aggiorna ora» c'è dalla F1.2. Le serie si
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
  seen = installFakeServerWith();
});

/** Il server finto della pagina, con le rotte in più (o diverse) di un test. */
function installFakeServerWith(extra: Record<string, unknown> = {}): SeenRequest[] {
  const byIdOf = (req: SeenRequest) => byId(req.path.split("/")[5]!.split("?")[0]!);
  return installFakeServer({
    "GET /api/auth/me": { body: me() },
    "GET /api/projects": { body: [serverProject({ memberIds: [ME_ID] })] },
    "GET /api/me/follows": { body: { projectIds: [PROJECT_ID] } },
    "GET /api/people": {
      body: [
        { id: ME_ID, name: "Ada", initials: "AD", departmentIds: [], email: "ada@example.com" },
      ],
    },
    "GET /api/departments": { body: [] },
    "GET /api/inbox": { body: { items: [], nextCursor: null } },
    "GET /api/me/google/accounts": { body: [account] },
    "GET /api/me/calendar/range": (req: SeenRequest) => calendarRangeRoute(events)(req),
    // F1.4: un evento per id; uno che non è fra i miei è 404, come sul server.
    [`GET /api/me/calendar/events/${EV}`]: () => byId(EV),
    [`GET /api/me/calendar/events/${PAST}`]: () => byId(PAST),
    "GET /api/me/calendar/series": { body: { items: [] } },
    [`POST /api/me/google/accounts/${ACC}/sync`]: { status: 202, body: { status: "queued" } },
    // F4: le scritture della bozza del piano, che rispondono con la riga come il server vero.
    [`POST /api/me/calendar/events/${EV}/respond`]: (req: SeenRequest) => ({
      body: {
        ...(byIdOf(req).body as object),
        myResponse: (req.body as { response: string }).response,
      },
    }),
    [`PUT /api/me/calendar/events/${EV}/project`]: (req: SeenRequest) => ({
      body: {
        ...(byIdOf(req).body as object),
        projectId: (req.body as { projectId: string | null }).projectId,
        projectBy: "manual",
      },
    }),
    [`DELETE /api/me/calendar/events/${EV}`]: { status: 204 },
    ...extra,
  } as Parameters<typeof installFakeServer>[0]).seen;
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  setAppClientForTests(null);
});

describe("il Calendario nella build app", () => {
  it("si apre, con gli eventi visti; con «New meeting» (F4)", async () => {
    renderRoute("/calendar");
    await screen.findByRole("heading", { level: 1, name: "Calendar" });
    expect(await screen.findAllByText("Sprint review")).not.toHaveLength(0);
    expect(screen.getByRole("button", { name: "New meeting" })).toBeInTheDocument();
  });

  it("«Aggiorna ora» (F1.2) chiede il giro della casella", async () => {
    renderRoute("/calendar");
    await screen.findAllByText("Sprint review");
    fireEvent.click(screen.getByRole("button", { name: "Refresh now" }));
    await waitFor(() =>
      expect(seen.filter((r) => r.method === "POST").map((r) => r.path)).toEqual([
        `/api/me/google/accounts/${ACC}/sync`,
      ]),
    );
  });

  it("F4: l'organizzatore (canEdit dal server) ha «Edit» e «Delete»; «Apri in Google Calendar» apre l'evento", async () => {
    const open = vi.fn();
    window.open = open as never;
    events = [item({ canEdit: true, canRespond: false })];
    renderRoute(`/calendar?event=${EV}`);
    const panel = await eventPanel();
    await within(panel).findByRole("heading", { name: "Sprint review" });
    expect(within(panel).getByRole("button", { name: "Edit" })).toBeInTheDocument();
    expect(within(panel).queryByRole("group", { name: "Going?" })).toBeNull();
    fireEvent.click(within(panel).getByRole("button", { name: /Open in Google Calendar/ }));
    expect(open).toHaveBeenCalledWith(
      "https://calendar.google.com/event?eid=1",
      "_blank",
      "noopener",
    );
  });

  // Si accende da sé quando lo schema condiviso porta `canEdit` (task 1 del piano della F4,
  // di 72): oggi il client lo toglie al parse e vale il ripiego dell'organizzatore.
  it.skipIf(!("canEdit" in calendarEventItemSchema.shape))(
    "F4: se il server dice che non posso modificare (canEdit false), niente «Edit» anche da organizzatore",
    async () => {
      events = [item({ canEdit: false, canRespond: false })];
      renderRoute(`/calendar?event=${EV}`);
      const panel = await eventPanel();
      await within(panel).findByRole("heading", { name: "Sprint review" });
      expect(within(panel).queryByRole("button", { name: "Edit" })).toBeNull();
    },
  );

  it("F4: un invitato (canRespond dal server) risponde «Maybe»: la richiesta esatta", async () => {
    events = [item({ organizer: "bob@acme.test", canEdit: false, canRespond: true })];
    renderRoute(`/calendar?event=${EV}`);
    const panel = await eventPanel();
    const going = await within(panel).findByRole("group", { name: "Going?" });
    fireEvent.click(within(going).getByRole("button", { name: "Maybe" }));
    await waitFor(() =>
      expect(
        seen.find((r) => r.method === "POST" && r.path === `/api/me/calendar/events/${EV}/respond`)
          ?.body,
      ).toEqual({
        scope: "one",
        response: "tentative",
      }),
    );
    expect(within(panel).queryByRole("button", { name: "Edit" })).toBeNull();
  });

  it("una riunione passata: nessun riassunto né task nate (F5), nessuna lettura non integrata", async () => {
    renderRoute(`/calendar?event=${PAST}`);
    const panel = await eventPanel();
    await within(panel).findByRole("heading", { name: "Retro" });
    expect(panel).not.toHaveTextContent(/summary|Tasks from this meeting/i);
    expect(seen.every((r) => !r.path.includes("transcript"))).toBe(true);
  });
});

describe("F3b (review): il tipo e il libero a PAROLA anche nel mese e nella striscia del tutto il giorno", () => {
  const ALL = "eeeeeeee-7777-4777-8777-777777777777";
  const OOO = "eeeeeeee-8888-4888-8888-888888888888";
  /** Domani, come giorno locale e come mezzanotte UTC (un «tutto il giorno» è una DATA). */
  const tomorrow = () => {
    const d = new Date(now());
    d.setDate(d.getDate() + 1);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    return {
      key,
      start: `${key}T00:00:00.000Z`,
      end: new Date(Date.parse(`${key}T00:00:00.000Z`) + 86_400_000).toISOString(),
    };
  };
  const blockText = (id: string) =>
    [...document.querySelectorAll<HTMLElement>(`[data-event-block="${id}"]`)]
      .map((b) => b.textContent ?? "")
      .join(" | ");

  beforeEach(() => {
    const day = tomorrow();
    events = [
      item({
        id: ALL,
        title: "Ferie",
        allDay: true,
        startsAt: day.start,
        endsAt: day.end,
        transparency: "transparent",
        projectId: null,
        projectName: null,
      }),
      item({
        id: OOO,
        title: "Dal medico",
        eventType: "outOfOffice",
        startsAt: at(1, 9),
        endsAt: at(1, 10),
        projectId: null,
        projectName: null,
      }),
    ];
  });

  it("settimana: un tutto il giorno libero NON dice «Free» (è il default di Google, O di 46)", async () => {
    renderRoute(`/calendar?view=week&date=${tomorrow().key}`);
    await waitFor(() => expect(blockText(ALL)).toContain("Ferie"));
    expect(blockText(ALL)).not.toContain("Free");
  });

  it("mese: «Out of office» a parola nella riga; il tutto il giorno libero senza «Free»", async () => {
    renderRoute(`/calendar?view=month&date=${tomorrow().key}`);
    await waitFor(() => expect(blockText(OOO)).toContain("Dal medico"));
    expect(blockText(OOO)).toContain("Out of office");
    await waitFor(() => expect(blockText(ALL)).toContain("Ferie"));
    expect(blockText(ALL)).not.toContain("Free");
  });
});

describe("F3b (review, 5): il dettaglio dice il tipo dell'evento", () => {
  it("un fuori ufficio: «Out of office» sotto l'orario", async () => {
    events = [item({ eventType: "outOfOffice" })];
    renderRoute(`/calendar?event=${EV}`);
    const panel = await eventPanel();
    expect(await within(panel).findByText("Out of office")).toBeInTheDocument();
  });

  it("un evento normale: nessuna parola del tipo", async () => {
    events = [item()];
    renderRoute(`/calendar?event=${EV}`);
    const panel = await eventPanel();
    await within(panel).findByText("Sprint review");
    for (const w of ["Out of office", "Focus time", "Free"])
      expect(within(panel).queryByText(w)).toBeNull();
  });
});

describe("F4: il salvataggio verso Google dalla pagina", () => {
  const RESPOND = `POST /api/me/calendar/events/${EV}/respond`;
  it("Google non raggiungibile: «Couldn't save» con «Retry», che rimanda la risposta", async () => {
    let fail = true;
    events = [item({ organizer: "bob@acme.test", canEdit: false, canRespond: true })];
    seen = installFakeServerWith({
      [RESPOND]: (req: SeenRequest) =>
        fail
          ? { status: 502, body: { code: "google_unavailable", message: "x" } }
          : {
              body: {
                ...item({ organizer: "bob@acme.test" }),
                myResponse: (req.body as { response: string }).response,
              },
            },
    });
    renderRoute(`/calendar?event=${EV}`);
    const panel = await eventPanel();
    fireEvent.click(
      within(await within(panel).findByRole("group", { name: "Going?" })).getByRole("button", {
        name: "No",
      }),
    );
    expect(
      await within(panel).findByText("Google couldn't be reached. The change isn't saved yet."),
    ).toBeInTheDocument();
    fail = false;
    fireEvent.click(within(panel).getByRole("button", { name: "Retry" }));
    await waitFor(() =>
      expect(seen.filter((r) => r.method === "POST" && r.path.endsWith("/respond"))).toHaveLength(
        2,
      ),
    );
  });

  it("cambiato su Google nel frattempo: lo dice e offre solo «Reload» (Q4)", async () => {
    events = [item({ canEdit: true })];
    seen = installFakeServerWith({
      [`PUT /api/me/calendar/events/${EV}/project`]: {
        status: 409,
        body: { code: "changed_on_google", message: "x" },
      },
    });
    renderRoute(`/calendar?event=${EV}`);
    const panel = await eventPanel();
    await within(panel).findByRole("heading", { name: "Sprint review" });
    fireEvent.click(within(panel).getByRole("button", { name: /^(Change|Choose)$/ }));
    fireEvent.click(await screen.findByRole("menuitemradio", { name: /AUD|Audin/ }));
    expect(
      await within(panel).findByText(
        "This meeting changed in Google Calendar. Reload it and try again.",
      ),
    ).toBeInTheDocument();
    expect(within(panel).getByRole("button", { name: "Reload" })).toBeInTheDocument();
    expect(within(panel).queryByRole("button", { name: "Retry" })).toBeNull();
  });
});
