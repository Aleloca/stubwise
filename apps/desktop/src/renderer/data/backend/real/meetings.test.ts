import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { session, setAppClientForTests } from "./client";
import { installFakeServer, ME_ID } from "./fakeServer";
import { meetingFunctions } from "./meetings";

// Le riunioni registrate nella build app (area 6, F5): le rotte della BOZZA
// del piano (`docs/plans/2026-11-12-integrazione-area6-fetta5-plan.md`,
// branch docs/area6-f5-plan), finché 72 non le fissa. La visibilità è del
// SERVER (tutti gli invitati, decisione M): qui un 404 vuol dire «non lo sai».

const EV = "eeeeeeee-1111-4111-8111-111111111111";
const M1 = "dddddddd-1111-4111-8111-111111111111";
const ACC = "aaaaaaaa-1111-4111-8111-111111111111";
const T1 = "77777777-1111-4111-8111-111111111111";
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
          eventId: EV,
          docTitle: "Weekly review – Notes by Gemini",
          doc: "ready",
          summary: "Si è deciso di anticipare il rilascio.",
          docUrl: "https://docs.google.com/document/d/abc",
          email: { threadId: `${ACC}_t-9`, messageId: M1, at: "2026-11-11T16:40:00.000Z" },
        },
      },
    });
    expect(await m.getMeetingSummary!(EV)).toEqual({
      eventId: EV,
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
