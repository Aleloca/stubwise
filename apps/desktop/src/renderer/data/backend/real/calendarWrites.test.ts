import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { calendar } from "./calendar";
import { calendarWriteFunctions } from "./calendarWrites";
import { session, setAppClientForTests } from "./client";
import { installFakeServer, ME_ID, PROJECT_ID, type SeenRequest } from "./fakeServer";

// Scrivere sul Calendario nella build app (area 6, F4): le rotte della BOZZA
// del piano (`docs/plans/2026-11-12-integrazione-area6-fetta4-plan.md`,
// branch docs/area6-f4-plan), finché 72 non le fissa. Ogni scrittura parte
// da un gesto, risponde dopo il sì di Google e restituisce la riga; gli
// errori nelle parole del prototipo.

const ACC = "aaaaaaaa-1111-4111-8111-111111111111";
const EV = "eeeeeeee-1111-4111-8111-111111111111";
const MARTA = "55555555-5555-4555-8555-555555555555";

const w = calendarWriteFunctions;

const row = (over: Record<string, unknown> = {}) => ({
  id: EV,
  accountId: ACC,
  accountEmail: "ada@acme.test",
  recurringEventId: null,
  projectId: null,
  projectName: null,
  title: "Kick-off",
  organizer: "ada@acme.test",
  attendees: [],
  startsAt: "2026-11-13T09:00:00.000Z",
  endsAt: "2026-11-13T10:00:00.000Z",
  allDay: false,
  status: "new",
  outcome: null,
  error: null,
  url: null,
  eventUrl: null,
  reproposable: false,
  descriptionHtml: null,
  descriptionText: null,
  location: null,
  hangoutLink: null,
  conferenceEntryPoints: [],
  reminders: [],
  remindersUseDefault: true,
  recurrence: [],
  etag: '"e1"',
  canEdit: true,
  canRespond: false,
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
  lastSyncAt: "2026-11-12T09:58:00.000Z",
  disabledAt: null,
  disabledReason: null,
  missingScopes: [],
  syncRequestedAt: null,
};
const base = {
  "GET /api/me/google/accounts": { body: [account] },
  [`GET /api/me/calendar/events/${EV}`]: { body: row() },
};
const posts = (seen: SeenRequest[]) =>
  seen.filter((r) => r.method !== "GET").map((r) => [r.method, r.path, r.body]);

beforeEach(() => {
  setAppClientForTests(null);
  vi.stubEnv("VITE_STUBWISE_BUILD", "app");
  session.personId = ME_ID;
});
afterEach(() => {
  session.personId = null;
  vi.unstubAllEnvs();
  setAppClientForTests(null);
});

describe("F4: creare", () => {
  it("una nuova riunione dalla prima casella collegata, col corpo della bozza del piano; la riga restituita", async () => {
    const { seen } = installFakeServer({
      ...base,
      "POST /api/me/calendar/events": {
        status: 201,
        body: { items: [row({ hangoutLink: "https://meet.google.com/x" })] },
      },
    });
    const e = await w.createEvent!({
      title: "Kick-off",
      startsAt: "2026-11-13T09:00:00.000Z",
      endsAt: "2026-11-13T10:00:00.000Z",
      guests: [{ personId: MARTA }, { email: "bob@client.test", name: "Bob" }],
      addMeet: true,
      projectId: PROJECT_ID,
      reminders: "default",
    });
    expect(posts(seen)).toEqual([
      [
        "POST",
        "/api/me/calendar/events",
        {
          eventId: expect.stringMatching(/^[a-v0-9]{5,1024}$/),
          accountId: ACC,
          title: "Kick-off",
          startsAt: "2026-11-13T09:00:00.000Z",
          endsAt: "2026-11-13T10:00:00.000Z",
          allDay: false,
          guests: [{ personId: MARTA }, { email: "bob@client.test", name: "Bob" }],
          addMeet: true,
          description: null,
          location: null,
          projectId: PROJECT_ID,
          reminders: "default",
        },
      ],
    ]);
    expect(e).toMatchObject({ id: EV, meetUrl: "https://meet.google.com/x" });
  });

  it("senza una casella collegata: `google_not_connected`, senza chiamare", async () => {
    const { seen } = installFakeServer({ "GET /api/me/google/accounts": { body: [] } });
    await expect(
      w.createEvent!({
        title: "x",
        startsAt: "2026-11-13T09:00:00.000Z",
        endsAt: "2026-11-13T10:00:00.000Z",
      }),
    ).rejects.toThrow("google_not_connected");
    expect(posts(seen)).toEqual([]);
  });
});

describe("F4: modificare, spostare, eliminare (con l'etag letto)", () => {
  it("modificare «tutta la serie»: lo scope, l'etag della riga letta e la patch", async () => {
    const { seen } = installFakeServer({
      ...base,
      [`PATCH /api/me/calendar/events/${EV}`]: {
        body: { items: [row({ title: "Kick-off v2", etag: '"e2"' })] },
      },
    });
    const e = await w.updateEvent!(EV, { title: "Kick-off v2" }, "series");
    expect(posts(seen)).toEqual([
      [
        "PATCH",
        `/api/me/calendar/events/${EV}`,
        { scope: "series", etag: '"e1"', patch: { title: "Kick-off v2" } },
      ],
    ]);
    expect(e.title).toBe("Kick-off v2");
  });

  it("spostare: gli orari e l'etag; la volta dopo l'etag è quello nuovo", async () => {
    const { seen } = installFakeServer({
      ...base,
      [`POST /api/me/calendar/events/${EV}/move`]: (req: SeenRequest) => ({
        body: { items: [row({ ...(req.body as Record<string, unknown>), etag: '"e9"' })] },
      }),
    });
    await w.moveEvent!(EV, "2026-11-13T11:00:00.000Z", "2026-11-13T12:00:00.000Z", "one");
    await w.moveEvent!(EV, "2026-11-13T12:00:00.000Z", "2026-11-13T13:00:00.000Z", "one");
    expect(posts(seen).map((p) => (p[2] as { etag: string }).etag)).toEqual(['"e1"', '"e9"']);
    expect(posts(seen)[0]![2]).toMatchObject({
      scope: "one",
      startsAt: "2026-11-13T11:00:00.000Z",
      endsAt: "2026-11-13T12:00:00.000Z",
    });
  });

  it("eliminare: lo scope e l'etag nella query", async () => {
    const { seen } = installFakeServer({
      ...base,
      [`DELETE /api/me/calendar/events/${EV}`]: { status: 204 },
    });
    await w.deleteEvent!(EV, "series");
    const del = seen.find((r) => r.method === "DELETE")!;
    const q = new URLSearchParams(del.path.split("?")[1]);
    expect([q.get("scope"), q.get("etag")]).toEqual(["series", '"e1"']);
  });
});

describe("F4: rispondere e il progetto a mano", () => {
  it("rispondere con la nota, anche a tutta la serie", async () => {
    const { seen } = installFakeServer({
      ...base,
      [`POST /api/me/calendar/events/${EV}/respond`]: {
        body: { items: [row({ canEdit: false, canRespond: true })] },
      },
    });
    await w.respond!(EV, "tentative", "Arrivo tardi", "series");
    expect(posts(seen)).toEqual([
      [
        "POST",
        `/api/me/calendar/events/${EV}/respond`,
        { scope: "series", response: "tentative", note: "Arrivo tardi" },
      ],
    ]);
  });

  it("il progetto a mano", async () => {
    const { seen } = installFakeServer({
      ...base,
      [`PUT /api/me/calendar/events/${EV}/project`]: {
        body: { items: [row({ projectId: PROJECT_ID, projectBy: "manual" })] },
      },
    });
    const e = await w.setEventProject!(EV, PROJECT_ID);
    expect(posts(seen)).toEqual([
      ["PUT", `/api/me/calendar/events/${EV}/project`, { projectId: PROJECT_ID }],
    ]);
    expect(e).toMatchObject({ projectId: PROJECT_ID, projectBy: "manual" });
  });
});

describe("F4: gli errori nelle parole del prototipo", () => {
  // Google non raggiungibile e cambiato su Google non sono un rifiuto: sono un
  // salvataggio non riuscito, con «Retry» e «Undo» (vedi sotto).
  it("ogni rifiuto del server", async () => {
    const cases: [number, Record<string, unknown>, string][] = [
      [400, { code: "outside_window" }, "invalid: window"],
      [400, { code: "all_day_series" }, "invalid: all_day_series"],
      [403, { code: "not_organizer" }, "forbidden"],
      [400, { code: "organizer" }, "invalid: organizer"],
      [400, { code: "not_invited" }, "invalid: not_invited"],
      [
        409,
        {
          code: "google_scope_missing",
          missing: ["https://www.googleapis.com/auth/calendar.events"],
        },
        "google_scope_missing",
      ],
      [409, { code: "token_expired" }, "google_not_connected"],
      [404, { code: "not_found" }, "not_found"],
    ];
    for (const [status, body, error] of cases) {
      installFakeServer({
        ...base,
        [`POST /api/me/calendar/events/${EV}/move`]: { status, body: { message: "x", ...body } },
      });
      await expect(
        w.moveEvent!(EV, "2026-11-13T11:00:00.000Z", "2026-11-13T12:00:00.000Z", "one"),
      ).rejects.toThrow(error);
    }
  });
});

describe("F4: libero/occupato e «Trova un orario» (D8 = b, dalle righe salvate)", () => {
  it("il libero/occupato delle persone, solo intervalli", async () => {
    const { seen } = installFakeServer({
      "GET /api/me/calendar/freebusy": {
        // La forma vera (188b8340 di 72): `{ items }`, con un evento PRIVATO del collega
        // che occupa e un campo in più che non deve passare.
        body: {
          items: [
            {
              personId: MARTA,
              availability: "connected",
              busy: [
                {
                  startsAt: "2026-11-13T09:00:00.000Z",
                  endsAt: "2026-11-13T10:00:00.000Z",
                  title: "Visita privata",
                },
              ],
            },
            { personId: ME_ID, availability: "not_connected", busy: [] },
          ],
        },
      },
    });
    const out = await w.freeBusy!(
      [MARTA, ME_ID],
      "2026-11-13T00:00:00.000Z",
      "2026-11-14T00:00:00.000Z",
    );
    expect(out).toEqual([
      {
        personId: MARTA,
        availability: "connected",
        busy: [{ startsAt: "2026-11-13T09:00:00.000Z", endsAt: "2026-11-13T10:00:00.000Z" }],
      },
      { personId: ME_ID, availability: "not_connected", busy: [] },
    ]);
    const q = new URLSearchParams(seen[0]!.path.split("?")[1]);
    expect(q.get("personIds")).toBe(`${MARTA},${ME_ID}`);
  });

  it("«Trova un orario»: il primo spazio libero per tutti, calcolato qui dal libero/occupato", async () => {
    const from = new Date(2026, 10, 13, 8, 0, 0);
    const busy = (h: number) => ({
      startsAt: new Date(2026, 10, 13, h, 0, 0).toISOString(),
      endsAt: new Date(2026, 10, 13, h + 1, 0, 0).toISOString(),
    });
    installFakeServer({
      "GET /api/me/calendar/freebusy": {
        body: {
          items: [
            { personId: MARTA, availability: "connected", busy: [busy(8), busy(9)] },
            { personId: ME_ID, availability: "connected", busy: [busy(10)] },
          ],
        },
      },
    });
    const slot = await w.findFirstFreeSlot!([MARTA, ME_ID], 60, from.toISOString());
    expect(slot).toEqual({
      startsAt: new Date(2026, 10, 13, 11, 0, 0).toISOString().replace(/\.\d{3}Z$/, "Z"),
      endsAt: new Date(2026, 10, 13, 12, 0, 0).toISOString().replace(/\.\d{3}Z$/, "Z"),
    });
  });
});

describe("F4: il salvataggio verso Google (Q2 = a: sincrono, il «non riuscito» lo tiene il client)", () => {
  const range = (rows: unknown[]) => ({ body: { items: rows, nextCursor: null } });
  const list = () =>
    calendar.listEvents({ from: "2026-11-13T00:00:00Z", to: "2026-11-14T00:00:00Z" });
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-12T10:00:00Z"));
  });
  afterEach(() => vi.useRealTimers());

  it("mentre Google risponde l'evento è già al posto nuovo con «Saving…»; poi salvato", async () => {
    let release: () => void = () => undefined;
    installFakeServer({
      ...base,
      "GET /api/me/calendar/range": range([row()]),
      [`POST /api/me/calendar/events/${EV}/move`]: (req: SeenRequest) =>
        new Promise((resolve) => {
          release = () =>
            resolve({
              body: { items: [row({ ...(req.body as Record<string, unknown>), etag: '"e2"' })] },
            });
        }),
    });
    const moving = w.moveEvent!(EV, "2026-11-13T11:00:00.000Z", "2026-11-13T12:00:00.000Z", "one");
    await vi.waitFor(async () =>
      expect((await list())[0]).toMatchObject({
        startsAt: "2026-11-13T11:00:00.000Z",
        save: { state: "saving" },
      }),
    );
    release();
    expect(await moving).toMatchObject({
      startsAt: "2026-11-13T11:00:00.000Z",
      save: { state: "saved" },
    });
    expect((await list())[0]!.save).toBeUndefined();
  });

  it("Google non raggiungibile: resta al posto nuovo con «Couldn't save»; «Retry» rimanda la stessa richiesta", async () => {
    let fail = true;
    const { seen } = installFakeServer({
      ...base,
      "GET /api/me/calendar/range": range([row()]),
      [`POST /api/me/calendar/events/${EV}/move`]: (req: SeenRequest) =>
        fail
          ? { status: 502, body: { code: "google_unavailable", message: "x" } }
          : { body: { items: [row({ ...(req.body as Record<string, unknown>) })] } },
    });
    const e = await w.moveEvent!(EV, "2026-11-13T11:00:00.000Z", "2026-11-13T12:00:00.000Z", "one");
    expect(e.save).toEqual({ state: "failed", error: "unreachable" });
    expect((await list())[0]).toMatchObject({
      startsAt: "2026-11-13T11:00:00.000Z",
      save: { state: "failed" },
    });
    fail = false;
    expect((await w.retrySave!(EV)).save).toEqual({ state: "saved" });
    const moves = seen.filter((r) => r.path.endsWith("/move"));
    expect(moves.map((m) => (m.body as { startsAt: string }).startsAt)).toEqual([
      "2026-11-13T11:00:00.000Z",
      "2026-11-13T11:00:00.000Z",
    ]);
  });

  it("«Undo the change»: torna com'era sul server, nessuna richiesta in più", async () => {
    const { seen } = installFakeServer({
      ...base,
      "GET /api/me/calendar/range": range([row()]),
      [`POST /api/me/calendar/events/${EV}/move`]: {
        status: 502,
        body: { code: "google_unavailable", message: "x" },
      },
    });
    await w.moveEvent!(EV, "2026-11-13T11:00:00.000Z", "2026-11-13T12:00:00.000Z", "one");
    const writes = seen.filter((r) => r.method !== "GET").length;
    await w.revertEvent!(EV);
    expect((await list())[0]).toMatchObject({ startsAt: "2026-11-13T09:00:00.000Z" });
    expect((await list())[0]!.save).toBeUndefined();
    expect(seen.filter((r) => r.method !== "GET").length).toBe(writes);
  });

  it("cambiato su Google nel frattempo: «non salvato» con l'errore `changed` (la pagina offre «Reload», Q4)", async () => {
    installFakeServer({
      ...base,
      "GET /api/me/calendar/range": range([row()]),
      [`POST /api/me/calendar/events/${EV}/move`]: {
        status: 409,
        body: { code: "changed_on_google", message: "x" },
      },
    });
    expect(
      (await w.moveEvent!(EV, "2026-11-13T11:00:00.000Z", "2026-11-13T12:00:00.000Z", "one")).save,
    ).toEqual({ state: "failed", error: "changed" });
  });

  it("un rifiuto che il gesto non doveva fare (fuori finestra, non organizzatore): si dice subito, nessun «non salvato»", async () => {
    installFakeServer({
      ...base,
      "GET /api/me/calendar/range": range([row()]),
      [`POST /api/me/calendar/events/${EV}/move`]: {
        status: 400,
        body: { code: "outside_window", message: "x" },
      },
    });
    await expect(
      w.moveEvent!(EV, "2026-11-13T11:00:00.000Z", "2026-11-13T12:00:00.000Z", "one"),
    ).rejects.toThrow("invalid: window");
    expect((await list())[0]!.save).toBeUndefined();
  });
});

describe("F4: la risposta delle scritture è un elenco (`{ items }`, calendarWriteResultSchema di 72)", () => {
  it("«tutta la serie»: l'elenco delle date; la vista è quella dell'evento toccato, o — se il suo id è cambiato — la data con l'orario chiesto", async () => {
    const OTHER = "eeeeeeee-9999-4999-8999-999999999999";
    installFakeServer({
      ...base,
      [`POST /api/me/calendar/events/${EV}/move`]: {
        body: {
          items: [
            row({
              id: OTHER,
              startsAt: "2026-11-13T11:00:00.000Z",
              endsAt: "2026-11-13T12:00:00.000Z",
            }),
          ],
        },
      },
    });
    const e = await w.moveEvent!(
      EV,
      "2026-11-13T11:00:00.000Z",
      "2026-11-13T12:00:00.000Z",
      "series",
    );
    expect(e).toMatchObject({ id: OTHER, startsAt: "2026-11-13T11:00:00.000Z" });
  });

  it("la fine prima dell'inizio (400 `invalid_range`): «invalid: time»", async () => {
    installFakeServer({
      ...base,
      [`POST /api/me/calendar/events/${EV}/move`]: {
        status: 400,
        body: { code: "invalid_range", message: "x" },
      },
    });
    await expect(
      w.moveEvent!(EV, "2026-11-13T12:00:00.000Z", "2026-11-13T11:00:00.000Z", "one"),
    ).rejects.toThrow("invalid: time");
  });
});

describe("F4: l'id della riunione nuova (d1bd1fc2 di 72): uno per bozza, lo stesso a ogni tentativo", () => {
  const input = (draftId?: string) => ({
    title: "Kick-off",
    startsAt: "2026-11-13T09:00:00.000Z",
    endsAt: "2026-11-13T10:00:00.000Z",
    ...(draftId ? { draftId } : {}),
  });
  it("la bozza dà l'id: un secondo tentativo dopo un errore manda LO STESSO", async () => {
    let calls = 0;
    const { seen } = installFakeServer({
      ...base,
      "POST /api/me/calendar/events": () =>
        ++calls === 1
          ? { status: 500, body: { code: "internal", message: "x" } }
          : { status: 201, body: { items: [row()] } },
    });
    const draft = "0123456789abcdef0123456789abcdef";
    await expect(w.createEvent!(input(draft))).rejects.toBeTruthy();
    await w.createEvent!(input(draft));
    const ids = seen
      .filter((r) => r.method === "POST")
      .map((r) => (r.body as { eventId: string }).eventId);
    expect(ids).toEqual([draft, draft]);
  });

  it("senza bozza (un chiamante di prima): un id valido per Google, base32hex", async () => {
    const { seen } = installFakeServer({
      ...base,
      "POST /api/me/calendar/events": { status: 201, body: { items: [row()] } },
    });
    await w.createEvent!(input());
    expect((seen.find((r) => r.method === "POST")!.body as { eventId: string }).eventId).toMatch(
      /^[a-v0-9]{5,1024}$/,
    );
  });
});

describe("F4: il libero/occupato col metodo (188b8340 di 72)", () => {
  it("oltre 50 persone o 31 giorni (400 `range_too_wide`): «invalid: range»", async () => {
    installFakeServer({
      "GET /api/me/calendar/freebusy": {
        status: 400,
        body: { code: "range_too_wide", message: "x" },
      },
    });
    await expect(
      w.freeBusy!([MARTA], "2026-11-01T00:00:00.000Z", "2026-12-31T00:00:00.000Z"),
    ).rejects.toThrow("invalid: range");
  });
});

describe("review F4 (critico): l'etag non resta vecchio", () => {
  it("cambiato su Google → «Reload» → la scrittura dopo parte con l'etag FRESCO e riesce", async () => {
    let serverEtag = '"e1"';
    const { seen } = installFakeServer({
      ...base,
      [`GET /api/me/calendar/events/${EV}`]: () => ({ body: row({ etag: serverEtag }) }),
      "GET /api/me/calendar/range": () => ({
        body: { items: [row({ etag: serverEtag })], nextCursor: null },
      }),
      [`POST /api/me/calendar/events/${EV}/move`]: (req: SeenRequest) =>
        (req.body as { etag: string }).etag === serverEtag
          ? { body: { items: [row({ ...(req.body as Record<string, unknown>), etag: '"e3"' })] } }
          : { status: 409, body: { code: "changed_on_google", message: "x" } },
    });
    await w.moveEvent!(EV, "2026-11-13T11:00:00.000Z", "2026-11-13T12:00:00.000Z", "one");
    // Google cambia l'etag (un invitato risponde) e il poller riscrive la riga.
    serverEtag = '"e7"';
    const failed = await w.moveEvent!(
      EV,
      "2026-11-13T12:00:00.000Z",
      "2026-11-13T13:00:00.000Z",
      "one",
    );
    expect(failed.save).toEqual({ state: "failed", error: "changed" });
    await w.revertEvent!(EV);
    const ok = await w.moveEvent!(
      EV,
      "2026-11-13T12:00:00.000Z",
      "2026-11-13T13:00:00.000Z",
      "one",
    );
    expect(ok.save).toEqual({ state: "saved" });
    expect(
      seen
        .filter((r) => r.path.endsWith("/move"))
        .map((r) => (r.body as { etag: string }).etag)
        .at(-1),
    ).toBe('"e7"');
  });

  it("una lettura della griglia porta l'etag fresco: la scrittura dopo usa quello", async () => {
    const { seen } = installFakeServer({
      ...base,
      "GET /api/me/calendar/range": { body: { items: [row({ etag: '"e5"' })], nextCursor: null } },
      [`POST /api/me/calendar/events/${EV}/move`]: (req: SeenRequest) => ({
        body: { items: [row({ ...(req.body as Record<string, unknown>) })] },
      }),
    });
    await w.moveEvent!(EV, "2026-11-13T11:00:00.000Z", "2026-11-13T12:00:00.000Z", "one");
    await calendar.listEvents({ from: "2026-11-13T00:00:00Z", to: "2026-11-14T00:00:00Z" });
    await w.moveEvent!(EV, "2026-11-13T12:00:00.000Z", "2026-11-13T13:00:00.000Z", "one");
    expect(
      seen
        .filter((r) => r.path.endsWith("/move"))
        .map((r) => (r.body as { etag: string }).etag)
        .at(-1),
    ).toBe('"e5"');
  });
});

describe("review F4 (5): «Saving…» si vede SUBITO, e le scritture dello stesso evento vanno in fila", () => {
  it("chi ascolta (la cache delle query) riceve l'evento in salvataggio PRIMA che Google risponda", async () => {
    let release: () => void = () => undefined;
    installFakeServer({
      ...base,
      [`POST /api/me/calendar/events/${EV}/move`]: (req: SeenRequest) =>
        new Promise((resolve) => {
          release = () =>
            resolve({ body: { items: [row({ ...(req.body as Record<string, unknown>) })] } });
        }),
    });
    const heard: { startsAt: string; save?: unknown }[] = [];
    const off = calendar.onSaving((e) => heard.push({ startsAt: e.startsAt, save: e.save }));
    const moving = w.moveEvent!(EV, "2026-11-13T11:00:00.000Z", "2026-11-13T12:00:00.000Z", "one");
    await vi.waitFor(() =>
      expect(heard).toEqual([{ startsAt: "2026-11-13T11:00:00.000Z", save: { state: "saving" } }]),
    );
    release();
    await moving;
    off();
  });

  it("due spostamenti dello stesso evento: il secondo parte DOPO il primo, con l'etag nuovo", async () => {
    let live = 0;
    let most = 0;
    const { seen } = installFakeServer({
      ...base,
      [`POST /api/me/calendar/events/${EV}/move`]: async (req: SeenRequest) => {
        live += 1;
        most = Math.max(most, live);
        await new Promise((r) => setTimeout(r, 20));
        live -= 1;
        const n = seen.filter((x) => x.path.endsWith("/move")).length;
        return {
          body: { items: [row({ ...(req.body as Record<string, unknown>), etag: `"e${n + 1}"` })] },
        };
      },
    });
    await Promise.all([
      w.moveEvent!(EV, "2026-11-13T11:00:00.000Z", "2026-11-13T12:00:00.000Z", "one"),
      w.moveEvent!(EV, "2026-11-13T12:00:00.000Z", "2026-11-13T13:00:00.000Z", "one"),
    ]);
    expect(most).toBe(1);
    const etags = seen
      .filter((r) => r.path.endsWith("/move"))
      .map((r) => (r.body as { etag: string }).etag);
    expect(etags[1]).not.toBe(etags[0]);
  });
});

describe("contratto di 72 (review F4, punto 12): «tutto il giorno» viaggia come DATE, con la fine esclusa", () => {
  it("creare tutto il giorno: `YYYY-MM-DD`, mai la mezzanotte come istante", async () => {
    const { seen } = installFakeServer({
      ...base,
      "POST /api/me/calendar/events": { status: 201, body: { items: [row()] } },
    });
    await w.createEvent!({
      title: "Offsite",
      startsAt: "2026-11-15T00:00:00.000Z",
      endsAt: "2026-11-16T00:00:00.000Z",
      allDay: true,
    });
    expect(posts(seen)[0]![2]).toMatchObject({
      startsAt: "2026-11-15",
      endsAt: "2026-11-16",
      allDay: true,
    });
  });

  it("creare con orario: restano istanti", async () => {
    const { seen } = installFakeServer({
      ...base,
      "POST /api/me/calendar/events": { status: 201, body: { items: [row()] } },
    });
    await w.createEvent!({
      title: "Kick-off",
      startsAt: "2026-11-13T09:00:00.000Z",
      endsAt: "2026-11-13T10:00:00.000Z",
    });
    expect(posts(seen)[0]![2]).toMatchObject({
      startsAt: "2026-11-13T09:00:00.000Z",
      endsAt: "2026-11-13T10:00:00.000Z",
    });
  });

  it("spostare un evento tutto il giorno senza dirlo: decide la riga, e le date sono date", async () => {
    const { seen } = installFakeServer({
      ...base,
      [`GET /api/me/calendar/events/${EV}`]: {
        body: row({
          allDay: true,
          startsAt: "2026-11-13T00:00:00.000Z",
          endsAt: "2026-11-14T00:00:00.000Z",
        }),
      },
      [`POST /api/me/calendar/events/${EV}/move`]: { body: { items: [row({ allDay: true })] } },
    });
    await w.moveEvent!(EV, "2026-11-15T00:00:00.000Z", "2026-11-16T00:00:00.000Z", "one");
    expect(posts(seen)[0]![2]).toMatchObject({ startsAt: "2026-11-15", endsAt: "2026-11-16" });
  });

  it("spostare dicendo «tutto il giorno»: date anche se la riga aveva l'orario", async () => {
    const { seen } = installFakeServer({
      ...base,
      [`POST /api/me/calendar/events/${EV}/move`]: { body: { items: [row({ allDay: true })] } },
    });
    await w.moveEvent!(EV, "2026-11-15T00:00:00.000Z", "2026-11-16T00:00:00.000Z", "one", true);
    expect(posts(seen)[0]![2]).toEqual(
      expect.objectContaining({ startsAt: "2026-11-15", endsAt: "2026-11-16", allDay: true }),
    );
  });
});

describe("review F4 (minore): spostata la serie, torna la data spostata, non la prima dell'elenco", () => {
  it("nessun id coincide: si sceglie l'occorrenza con l'orario chiesto", async () => {
    installFakeServer({
      ...base,
      [`POST /api/me/calendar/events/${EV}/move`]: {
        body: {
          items: [
            row({ id: "aaaaaaaa-1111-4111-8111-111111111111", startsAt: "2026-11-06T11:00:00Z", endsAt: "2026-11-06T12:00:00Z" }),
            row({ id: "bbbbbbbb-2222-4222-8222-222222222222", startsAt: "2026-11-13T11:00:00Z", endsAt: "2026-11-13T12:00:00Z" }),
          ],
        },
      },
    });
    const e = await w.moveEvent!(
      EV,
      "2026-11-13T11:00:00.000Z",
      "2026-11-13T12:00:00.000Z",
      "series",
    );
    expect(e.id).toBe("bbbbbbbb-2222-4222-8222-222222222222");
  });
});
