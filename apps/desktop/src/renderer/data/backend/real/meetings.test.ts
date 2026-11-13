import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { session, setAppClientForTests } from "./client";
import { installFakeServer, ME_ID } from "./fakeServer";
import { meetingFunctions, meetingOfMessage } from "./meetings";

// Le riunioni registrate nella build app (area 6, F5): le rotte della BOZZA
// del piano (`docs/plans/2026-11-12-integrazione-area6-fetta5-plan.md`,
// branch docs/area6-f5-plan), finché 72 non le fissa. La visibilità è del
// SERVER (tutti gli invitati, decisione M): qui un 404 vuol dire «non lo sai».

const EV = "eeeeeeee-1111-4111-8111-111111111111";
const M1 = "dddddddd-1111-4111-8111-111111111111";
const ACC = "aaaaaaaa-1111-4111-8111-111111111111";
const T1 = "77777777-1111-4111-8111-111111111111";
const NOTE_1 = "99999999-2222-4222-8222-222222222222";
const m = meetingFunctions;

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

describe("F5: il riassunto di una riunione", () => {
  it("a un invitato: titolo del Doc, stato, riassunto e l'email di Gemini; la trascrizione intera non arriva", async () => {
    installFakeServer({
      [`GET /api/me/calendar/events/${EV}/summary`]: {
        body: {
          noteId: NOTE_1,
          eventId: EV,
          docTitle: "Weekly review – Notes by Gemini",
          doc: "ready",
          summary: "Si è deciso di anticipare il rilascio.",
          docUrl: "https://docs.google.com/document/d/abc",
          email: { threadId: "t-9", accountId: ACC, messageId: M1, at: "2026-11-11T16:40:00.000Z" },
        },
      },
    });
    expect(await m.getMeetingSummary!(EV)).toEqual({
      noteId: NOTE_1,
      eventId: EV,
      docReason: null,
      docTitle: "Weekly review – Notes by Gemini",
      doc: "ready",
      summary: "Si è deciso di anticipare il rilascio.",
      transcript: null,
      docUrl: "https://docs.google.com/document/d/abc",
      email: { threadId: `${ACC}_t-9`, sourceId: M1, at: "2026-11-11T16:40:00.000Z" },
    });
  });

  it("a chi non c'era (404 del server, anche un admin): nessun riassunto, come se non esistesse", async () => {
    installFakeServer({
      [`GET /api/me/calendar/events/${EV}/summary`]: {
        status: 404,
        body: { code: "not_found", message: "x" },
      },
    });
    expect(await m.getMeetingSummary!(EV)).toBeNull();
  });

  it("un server di prima (la rotta non c'è): nessun riassunto", async () => {
    installFakeServer({});
    expect(await m.getMeetingSummary!(EV)).toBeNull();
  });

  it("documento non raggiungibile: lo stato, niente riassunto", async () => {
    installFakeServer({
      [`GET /api/me/calendar/events/${EV}/summary`]: {
        body: {
          noteId: NOTE_1,
          eventId: EV,
          docTitle: "Notes by Gemini",
          doc: "unreachable",
          summary: null,
          docUrl: null,
          email: null,
        },
      },
    });
    expect(await m.getMeetingSummary!(EV)).toMatchObject({
      doc: "unreachable",
      summary: null,
      email: null,
    });
  });
});

describe("F5: «Task da questa riunione»", () => {
  it("ai membri del progetto: le task e le richieste nate, col loro stato di adesso", async () => {
    installFakeServer({
      [`GET /api/me/calendar/events/${EV}/tasks`]: {
        body: {
          tasks: [
            {
              kind: "task",
              id: T1,
              code: "AUD-12",
              title: "Export",
              status: "late",
              inProgress: false,
              dueDate: "2026-11-10",
              departmentId: null,
            },
          ],
          proposedTasks: 2,
        },
      },
    });
    expect(await m.tasksBornFrom!(EV)).toEqual([
      {
        kind: "task",
        id: T1,
        code: "AUD-12",
        title: "Export",
        status: "late",
        inProgress: false,
        dueDate: "2026-11-10",
        departmentId: null,
      },
    ]);
  });

  it("a chi non è membro (null dal server) o senza la rotta: nessuna sezione", async () => {
    installFakeServer({ [`GET /api/me/calendar/events/${EV}/tasks`]: { body: null } });
    expect(await m.tasksBornFrom!(EV)).toBeNull();
    installFakeServer({});
    expect(await m.tasksBornFrom!(EV)).toBeNull();
  });
});

// F5a (forme di 72): l'email di Gemini sul messaggio. Il server la DERIVA a
// lettura; `visible` falso ⇒ titolo, riassunto e link null. Il testo intero
// non arriva mai al client: «Open the transcript» apre il Doc su Google.
describe("F5a: la riunione registrata sul messaggio", () => {
  const EVENT = {
    id: "ev-1",
    title: "Review",
    startsAt: "2026-11-12T09:00:00Z",
    endsAt: "2026-11-12T10:00:00Z",
    people: 4,
  };

  it("un'email qualunque (o un server di prima): `kind: email`, nessuna riunione", () => {
    expect(meetingOfMessage({})).toEqual({ kind: "email" });
    expect(meetingOfMessage({ kind: "email", meeting: null })).toEqual({ kind: "email" });
  });

  it("la trascrizione che vedo: riassunto, link al Doc, l'evento, il motivo; mai il testo", () => {
    expect(
      meetingOfMessage({
        kind: "transcript",
        meeting: {
          noteId: "note-1",
          docTitle: "Notes: Review",
          doc: "ready",
          docReason: "too_long",
          visible: true,
          summary: "Si parte lunedì.",
          docUrl: "https://docs.google.com/document/d/abc",
          event: EVENT,
        },
      }),
    ).toEqual({
      kind: "transcript",
      meeting: {
        noteId: "note-1",
        docTitle: "Notes: Review",
        doc: "ready",
        docReason: "too_long",
        visible: true,
        summary: "Si parte lunedì.",
        transcript: null,
        docUrl: "https://docs.google.com/document/d/abc",
        event: EVENT,
      },
    });
  });

  it("chi non c'era: niente titolo, riassunto né link, anche se il server li mandasse", () => {
    const r = meetingOfMessage({
      kind: "transcript",
      meeting: {
        noteId: "note-1",
        docTitle: "x",
        doc: "ready",
        visible: false,
        summary: "x",
        docUrl: "https://docs.google.com/document/d/abc",
        event: null,
      },
    });
    expect(r.meeting).toMatchObject({
      visible: false,
      docTitle: null,
      summary: null,
      docUrl: null,
      transcript: null,
    });
  });

  it("un link che non è di Google Docs non si apre", () => {
    const r = meetingOfMessage({
      kind: "transcript",
      meeting: {
        noteId: "n",
        docTitle: "t",
        doc: "ready",
        visible: true,
        summary: "s",
        docUrl: "https://evil.test/x",
        event: null,
      },
    });
    expect(r.meeting?.docUrl).toBeNull();
  });
});

// Q-A = a (13 nov 2026) sulle forme di 72: l'invitato senza l'email di Gemini
// (e magari senza l'evento) apre la riunione per nota.
describe("F5a: la riunione per nota", () => {
  const NOTE = "99999999-1111-4111-8111-111111111111";

  it("il riassunto: lo stesso dell'evento, con `noteId` e l'evento di CHI GUARDA (qui nessuno)", async () => {
    const { seen } = installFakeServer({
      [`GET /api/me/meetings/${NOTE}`]: {
        body: {
          noteId: NOTE,
          eventId: null,
          docTitle: "Weekly review – Notes by Gemini",
          doc: "ready",
          summary: "Si parte lunedì.",
          docUrl: "https://docs.google.com/document/d/abc",
          email: null,
        },
      },
    });
    expect(await m.getMeetingByNote!(NOTE)).toEqual({
      noteId: NOTE,
      eventId: null,
      docReason: null,
      docTitle: "Weekly review – Notes by Gemini",
      doc: "ready",
      summary: "Si parte lunedì.",
      transcript: null,
      docUrl: "https://docs.google.com/document/d/abc",
      email: null,
    });
    // Mai una conversazione: l'invitato non ce l'ha.
    expect(seen.some((r) => r.path.includes("/mail/"))).toBe(false);
  });

  it("a chi non c'era (404): niente", async () => {
    installFakeServer({
      [`GET /api/me/meetings/${NOTE}`]: { status: 404, body: { code: "not_found", message: "x" } },
    });
    expect(await m.getMeetingByNote!(NOTE)).toBeNull();
  });

  it("le task per nota: come quelle dell'evento; null a chi non è membro", async () => {
    const task = {
      kind: "task",
      id: T1,
      code: "AUD-12",
      title: "Export",
      status: "open",
      inProgress: true,
      dueDate: null,
      departmentId: "dddddddd-9999-4999-8999-999999999999",
    };
    installFakeServer({
      [`GET /api/me/meetings/${NOTE}/tasks`]: { body: { tasks: [task], proposedTasks: 1 } },
    });
    expect(await m.tasksOfNote!(NOTE)).toEqual([task]);
    installFakeServer({ [`GET /api/me/meetings/${NOTE}/tasks`]: { body: null } });
    expect(await m.tasksOfNote!(NOTE)).toBeNull();
  });
});

// Il cablaggio: le funzioni delle riunioni sono nei namespace VERI della
// build app (senza, una chiamata è uno stub «non integrato»: ComingSoon non lo
// vede, perché registra l'API del prototipo).
describe("F5a: le riunioni nei namespace della build app", () => {
  it("mail.getMeetingSummary / getMeetingByNote / tasksBornFrom / tasksOfNote e calendar.getMeetingPrep", async () => {
    const { mail } = await import("./mail");
    const { calendar } = await import("./calendar");
    const { NotIntegratedError } = await import("./notIntegrated");
    for (const fn of ["getMeetingSummary", "getMeetingByNote", "tasksBornFrom", "tasksOfNote"] as const)
      expect(mail[fn]).toBe(meetingFunctions[fn]);
    // La scheda si compone nel client (O, 46): `meetingPrep.ts` legge da
    // `calendar` e `mail`, quindi è agganciata con un rinvio. Non è lo stub.
    installFakeServer({});
    const out = await calendar.getMeetingPrep(EV).catch((e: unknown) => e);
    expect(out).not.toBeInstanceOf(NotIntegratedError);
  });
});

// Review F5a (5, 6): il motivo del Doc arriva al riassunto, e il link è solo di Google Docs.
describe("F5a: il riassunto dice il motivo del Doc, e apre solo Google Docs", () => {
  const NOTE = "99999999-3333-4333-8333-333333333333";
  const summary = (over: Record<string, unknown>) => ({
    [`GET /api/me/meetings/${NOTE}`]: {
      body: { noteId: NOTE, eventId: null, docTitle: "Notes", doc: "ready", summary: "S", docUrl: null, email: null, ...over },
    },
  });

  it("too_long e scope_missing passano", async () => {
    installFakeServer(summary({ docReason: "too_long" }));
    expect((await m.getMeetingByNote!(NOTE))?.docReason).toBe("too_long");
    installFakeServer(summary({ doc: "unreachable", docReason: "scope_missing" }));
    expect((await m.getMeetingByNote!(NOTE))?.docReason).toBe("scope_missing");
  });

  it("un link che non è di Google Docs non si apre", async () => {
    installFakeServer(summary({ docUrl: "https://evil.test/document/d/x" }));
    expect((await m.getMeetingByNote!(NOTE))?.docUrl).toBeNull();
  });
});

// Review F5a (2): il link «dall'email» del riassunto usa la chiave dell'app
// (casella + thread); senza la casella (un server di prima) niente link, ma
// l'email resta per le proposte aperte.
describe("F5a: l'email di Gemini del riassunto", () => {
  const NOTE = "99999999-4444-4444-8444-444444444444";
  const withEmail = (email: Record<string, unknown>) => ({
    [`GET /api/me/meetings/${NOTE}`]: {
      body: { noteId: NOTE, eventId: null, docTitle: "N", doc: "ready", summary: "S", docUrl: null, email },
    },
  });

  it("con la casella: la chiave dell'app", async () => {
    installFakeServer(withEmail({ threadId: "t-9", accountId: ACC, messageId: M1, at: "2026-11-11T16:40:00.000Z" }));
    expect((await m.getMeetingByNote!(NOTE))?.email).toEqual({
      threadId: `${ACC}_t-9`,
      sourceId: M1,
      at: "2026-11-11T16:40:00.000Z",
    });
  });

  it("senza la casella: nessun link (threadId null), la fonte delle proposte resta", async () => {
    installFakeServer(withEmail({ threadId: "t-9", messageId: M1, at: "2026-11-11T16:40:00.000Z" }));
    expect((await m.getMeetingByNote!(NOTE))?.email).toEqual({
      threadId: null,
      sourceId: M1,
      at: "2026-11-11T16:40:00.000Z",
    });
  });
});
