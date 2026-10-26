import { beforeEach, describe, expect, it } from "vitest";
import {
  calendar,
  listMilestones,
  listStalled,
  listTasks,
  mail,
  projectPulse,
  resetApi,
  setLatency,
} from "../api";
import { CALENDAR_CASES } from "../seed/calendar";
import { daysFromToday, TODAY } from "../seed/dates";
import { EV_AUD_REVIEW_YESTERDAY, MAIL_CASES } from "../seed/mail";
import { setSessionPersonId } from "../session";
import { familyOf, state } from "../store";
import type { CalendarEvent } from "../types";
import { canSeeMessage } from "../mail/visibility";

const as = (personId: string) => setSessionPersonId(personId);
const AUD = "prj-aud";
const C = CALENDAR_CASES;
/** La prossima revisione di AUD: giovedì 29, Matteo organizza, Giulia, Laura e Marco invitati. */
const NEXT_REVIEW = `ev-aud-review-${daysFromToday(6)}`;
const REVIEW = "mp-aud-weekly-review";

const ev = (id: string): CalendarEvent => state.calendarEvents.find((e) => e.id === id)!;
const errorOf = (p: Promise<unknown>) =>
  p.then(
    () => null,
    (e: Error) => e.message,
  );

/** Le conversazioni di AUD di cui `me` vede almeno un messaggio. */
const audThreadsOf = (me: string) =>
  new Set(
    state.mailMessages
      .filter(
        (m) =>
          canSeeMessage(me, m) &&
          m.classification.state === "done" &&
          m.classification.projectIds.includes(AUD),
      )
      .map((m) => m.threadId),
  );

beforeEach(() => {
  resetApi();
  setLatency(0);
  as("p-giulia");
});

describe("Scheda di preparazione: quando c'è", () => {
  it("un evento futuro di un progetto di cui sono membro", async () => {
    expect(Date.parse(ev(NEXT_REVIEW).startsAt)).toBeGreaterThan(Date.parse(`${TODAY}T12:00:00Z`));
    const prep = await calendar.getMeetingPrep(NEXT_REVIEW);
    expect(prep).toMatchObject({ eventId: NEXT_REVIEW, projectId: AUD });
  });

  it("evento senza progetto → null", async () => {
    expect(ev(C.lunch).projectId).toBeNull();
    expect(await calendar.getMeetingPrep(C.lunch)).toBeNull();
  });

  it("non membro del progetto dell'evento → null", async () => {
    // L'all-hands vede tutta l'azienda: sul progetto AUD, Chiara (marketing) non è membro.
    ev(C.allHands).projectId = AUD;
    as("p-chiara");
    expect(state.projectsById.get(AUD)!.memberIds).not.toContain("p-chiara");
    expect(await calendar.getMeetingPrep(C.allHands)).toBeNull();
    as("p-giulia");
    expect(await calendar.getMeetingPrep(C.allHands)).not.toBeNull();
  });

  it("il confine: finito esattamente adesso è passato, un secondo dopo adesso no", async () => {
    // Il go-live (11:00–12:00) finisce esattamente a «adesso» (12:00).
    expect(ev(C.goLive).endsAt).toBe(`${TODAY}T12:00:00Z`);
    expect(await calendar.getMeetingPrep(C.goLive)).toBeNull();
    expect((await calendar.getEvent(C.goLive)).hasPrep).toBe(false);
    ev(C.goLive).endsAt = `${TODAY}T12:00:01Z`;
    expect(await calendar.getMeetingPrep(C.goLive)).toMatchObject({ eventId: C.goLive });
    expect((await calendar.getEvent(C.goLive)).hasPrep).toBe(true);
  });

  it("evento passato → null: al suo posto riassunto e task nate [A 1]", async () => {
    expect(await calendar.getMeetingPrep(EV_AUD_REVIEW_YESTERDAY)).toBeNull();
  });

  it("`hasPrep` sulla vista dell'evento: la stessa regola di getMeetingPrep", async () => {
    const flag = async (id: string) => (await calendar.getEvent(id)).hasPrep;
    expect(await flag(NEXT_REVIEW)).toBe(true);
    expect(await flag(C.lunch)).toBe(false); // senza progetto
    expect(await flag(EV_AUD_REVIEW_YESTERDAY)).toBe(false); // passato
    ev(C.allHands).projectId = AUD;
    expect(await flag(C.allHands)).toBe(true);
    as("p-chiara"); // non membro di AUD
    expect(await flag(C.allHands)).toBe(false);
    const listed = await calendar.listUpcomingEvents();
    expect(listed.find((e) => e.id === C.allHands)?.hasPrep ?? false).toBe(false);
  });

  it("evento che non vedo → not_found, come uno inesistente", async () => {
    as("p-roberta");
    expect(await errorOf(calendar.getMeetingPrep(NEXT_REVIEW))).toBe("not_found");
    expect(await errorOf(calendar.getMeetingPrep("ev-nope"))).toBe("not_found");
  });
});

describe("Scheda di preparazione: le email sono solo le mie (Review Focus 1)", () => {
  it("due persone alla stessa riunione vedono email diverse; nessuna di un collega", async () => {
    // L'email di AUD più recente di tutte, solo a Matteo: in cima alla sua
    // scheda, assente da quella dei colleghi alla stessa riunione.
    const shared = state.mailMessages.find((m) => m.id === MAIL_CASES.shared)!;
    state.mailMessages.push({
      ...structuredClone(shared),
      id: "mm-test-only-matteo",
      messageId: "<only-matteo@audin.example>",
      threadId: "th-test-only-matteo",
      to: [shared.to.find((a) => a.personId === "p-matteo")!],
      cc: null,
      subject: "Only for Matteo",
      at: `${TODAY}T11:59:00Z`,
      mailboxPersonIds: ["p-matteo"],
      readByPersonIds: [],
    });

    for (const me of ["p-giulia", "p-matteo", "p-laura", "p-marco"]) {
      as(me);
      const prep = (await calendar.getMeetingPrep(NEXT_REVIEW))!;
      const mine = audThreadsOf(me);
      expect(prep.recentMail.length).toBeGreaterThan(0);
      expect(prep.recentMail.length).toBeLessThanOrEqual(5);
      for (const row of prep.recentMail) expect(mine.has(row.threadId)).toBe(true);
      // Lo stesso elenco della Posta filtrata sul progetto, i primi 5.
      const list = await mail.listMailThreads({ projectId: AUD });
      expect(prep.recentMail).toEqual(list.slice(0, 5));
      const ids = prep.recentMail.map((r) => r.threadId);
      if (me === "p-matteo") expect(ids[0]).toBe("th-test-only-matteo");
      else expect(ids).not.toContain("th-test-only-matteo");
    }

    // Marco è in AUD e alla riunione, ma non fra i destinatari della condivisa.
    as("p-marco");
    const marco = (await calendar.getMeetingPrep(NEXT_REVIEW))!;
    expect(marco.recentMail.map((r) => r.threadId)).not.toContain(shared.threadId);
  });
});

describe("Scheda di preparazione: riunioni precedenti", () => {
  it("a un partecipante: le riunioni passate dalla più recente, col riassunto; al massimo 3", async () => {
    const prep = (await calendar.getMeetingPrep(NEXT_REVIEW))!;
    // Il go-live di oggi (finito alle 12, l'ora del prototipo), la revisione
    // di ieri, quella della settimana prima.
    expect(prep.recentMeetings.map((m) => m.eventId)).toEqual([
      C.goLive,
      EV_AUD_REVIEW_YESTERDAY,
      `ev-aud-review-${daysFromToday(-8)}`,
    ]);
    expect(prep.recentMeetings[0]).toMatchObject({ summary: null, doc: null, canOpen: true });
    expect(prep.recentMeetings[1]).toMatchObject({
      title: "AUD weekly review",
      at: ev(EV_AUD_REVIEW_YESTERDAY).startsAt,
      doc: "ready",
      canOpen: true,
      tasks: [],
    });
    expect(prep.recentMeetings[1]!.summary).toMatch(/go-live plan/);
  });

  it("la riunione in corso non è fra le precedenti; quella appena finita sì", async () => {
    ev(C.goLive).endsAt = `${TODAY}T12:30:00Z`;
    const prep = (await calendar.getMeetingPrep(NEXT_REVIEW))!;
    expect(prep.recentMeetings.map((m) => m.eventId)).not.toContain(C.goLive);
    // E in corso ha la sua scheda.
    expect(await calendar.getMeetingPrep(C.goLive)).toMatchObject({ eventId: C.goLive });
  });

  it("a un membro che non c'era: titolo, data e task nate; nessun riassunto e l'evento non si apre [A 2]", async () => {
    // Alessia è invitata al controllo della dashboard di AUD, non alla revisione di ieri.
    as("p-alessia");
    const before = (await calendar.getMeetingPrep(C.saveFails))!;
    // Senza task nate la revisione (che non vede) non c'è.
    expect(before.recentMeetings.map((m) => m.eventId)).not.toContain(EV_AUD_REVIEW_YESTERDAY);

    as("p-giulia");
    const out = await mail.confirmMailProposal(REVIEW, { actionIndexes: [0, 1, 2] });
    expect(out.status).toBe("confirmed");

    as("p-alessia");
    const prep = (await calendar.getMeetingPrep(C.saveFails))!;
    const review = prep.recentMeetings.find((m) => m.eventId === EV_AUD_REVIEW_YESTERDAY)!;
    expect(review).toMatchObject({
      title: "AUD weekly review",
      summary: null,
      doc: null,
      canOpen: false,
    });
    expect(review.tasks.map((t) => t.code)).toEqual(
      out.status === "confirmed" ? out.resultCodes : [],
    );
  });

  it("documento non raggiungibile: nessun riassunto, lo stato esposto", async () => {
    state.meetingTranscripts.find((t) => t.eventId === EV_AUD_REVIEW_YESTERDAY)!.doc =
      "unreachable";
    const prep = (await calendar.getMeetingPrep(NEXT_REVIEW))!;
    expect(prep.recentMeetings.find((m) => m.eventId === EV_AUD_REVIEW_YESTERDAY)).toMatchObject({
      summary: null,
      doc: "unreachable",
    });
  });
});

describe("Scheda di preparazione: stato del progetto, le stesse letture dell'Overview", () => {
  it("polso, ferme, in corso, in ritardo, scadenze e traguardi", async () => {
    const prep = (await calendar.getMeetingPrep(NEXT_REVIEW))!;
    const pulse = await projectPulse(AUD);
    expect(prep.pulse).toEqual(pulse);
    expect(prep.status.inProgress).toBe(pulse!.open.active);
    expect(prep.status.stalled).toEqual(await listStalled({ projectIds: [AUD] }));
    expect(prep.status.stalled).toHaveLength(pulse!.stalled);

    const open = (await listTasks({ projectIds: [AUD] })).filter((t) => familyOf(t) !== "closed");
    expect(prep.status.late).toBe(open.filter((t) => t.dueDate && t.dueDate < TODAY).length);

    const due = open
      .filter((t) => t.dueDate && t.dueDate >= TODAY)
      .sort((a, b) => a.dueDate!.localeCompare(b.dueDate!) || a.code.localeCompare(b.code))
      .slice(0, 3);
    expect(prep.status.nextDueDates.map((t) => t.code)).toEqual(due.map((t) => t.code));

    const milestones = (await listMilestones(AUD)).filter((m) => !m.closed);
    expect(prep.status.milestones.length).toBe(Math.min(2, milestones.length));
    expect(prep.status.milestones.every((m) => !m.closed && m.projectId === AUD)).toBe(true);
  });
});
