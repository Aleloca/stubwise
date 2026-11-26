import { describe, expect, it, vi } from "vitest";
import { composeMeetingPrep, type PrepReads } from "./meetingPrep";

// La scheda di preparazione composta nel CLIENT (F5, O di 46): niente /prep
// sul server; le letture sono quelle che esistono già, tutte filtrate dal
// server per chi guarda, in parallelo, con al più 3 riunioni passate.

const ME = "p-me";
const PRJ = "prj-1";
const NOW = "2026-11-12T10:00:00.000Z";
const ev = (id: string, startsAt: string, over: Record<string, unknown> = {}) =>
  ({
    id,
    title: `Riunione ${id}`,
    startsAt,
    endsAt: new Date(Date.parse(startsAt) + 3_600_000).toISOString(),
    projectId: PRJ,
    // Il server la dà a un evento futuro di un progetto che chi guarda vede (F5a).
    hasPrep: Date.parse(startsAt) > Date.parse(NOW),
    ...over,
  }) as never;
const task = (code: string, statusId: string, dueDate: string | null) =>
  ({ id: code, code, statusId, dueDate, projectId: PRJ }) as never;

function reads(over: Partial<PrepReads> = {}): PrepReads {
  return {
    me: ME,
    now: NOW,
    today: "2026-11-12",
    getEvent: vi.fn(async () => ev("next", "2026-11-13T09:00:00.000Z")),
    projectPulse: vi.fn(async () => ({ open: { active: 2 } }) as never),
    listMailThreads: vi.fn(
      async () => Array.from({ length: 7 }, (_, i) => ({ threadId: `t${i}` })) as never,
    ),
    listTasks: vi.fn(async () => [
      task("A-1", "todo", "2026-11-01"),
      task("A-2", "todo", "2026-11-20"),
      task("A-3", "done", "2026-11-01"),
    ]),
    listStalled: vi.fn(async () => [{ task: task("A-9", "todo", null), stall: {} }] as never),
    listMilestones: vi.fn(
      async () =>
        [
          { id: "m1", name: "M1", dueDate: "2026-11-30", closed: false, projectId: PRJ },
          { id: "m2", name: "M2", dueDate: "2026-12-30", closed: false, projectId: PRJ },
          { id: "m3", name: "M3", dueDate: "2027-01-30", closed: false, projectId: PRJ },
        ] as never,
    ),
    listProjectStatuses: vi.fn(
      async () =>
        [
          { id: "todo", family: "todo" },
          { id: "done", family: "closed" },
        ] as never,
    ),
    listEvents: vi.fn(async () => [
      ev("next", "2026-11-13T09:00:00.000Z"),
      ev("p1", "2026-11-11T09:00:00.000Z"),
      ev("p2", "2026-11-10T09:00:00.000Z"),
      ev("p3", "2026-11-09T09:00:00.000Z"),
      ev("p4", "2026-11-08T09:00:00.000Z"),
      ev("other", "2026-11-11T12:00:00.000Z", { projectId: "prj-2" }),
    ]),
    getMeetingSummary: vi.fn(async (id: string) =>
      id === "p1" ? ({ summary: "Deciso X.", doc: "ready" } as never) : null,
    ),
    meetingTasksOf: vi.fn(async (id: string) =>
      id === "p2" ? { tasks: [{ code: "A-7" } as never], proposedTasks: 3 } : null,
    ),
    ...over,
  };
}

describe("la scheda di preparazione composta nel client", () => {
  it("una riunione futura di un progetto di cui sono membro: polso, la mia posta (5), le ultime 3 riunioni, lo stato", async () => {
    const r = reads();
    const prep = (await composeMeetingPrep("next", r))!;
    expect(prep.projectId).toBe(PRJ);
    expect(prep.recentMail).toHaveLength(5);
    expect(prep.recentMeetings.map((m) => m.eventId)).toEqual(["p1", "p2", "p3"]);
    expect(prep.recentMeetings[0]).toMatchObject({
      summary: "Deciso X.",
      doc: "ready",
      canOpen: true,
      tasks: [],
      proposedTasks: 0,
    });
    expect(prep.recentMeetings[1]).toMatchObject({
      summary: null,
      doc: null,
      tasks: [{ code: "A-7" }],
      proposedTasks: 3,
    });
    expect(prep.status).toMatchObject({ inProgress: 2, late: 1 });
    expect(prep.status.nextDueDates.map((t) => t.code)).toEqual(["A-2"]);
    expect(prep.status.milestones.map((m) => m.id)).toEqual(["m1", "m2"]);
    expect(prep.status.stalled).toHaveLength(1);
    // Solo le prime 3 riunioni passate leggono riassunto e task.
    expect(r.getMeetingSummary).toHaveBeenCalledTimes(3);
  });

  it("le letture vanno in parallelo: nessuna aspetta un'altra", async () => {
    let inFlight = 0;
    let most = 0;
    const slow =
      <T>(v: T) =>
      async () => {
        inFlight += 1;
        most = Math.max(most, inFlight);
        await new Promise((r) => setTimeout(r, 10));
        inFlight -= 1;
        return v;
      };
    const base = reads();
    await composeMeetingPrep(
      "next",
      reads({
        projectPulse: vi.fn(slow({ open: { active: 0 } } as never)),
        listMailThreads: vi.fn(slow([] as never)),
        listTasks: vi.fn(slow([])),
        listStalled: vi.fn(slow([] as never)),
        listMilestones: vi.fn(slow([] as never)),
        listProjectStatuses: vi.fn(slow([] as never)),
        listEvents: base.listEvents,
      }),
    );
    expect(most).toBeGreaterThanOrEqual(5);
  });

  it("nessuna scheda: una riunione passata o senza progetto (il server non dà `hasPrep`)", async () => {
    expect(
      await composeMeetingPrep(
        "x",
        reads({ getEvent: vi.fn(async () => ev("x", "2026-11-01T09:00:00.000Z")) }),
      ),
    ).toBeNull();
    expect(
      await composeMeetingPrep(
        "x",
        reads({
          getEvent: vi.fn(async () => ev("x", "2026-11-13T09:00:00.000Z", { projectId: null })),
        }),
      ),
    ).toBeNull();
    expect(
      await composeMeetingPrep(
        "x",
        reads({
          getEvent: vi.fn(async () => ev("x", "2026-11-13T09:00:00.000Z", { hasPrep: false })),
        }),
      ),
    ).toBeNull();
  });

  // Review F5a (3): chi ha la scheda lo decide `hasPrep` del server, non
  // l'appartenenza esplicita nel client (un full admin è membro implicito).
  it("un full admin non membro esplicito, con `hasPrep` dal server: la scheda c'è", async () => {
    expect(
      await composeMeetingPrep(
        "x",
        reads(),
      ),
    ).not.toBeNull();
  });

  it("un evento che non vedo: not_found, come nel prototipo", async () => {
    await expect(
      composeMeetingPrep(
        "x",
        reads({ getEvent: vi.fn(async () => Promise.reject(new Error("not_found"))) }),
      ),
    ).rejects.toThrow("not_found");
  });
});

// Review F5a (9): la scheda vera non rilegge i progetti (lo dice `hasPrep`)
// e chiede la posta del progetto al SERVER, non filtrando una pagina qui.
describe("la scheda vera: le letture", () => {
  it("nessuna lettura dei progetti; la posta col filtro di progetto del server", async () => {
    const { setAppClientForTests, session } = await import("./client");
    const { installFakeServer, ME_ID, PROJECT_ID } = await import("./fakeServer");
    const { calendar } = await import("./calendar");
    const EV = "eeeeeeee-9999-4999-8999-999999999999";
    vi.stubEnv("VITE_STUBWISE_BUILD", "app");
    setAppClientForTests(null);
    session.personId = ME_ID;
    try {
      const startsAt = new Date(Date.now() + 86_400_000).toISOString();
      const { seen } = installFakeServer({
        [`GET /api/me/calendar/events/${EV}`]: {
          body: {
            id: EV, accountId: "aaaaaaaa-1111-4111-8111-111111111111", accountEmail: "ada@acme.test",
            recurringEventId: null, projectId: PROJECT_ID, projectName: "Audin", title: "Review",
            organizer: "ada@acme.test", attendees: [], startsAt,
            endsAt: new Date(Date.parse(startsAt) + 3_600_000).toISOString(), allDay: false,
            status: "new", outcome: null, error: null, url: null, eventUrl: null, reproposable: false,
            descriptionHtml: null, descriptionText: null, location: null, hangoutLink: null,
            conferenceEntryPoints: [], reminders: [], remindersUseDefault: true, recurrence: [],
            hasPrep: true,
          },
        },
      });
      await calendar.getMeetingPrep(EV).catch(() => null);
      await vi.waitFor(() => expect(seen.some((r) => r.path.startsWith("/api/me/mail/threads"))).toBe(true));
      const threads = seen.find((r) => r.path.startsWith("/api/me/mail/threads"))!;
      expect(new URLSearchParams(threads.path.split("?")[1]).get("project")).toBe(PROJECT_ID);
      expect(seen.some((r) => r.method === "GET" && /^\/api\/projects(\?|$)/.test(r.path))).toBe(false);
    } finally {
      session.personId = null;
      setAppClientForTests(null);
      vi.unstubAllEnvs();
    }
  });
});
