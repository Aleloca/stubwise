import { allDayEventsForDay, eventDayKey, timedEventsForDay } from "@stubwise/shared";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { calendar, failNext, mail, resetApi, setLatency } from "../api";
import { calendarParticipants } from "../mail/visibility";
import { can, grantProjectRole, viewerFor } from "../viewer";
import { isUpcoming, seriesProposal } from "./proposals";
import { CALENDAR_CASES, SERIES_IDS } from "../seed/calendar";
import { EV_AUD_REVIEW_YESTERDAY } from "../seed/mail";
import { setSessionPersonId } from "../session";
import { state, visibleProjectIds } from "../store";
import type { CalendarEvent } from "../types";

const as = (personId: string) => setSessionPersonId(personId);
const C = CALENDAR_CASES;
const AUD = "prj-aud";
const MKX = "prj-mkx";
const STW = "prj-stw";

const ev = (id: string): CalendarEvent => state.calendarEvents.find((e) => e.id === id)!;
const seriesOf = (id: string) => state.calendarEvents.filter((e) => e.seriesId === id);
const ALL = { from: "2000-01-01T00:00:00Z", to: "2100-01-01T00:00:00Z" };
const proposalOf = (eventId: string) =>
  state.mailProposals.find((p) => p.source === "calendar" && p.sourceId === eventId);
const calendarProposalIds = () =>
  state.mailProposals.filter((p) => p.source === "calendar").map((p) => p.id);
const series = (id: string) => state.calendarSeries.find((s) => s.id === id)!;

beforeEach(() => {
  resetApi();
  setLatency(0);
  as("p-giulia");
});

describe("Calendario: seme", () => {
  it("la giornata di oggi di Giulia è piena", async () => {
    const today = await calendar.listEvents({
      from: "2026-10-23T00:00:00Z",
      to: "2026-10-24T00:00:00Z",
    });
    const timed = today.filter((e) => !e.allDay);
    // Tre riunioni di progetto (standup STW, go-live AUD, visual MKX), una personale, un invito.
    expect(
      timed.filter((e) => e.projectId !== null && e.myResponse !== "needsAction"),
    ).toHaveLength(3);
    expect(timed.find((e) => e.id === C.lunch)).toMatchObject({ projectId: null, attendees: [] });
    expect(today.find((e) => e.id === C.invite)).toMatchObject({ myResponse: "needsAction" });
    expect(today.filter((e) => e.allDay).map((e) => e.id)).toEqual([C.pressDay]);
  });

  it("12 eventi sovrapposti mercoledì 28", async () => {
    const day = await calendar.listEvents({
      from: "2026-10-28T10:00:00Z",
      to: "2026-10-28T13:00:00Z",
    });
    expect(day.filter((e) => e.id.startsWith("ev-overlap-"))).toHaveLength(12);
  });

  it("la revisione di AUD di ieri: 15:30–16:30, Meet, Giulia, Matteo, Laura e Marco", () => {
    const e = ev(EV_AUD_REVIEW_YESTERDAY);
    expect(e).toMatchObject({
      startsAt: "2026-10-22T15:30:00Z",
      endsAt: "2026-10-22T16:30:00Z",
      projectId: AUD,
      seriesId: SERIES_IDS.audReview,
    });
    expect(e.meetUrl).toMatch(/^https:\/\/meet\.google\.com\//);
    expect(e.attendees.map((a) => a.personId).sort()).toEqual(
      ["p-giulia", "p-laura", "p-marco", "p-matteo"].sort(),
    );
  });

  it("una serie accesa e le altre spente di default, una senza date nella finestra", async () => {
    const series = await calendar.listSeries();
    const byId = new Map(series.map((s) => [s.id, s]));
    expect(byId.get(SERIES_IDS.audReview)).toMatchObject({ enabled: true, projectId: AUD });
    expect(byId.get(SERIES_IDS.stwStandup)).toMatchObject({ enabled: false, projectId: null });
    expect(byId.get(SERIES_IDS.budget)).toMatchObject({
      enabled: false,
      occurrencesInWindow: 0,
      nextAt: null,
    });
    expect(byId.get(SERIES_IDS.audReview)!.nextAt).toBe("2026-10-29T15:30:00Z");
  });
});

describe("Calendario: chi vede che cosa", () => {
  it("chi non è nel calendario né invitato non vede l'evento: inesistente", async () => {
    as("p-sara"); // invitata solo all'all-hands, come tutto il team
    expect((await calendar.listEvents(ALL)).map((e) => e.id)).toEqual([C.allHands]);
    await expect(calendar.getEvent(C.goLive)).rejects.toThrow("not_found");
    await expect(calendar.respond(C.goLive, "accepted")).rejects.toThrow("not_found");
    await expect(calendar.getEvent("ev-nope")).rejects.toThrow("not_found");
  });

  it("un invitato senza calendario collegato vede l'evento", async () => {
    as("p-marco");
    expect(await calendar.getEvent(EV_AUD_REVIEW_YESTERDAY)).toMatchObject({
      myResponse: "accepted",
      isOrganizer: false,
      calendarEmail: null,
    });
  });

  it("il progetto di un evento che non vedo è «nessun progetto»", async () => {
    as("p-matteo"); // non è in OLV
    state.calendarEvents.find((e) => e.id === C.invite)!.calendarPersonIds.push("p-matteo");
    expect(await calendar.getEvent(C.invite)).toMatchObject({ projectId: null, projectBy: null });
  });

  it("le proposte di calendario seguono i partecipanti veri dell'evento", () => {
    expect(calendarParticipants.of(C.deadline).sort()).toEqual(["p-giulia", "p-matteo"]);
    expect(calendarParticipants.of(C.declinedDeadline)).toEqual([]);
    expect(calendarParticipants.of("ev-nope")).toEqual([]);
  });
});

describe("Calendario: fusi e bordi (Review Focus 3, TZ=America/Los_Angeles)", () => {
  const ORIGINAL_TZ = process.env.TZ;
  beforeAll(() => {
    process.env.TZ = "America/Los_Angeles";
  });
  afterAll(() => {
    process.env.TZ = ORIGINAL_TZ;
  });

  /** La mezzanotte locale (Los Angeles) di un giorno. */
  const local = (y: number, m: number, d: number) => new Date(y, m - 1, d);
  const localDay = (y: number, m: number, d: number) => ({
    from: local(y, m, d).toISOString(),
    to: local(y, m, d + 1).toISOString(),
  });

  it("il fuso è davvero negativo", () => {
    expect(new Date("2026-10-23T00:00:00Z").getTimezoneOffset()).toBe(420);
  });

  it("un evento tutto il giorno resta sulla sua data", async () => {
    const press = await calendar.getEvent(C.pressDay);
    expect(eventDayKey(press)).toBe("2026-10-23");
    const events = await calendar.listEvents(localDay(2026, 10, 23));
    expect(allDayEventsForDay(events, local(2026, 10, 23)).map((e) => e.id)).toEqual([C.pressDay]);
    // Il giorno prima, in locale, non c'è: né nella lettura né nella griglia.
    const before = await calendar.listEvents(localDay(2026, 10, 22));
    expect(before.map((e) => e.id)).not.toContain(C.pressDay);
    expect(allDayEventsForDay(before, local(2026, 10, 22))).toEqual([]);
  });

  it("un evento a cavallo della mezzanotte locale compare nei due giorni, tagliato", async () => {
    await calendar.createEvent({
      title: "Late deploy",
      startsAt: new Date(2026, 10, 2, 22, 30).toISOString(), // 22:30 locali del 2 novembre
      endsAt: new Date(2026, 10, 3, 1, 0).toISOString(), // 01:00 locali del 3
    });
    const id = state.calendarEvents.find((e) => e.title === "Late deploy")!.id;
    const read = await calendar.listEvents({
      from: local(2026, 11, 2).toISOString(),
      to: local(2026, 11, 4).toISOString(),
    });
    const first = timedEventsForDay(read, local(2026, 11, 2)).find((p) => p.event.id === id)!;
    const second = timedEventsForDay(read, local(2026, 11, 3)).find((p) => p.event.id === id)!;
    expect(first.topPct + first.heightPct).toBeCloseTo(100);
    expect(second.topPct).toBe(0);
    expect(eventDayKey(read.find((e) => e.id === id)!)).toBe("2026-11-02");
  });

  it("il rilascio di AUD (22:30–01:00 UTC) a Los Angeles è un pomeriggio solo", async () => {
    const read = await calendar.listEvents(localDay(2026, 10, 29));
    expect(timedEventsForDay(read, local(2026, 10, 29)).map((p) => p.event.id)).toContain(
      C.midnight,
    );
    expect(timedEventsForDay(read, local(2026, 10, 30)).map((p) => p.event.id)).not.toContain(
      C.midnight,
    );
  });

  it("una serie con date oltre la finestra: si leggono solo quelle dentro", async () => {
    const read = (await calendar.listEvents(ALL)).filter(
      (e) => e.seriesId === SERIES_IDS.audReview,
    );
    const all = seriesOf(SERIES_IDS.audReview);
    expect(all.some((e) => e.startsAt < "2026-09-23")).toBe(true);
    expect(all.some((e) => e.startsAt >= "2026-12-23")).toBe(true);
    expect(read.length).toBeGreaterThan(0);
    expect(read.length).toBeLessThan(all.length);
    expect(read.every((e) => e.startsAt >= "2026-09-23" && e.endsAt <= "2026-12-23")).toBe(true);
    const beyond = all.find((e) => e.startsAt >= "2026-12-23")!;
    await expect(calendar.getEvent(beyond.id)).rejects.toThrow("not_found");
  });

  it("«Prossimi appuntamenti» si ferma a fine di domani nel fuso di chi guarda", async () => {
    // Fine di domani a Los Angeles: 25 ottobre 00:00 PDT = 07:00 UTC.
    for (const [title, startsAt, endsAt] of [
      ["Saturday night LA", "2026-10-25T06:30:00Z", "2026-10-25T06:45:00Z"],
      ["Sunday LA", "2026-10-25T07:00:00Z", "2026-10-25T07:30:00Z"],
    ] as const)
      await calendar.createEvent({ title, startsAt, endsAt });
    const titles = (await calendar.listUpcomingEvents()).map((e) => e.title);
    expect(titles).toContain("Saturday night LA");
    expect(titles).not.toContain("Sunday LA");
  });

  it("si crea e si sposta fino al 22 dicembre, non oltre", async () => {
    expect(calendar.calendarWindow()).toEqual({
      from: "2026-09-23T00:00:00Z",
      to: "2026-12-23T00:00:00Z",
    });
    const last = {
      title: "Last",
      startsAt: "2026-12-22T10:00:00Z",
      endsAt: "2026-12-22T11:00:00Z",
    };
    await expect(calendar.createEvent(last)).resolves.toMatchObject({ title: "Last" });
    await expect(
      calendar.createEvent({
        ...last,
        startsAt: "2026-12-23T10:00:00Z",
        endsAt: "2026-12-23T11:00:00Z",
      }),
    ).rejects.toThrow("invalid: outside_window");
    await expect(
      calendar.moveEvent(C.goLive, "2027-01-05T10:00:00Z", "2027-01-05T11:00:00Z"),
    ).rejects.toThrow("invalid: outside_window");
    expect(ev(C.goLive).startsAt).toBe("2026-10-23T11:00:00Z");
  });
});

describe("Calendario: un evento che tocca la mezzanotte UTC (fuso dei test)", () => {
  it("compare nei due giorni", async () => {
    const read = await calendar.listEvents({
      from: "2026-10-29T00:00:00Z",
      to: "2026-10-31T00:00:00Z",
    });
    for (const d of [29, 30]) {
      expect(timedEventsForDay(read, new Date(2026, 9, d)).map((p) => p.event.id)).toContain(
        C.midnight,
      );
    }
  });
});

describe("Calendario: organizzatore e invitati", () => {
  it("chi non organizza: modifica, spostamento ed eliminazione forbidden; la risposta sì", async () => {
    const before = structuredClone(ev(C.visualsReview));
    await expect(calendar.updateEvent(C.visualsReview, { title: "Mine" })).rejects.toThrow(
      "forbidden",
    );
    await expect(
      calendar.moveEvent(C.visualsReview, "2026-10-23T16:00:00Z", "2026-10-23T17:00:00Z"),
    ).rejects.toThrow("forbidden");
    await expect(calendar.deleteEvent(C.visualsReview)).rejects.toThrow("forbidden");
    expect(ev(C.visualsReview)).toEqual(before);

    const view = await calendar.respond(C.visualsReview, "tentative", "  Running late  ");
    expect(view).toMatchObject({ myResponse: "tentative", save: { state: "saving" } });
    await calendar.whenCalendarIdle();
    const mine = ev(C.visualsReview).attendees.find((a) => a.personId === "p-giulia")!;
    expect(mine).toMatchObject({ response: "tentative", note: "Running late" });
    expect(ev(C.visualsReview).save).toEqual({ state: "saved" });
  });

  it("l'organizzatore non risponde a sé stesso; needsAction non è una risposta", async () => {
    await expect(calendar.respond(C.goLive, "accepted")).rejects.toThrow("invalid: organizer");
    await expect(calendar.respond(C.invite, "needsAction")).rejects.toThrow("invalid: rsvp");
  });

  it("l'organizzatore modifica: titolo, Meet e invitati (le risposte restano)", async () => {
    await calendar.updateEvent(C.goLive, {
      title: "Go-live plan",
      addMeet: false,
      guests: [{ personId: "p-matteo" }, { email: "Anna@Example.org" }, { personId: "p-alessia" }],
    });
    const e = ev(C.goLive);
    expect(e).toMatchObject({ title: "Go-live plan", meetUrl: null });
    expect(e.attendees.map((a) => [a.email, a.response, a.organizer])).toEqual([
      ["giulia.ferri@example.com", "accepted", true],
      ["matteo.conti@example.com", "accepted", false],
      ["anna@example.org", "needsAction", false],
      ["alessia.neri@example.com", "needsAction", false],
    ]);
    expect(e.calendarPersonIds).toEqual(["p-giulia", "p-matteo"]);
    await expect(calendar.updateEvent(C.goLive, { title: "  " })).rejects.toThrow("invalid: title");
  });
});

describe("Calendario: solo questo o tutta la serie", () => {
  it("«tutta la serie» sposta ogni data, «solo questo» una", async () => {
    as("p-matteo"); // organizza la revisione di AUD
    setLatency(20); // per vedere «in salvataggio» prima della conferma
    const before = new Map(seriesOf(SERIES_IDS.audReview).map((e) => [e.id, e.startsAt]));
    await calendar.moveEvent(
      "ev-aud-review-2026-10-29",
      "2026-10-29T16:30:00Z",
      "2026-10-29T17:00:00Z",
      "one",
    );
    for (const e of seriesOf(SERIES_IDS.audReview)) {
      if (e.id === "ev-aud-review-2026-10-29")
        expect([e.startsAt, e.endsAt]).toEqual(["2026-10-29T16:30:00Z", "2026-10-29T17:00:00Z"]);
      else expect(e.startsAt).toBe(before.get(e.id));
    }

    await calendar.moveEvent(
      "ev-aud-review-2026-11-05",
      "2026-11-05T14:30:00Z",
      "2026-11-05T15:30:00Z",
      "series",
    );
    for (const e of seriesOf(SERIES_IDS.audReview)) {
      const shifted = Date.parse(before.get(e.id)!) - 60 * 60_000;
      // Lo scarto vale da dove ciascuna era: quella spostata da sola resta 1 h più avanti.
      const expected =
        e.id === "ev-aud-review-2026-10-29" ? Date.parse("2026-10-29T15:30:00Z") : shifted;
      expect(Date.parse(e.startsAt)).toBe(expected);
      expect(Date.parse(e.endsAt) - Date.parse(e.startsAt)).toBe(60 * 60_000);
      expect(e.save?.state).toBe("saving");
    }
    await calendar.whenCalendarIdle();
    expect(seriesOf(SERIES_IDS.audReview).every((e) => e.save?.state === "saved")).toBe(true);
  });

  it("«tutta la serie» su un evento singolo non vale; elimina la serie intera", async () => {
    as("p-matteo");
    await expect(calendar.deleteEvent(C.visualsReview, "series")).rejects.toThrow("invalid: scope");
    await calendar.deleteEvent(EV_AUD_REVIEW_YESTERDAY, "one");
    expect(seriesOf(SERIES_IDS.audReview).length).toBeGreaterThan(0);
    await calendar.deleteEvent("ev-aud-review-2026-10-29", "series");
    expect(seriesOf(SERIES_IDS.audReview)).toEqual([]);
    expect(state.calendarSeries.some((s) => s.id === SERIES_IDS.audReview)).toBe(false);
  });

  it("una risposta per tutta la serie vale su ogni data a cui sono invitata", async () => {
    await calendar.respond("ev-stw-standup-2026-10-26", "declined", undefined, "series");
    expect(
      seriesOf(SERIES_IDS.stwStandup).every(
        (e) => e.attendees.find((a) => a.personId === "p-giulia")!.response === "declined",
      ),
    ).toBe(true);
  });
});

describe("Calendario: libero/occupato e «Trova un orario»", () => {
  it("solo intervalli, mai titoli; chi non è collegato o è scaduto lo dice", async () => {
    as("p-sara"); // non vede nessuno di questi eventi
    const fb = await calendar.freeBusy(
      ["p-giulia", "p-marco", "p-laura"],
      "2026-10-23T00:00:00Z",
      "2026-10-24T00:00:00Z",
    );
    expect(fb.map((f) => f.availability)).toEqual(["connected", "not_connected", "expired"]);
    expect(fb[0]!.busy).toContainEqual({
      startsAt: "2026-10-23T11:00:00Z",
      endsAt: "2026-10-23T12:00:00Z",
    });
    const text = JSON.stringify(fb);
    for (const e of state.calendarEvents) expect(text).not.toContain(e.title);
    expect(Object.keys(fb[0]!.busy[0]!).sort()).toEqual(["endsAt", "startsAt"]);
  });

  it("un evento rifiutato o tutto il giorno non occupa", async () => {
    const [giulia] = await calendar.freeBusy(
      ["p-giulia"],
      "2026-11-04T00:00:00Z",
      "2026-11-05T00:00:00Z",
    );
    // Lo standup sì; la consegna di AUD delle 10, rifiutata, no.
    expect(giulia!.busy).toEqual([
      { startsAt: "2026-11-04T09:00:00Z", endsAt: "2026-11-04T09:15:00Z" },
    ]);
    const [press] = await calendar.freeBusy(
      ["p-matteo"],
      "2026-10-23T00:00:00Z",
      "2026-10-24T00:00:00Z",
    );
    expect(press!.busy.some((b) => b.startsAt === "2026-10-23T00:00:00Z")).toBe(false);
  });

  it("il primo spazio libero per tutti, fra le 8 e le 20", async () => {
    // Giulia: standup 9:00–9:15, poi libera fino alle 11.
    expect(
      await calendar.findFirstFreeSlot(["p-giulia", "p-matteo"], 60, "2026-10-23T09:00:00Z"),
    ).toEqual({ startsAt: "2026-10-23T09:15:00Z", endsAt: "2026-10-23T10:15:00Z" });
    // Dalle 10:50 servono 2 ore: 11–12, 12:30–13:30, 14–15, 16–16:45 occupati → 16:45.
    expect(
      await calendar.findFirstFreeSlot(["p-giulia", "p-matteo"], 120, "2026-10-23T10:50:00Z"),
    ).toEqual({ startsAt: "2026-10-23T16:45:00Z", endsAt: "2026-10-23T18:45:00Z" });
    expect(await calendar.findFirstFreeSlot(["p-giulia"], 120, "2026-10-23T19:00:00Z")).toBeNull();
  });
});

describe("Calendario: proposte", () => {
  it("una scadenza futura propone un traguardo; passata o rifiutata mai", () => {
    expect(proposalOf(C.deadline)).toMatchObject({
      source: "calendar",
      projectId: MKX,
      status: "open",
      actions: [
        {
          fn: "createMilestone",
          args: { projectId: MKX, name: "Launch visuals", dueDate: "2026-11-06" },
        },
      ],
    });
    expect(proposalOf(C.pastDeadline)).toBeUndefined();
    expect(proposalOf(C.declinedDeadline)).toBeUndefined();
    // Una riunione normale non ne produce: solo la scadenza e le date in
    // anticipo delle serie accese (la richiesta di MKX, il promemoria di AUD).
    expect(calendarProposalIds()).toEqual([
      "mp-ser-ev-mkx-planning-2026-10-26",
      "mp-ser-ev-aud-review-2026-10-29",
      "mp-cal-ev-mkx-visuals-deadline",
    ]);
  });

  it("la vedono i partecipanti membri; chi rifiuta non la vede più", async () => {
    const id = proposalOf(C.deadline)!.id;
    expect(await mail.getMailProposal(id)).toMatchObject({ canHand: false });
    as("p-matteo");
    await expect(mail.getMailProposal(id)).resolves.toBeTruthy();
    as("p-elena"); // membro di MKX, non invitata
    await expect(mail.getMailProposal(id)).rejects.toThrow("not_found");
    as("p-giulia");
    await calendar.respond(C.deadline, "declined");
    await expect(mail.getMailProposal(id)).rejects.toThrow("not_found");
  });

  it("l'allineamento propone le scadenze nuove, non quelle passate", async () => {
    const view = await calendar.createEvent({
      title: "Deadline: AUD acceptance checklist",
      startsAt: "2026-11-10T00:00:00Z",
      endsAt: "2026-11-11T00:00:00Z",
      allDay: true,
      projectId: AUD,
      guests: [{ personId: "p-laura" }],
    });
    await calendar.createEvent({
      title: "Deadline: AUD old thing",
      startsAt: "2026-10-01T00:00:00Z",
      endsAt: "2026-10-02T00:00:00Z",
      allDay: true,
      projectId: AUD,
    });
    setLatency(20);
    await calendar.syncCalendar();
    expect(state.calendarSync.find((c) => c.personId === "p-giulia")!.sync).toBe("syncing");
    await calendar.whenCalendarIdle();
    expect((await calendar.listCalendars())[0]).toMatchObject({
      sync: "ok",
      syncedAt: "2026-10-23T12:00:00Z",
      stale: false,
    });
    expect(proposalOf(view.id)).toMatchObject({ projectId: AUD, status: "open" });
    expect(calendarProposalIds()).toHaveLength(4);
  });

  it("il collegamento scaduto non si allinea; il calendario vecchio si vede", async () => {
    as("p-laura");
    await expect(calendar.syncCalendar()).rejects.toThrow("google_not_connected");
    expect((await calendar.listCalendars())[0]).toMatchObject({ expired: true, sync: "failed" });
    as("p-matteo");
    expect((await calendar.listCalendars())[0]).toMatchObject({ stale: true, expired: false });
  });
});

describe("Calendario: progetto dell'evento", () => {
  it("la correzione vale per tutti; solo verso un progetto di cui si è membri", async () => {
    as("p-matteo"); // non è in STW
    await expect(calendar.setEventProject(C.visualsReview, STW)).rejects.toThrow("not_found");
    expect(ev(C.visualsReview)).toMatchObject({ projectId: MKX, projectBy: "model" });

    as("p-giulia");
    expect(await calendar.setEventProject(C.visualsReview, STW)).toMatchObject({
      projectId: STW,
      projectBy: "manual",
    });
    as("p-matteo"); // vede l'evento, non il progetto
    expect(await calendar.getEvent(C.visualsReview)).toMatchObject({ projectId: null });
    // …e un progetto che non vede non lo toglie.
    await expect(calendar.setEventProject(C.visualsReview, null)).rejects.toThrow("forbidden");
    as("p-giulia");
    await calendar.setEventProject(C.visualsReview, null);
    expect(ev(C.visualsReview)).toMatchObject({ projectId: null, projectBy: null });
  });

  it("una proposta aperta segue il progetto dell'evento", async () => {
    await calendar.setEventProject(C.deadline, AUD);
    expect(proposalOf(C.deadline)).toMatchObject({
      projectId: AUD,
      actions: [{ args: { projectId: AUD } }],
    });
    await calendar.setEventProject(C.deadline, null);
    expect(proposalOf(C.deadline)).toBeUndefined();
  });

  it("la proposta di una serie resta del progetto della serie, anche se cambia quello di una data", async () => {
    const id = "mp-ser-ev-aud-review-2026-10-29";
    const before = structuredClone(state.mailProposals.find((p) => p.id === id)!);
    expect(before).toMatchObject({ status: "open", projectId: AUD });
    as("p-matteo"); // in AUD e MKX
    await calendar.setEventProject("ev-aud-review-2026-10-29", MKX);
    expect(state.mailProposals.find((p) => p.id === id)).toEqual(before);
    await calendar.setEventProject("ev-aud-review-2026-10-29", null);
    expect(state.mailProposals.find((p) => p.id === id)).toEqual(before);
  });
});

describe("Calendario: configurazione delle serie", () => {
  it("accesa senza progetto → choose_project_first; poi con il progetto", async () => {
    await expect(
      calendar.configureSeries(SERIES_IDS.stwStandup, { enabled: true }),
    ).rejects.toThrow("choose_project_first");
    expect(state.calendarSeries.find((s) => s.id === SERIES_IDS.stwStandup)!.enabled).toBe(false);
    await expect(
      calendar.configureSeries(SERIES_IDS.stwStandup, { projectId: STW, leadDays: 15 }),
    ).rejects.toThrow("invalid: leadDays");
    expect(
      await calendar.configureSeries(SERIES_IDS.stwStandup, {
        projectId: STW,
        enabled: true,
        action: "request",
        leadDays: 2,
        auto: true,
      }),
    ).toMatchObject({ enabled: true, projectId: STW, action: "request", leadDays: 2, auto: true });
    // Togliere il progetto a una serie accesa no: prima si spegne.
    await expect(
      calendar.configureSeries(SERIES_IDS.stwStandup, { projectId: null }),
    ).rejects.toThrow("choose_project_first");
  });

  it("una serie che non vedo non c'è; un progetto di cui non sono membro neppure", async () => {
    as("p-sara");
    await expect(calendar.configureSeries(SERIES_IDS.stwStandup, {})).rejects.toThrow("not_found");
    as("p-matteo");
    await expect(
      calendar.configureSeries(SERIES_IDS.audReview, { projectId: STW }),
    ).rejects.toThrow("not_found");
  });

  it("configurare una serie propone solo le date di quella serie, non gli altri eventi", async () => {
    // Due proposte che l'allineamento rifarebbe: la scadenza dei visual e la pianificazione di MKX.
    const others = ["mp-cal-ev-mkx-visuals-deadline", "mp-ser-ev-mkx-planning-2026-10-26"];
    state.mailProposals = state.mailProposals.filter((p) => !others.includes(p.id));
    await calendar.configureSeries(SERIES_IDS.stwStandup, {
      projectId: STW,
      enabled: true,
      leadDays: 3,
    });
    expect(proposalOf("ev-stw-standup-2026-10-26")).toBeDefined();
    expect(state.mailProposals.filter((p) => others.includes(p.id))).toEqual([]);
    // L'allineamento invece guarda tutto il calendario.
    await calendar.syncCalendar();
    await calendar.whenCalendarIdle();
    expect(state.mailProposals.filter((p) => others.includes(p.id))).toHaveLength(2);
  });

  it("una serie di un progetto che non vedo: né progetto, né accesa/spenta, né «Agisci da solo» (R-I12)", async () => {
    // Chiara vede una data della revisione di AUD, ma AUD non lo vede.
    ev("ev-aud-review-2026-10-29").calendarPersonIds.push("p-chiara");
    const s = state.calendarSeries.find((x) => x.id === SERIES_IDS.audReview)!;
    const before = { ...s };
    expect(visibleProjectIds("p-chiara").has(AUD)).toBe(false);
    as("p-chiara");
    for (const patch of [
      { projectId: null, enabled: false }, // «Rimuovi configurazione»
      { projectId: MKX },
      { enabled: false },
      { auto: !s.auto },
      { leadDays: 1 },
    ]) {
      await expect(calendar.configureSeries(SERIES_IDS.audReview, patch)).rejects.toThrow(
        "forbidden",
      );
    }
    expect(s).toEqual(before);
  });
});

describe("Calendario: Prossimi appuntamenti", () => {
  it("da adesso a fine di domani: niente oltre, niente di finito, niente di rifiutato", async () => {
    await calendar.createEvent({
      title: "Saturday late",
      startsAt: "2026-10-24T23:00:00Z",
      endsAt: "2026-10-24T23:30:00Z",
    });
    await calendar.createEvent({
      title: "Sunday early",
      startsAt: "2026-10-25T00:00:00Z",
      endsAt: "2026-10-25T00:30:00Z",
    });
    const upcoming = await calendar.listUpcomingEvents();
    const titles = upcoming.map((e) => e.title);
    expect(titles).toContain("Saturday late");
    expect(titles).not.toContain("Sunday early");
    expect(titles).not.toContain("Go-live plan with Sofia"); // finita alle 12:00
    expect(titles).toContain("Lunch with Anna");
    expect(upcoming.find((e) => e.id === C.invite)).toMatchObject({ myResponse: "needsAction" });
    await calendar.respond(C.invite, "declined");
    expect((await calendar.listUpcomingEvents()).map((e) => e.id)).not.toContain(C.invite);
  });
});

describe("Calendario: salvataggio verso Google", () => {
  it("una riunione nuova: saving → saved, con Meet e invitati", async () => {
    const view = await calendar.createEvent({
      title: "  Sync with Laura ",
      startsAt: "2026-10-27T14:00:00Z",
      endsAt: "2026-10-27T14:30:00Z",
      guests: [{ personId: "p-laura" }, { email: "client@outside.example", name: "Client" }],
      addMeet: true,
      projectId: AUD,
    });
    expect(view).toMatchObject({
      title: "Sync with Laura",
      isOrganizer: true,
      projectBy: "manual",
      save: { state: "saving" },
      calendarPersonIds: ["p-giulia", "p-laura"],
    });
    expect(view.meetUrl).toMatch(/^https:\/\/meet\.google\.com\//);
    expect(view.attendees.map((a) => a.response)).toEqual([
      "accepted",
      "needsAction",
      "needsAction",
    ]);
    await calendar.whenCalendarIdle();
    expect(ev(view.id).save).toEqual({ state: "saved" });
  });

  it("riunione nuova non valida o in un progetto non mio: nulla creato", async () => {
    const n = state.calendarEvents.length;
    const base = { title: "X", startsAt: "2026-10-27T14:00:00Z", endsAt: "2026-10-27T14:30:00Z" };
    await expect(calendar.createEvent({ ...base, title: "" })).rejects.toThrow("invalid: title");
    await expect(calendar.createEvent({ ...base, endsAt: base.startsAt })).rejects.toThrow(
      "invalid: time",
    );
    await expect(
      calendar.createEvent({ ...base, guests: [{ personId: "p-nobody" }] }),
    ).rejects.toThrow("invalid: guest");
    const outside = state.projects.find((p) => !p.memberIds.includes("p-giulia"))!.id;
    await expect(calendar.createEvent({ ...base, projectId: outside })).rejects.toThrow(
      "not_found",
    );
    as("p-marco"); // senza account Google
    await expect(calendar.createEvent(base)).rejects.toThrow("google_not_connected");
    expect(state.calendarEvents).toHaveLength(n);
  });

  it("l'evento del seme fallisce al primo salvataggio: Annulla la modifica, poi riesce", async () => {
    setLatency(20);
    await calendar.moveEvent(C.saveFails, "2026-10-27T11:00:00Z", "2026-10-27T11:30:00Z");
    expect(ev(C.saveFails).save).toEqual({ state: "saving" });
    await calendar.whenCalendarIdle();
    expect(ev(C.saveFails)).toMatchObject({
      startsAt: "2026-10-27T11:00:00Z",
      save: { state: "failed", error: "rejected" },
    });
    await calendar.revertEvent(C.saveFails);
    expect(ev(C.saveFails).startsAt).toBe("2026-10-27T10:00:00Z");
    expect(ev(C.saveFails).save).toBeUndefined();
    await calendar.moveEvent(C.saveFails, "2026-10-27T11:00:00Z", "2026-10-27T11:30:00Z");
    await calendar.whenCalendarIdle();
    expect(ev(C.saveFails)).toMatchObject({
      startsAt: "2026-10-27T11:00:00Z",
      save: { state: "saved" },
    });
  });

  it("un salvataggio fallito si riprova; una riunione nuova annullata sparisce", async () => {
    failNext("calendar.advanceSave");
    const view = await calendar.createEvent({
      title: "Retry me",
      startsAt: "2026-10-27T14:00:00Z",
      endsAt: "2026-10-27T14:30:00Z",
    });
    await calendar.whenCalendarIdle();
    expect(ev(view.id).save).toEqual({ state: "failed", error: "unreachable" });
    await expect(calendar.revertEvent(C.goLive)).rejects.toThrow("invalid: not failed");
    await calendar.retrySave(view.id);
    await calendar.whenCalendarIdle();
    expect(ev(view.id).save).toEqual({ state: "saved" });

    failNext("calendar.advanceSave");
    const gone = await calendar.createEvent({
      title: "Gone",
      startsAt: "2026-10-28T14:00:00Z",
      endsAt: "2026-10-28T14:30:00Z",
    });
    await calendar.whenCalendarIdle();
    await calendar.revertEvent(gone.id);
    expect(state.calendarEvents.some((e) => e.id === gone.id)).toBe(false);
  });

  it("un ripristino durante il salvataggio non scrive nello stato nuovo", async () => {
    setLatency(20);
    const view = await calendar.createEvent({
      title: "Before reset",
      startsAt: "2026-10-27T14:00:00Z",
      endsAt: "2026-10-27T14:30:00Z",
    });
    resetApi();
    await calendar.whenCalendarIdle();
    expect(state.calendarEvents.some((e) => e.id === view.id)).toBe(false);
    expect(state.calendarEvents.every((e) => e.save === undefined)).toBe(true);
  });
});

describe("Calendario: proposte delle serie accese", () => {
  const PLANNING_DUE = "ev-mkx-planning-2026-10-26";
  const NOW = "2026-10-23T12:00:00Z";

  it("una serie accesa propone la data entrata nei giorni di anticipo, una per data", async () => {
    expect(proposalOf(PLANNING_DUE)).toMatchObject({
      id: "mp-ser-ev-mkx-planning-2026-10-26",
      projectId: MKX,
      status: "open",
      actions: [
        {
          fn: "createRequest",
          args: { projectId: MKX, title: "Content planning · 2026-10-26" },
        },
      ],
    });
    // Lunedì 2 novembre è a 10 giorni: non ancora.
    expect(proposalOf("ev-mkx-planning-2026-11-02")).toBeUndefined();
    expect(await mail.getMailProposal(proposalOf(PLANNING_DUE)!.id)).toMatchObject({
      canHand: false,
    });
  });

  it("una serie spenta non propone nulla", () => {
    expect(series(SERIES_IDS.stwStandup).enabled).toBe(false);
    expect(seriesOf(SERIES_IDS.stwStandup).some((e) => proposalOf(e.id))).toBe(false);
  });

  it("mai da una data passata o rifiutata da tutti; il promemoria è una presa d'atto", () => {
    const s = { ...series(SERIES_IDS.mkxPlanning), action: "remind" as const, leadDays: 14 };
    const due = structuredClone(ev(PLANNING_DUE));
    expect(seriesProposal(s, due, NOW)!.actions).toEqual([
      {
        fn: "acknowledgeReminder",
        args: { title: "Content planning", date: "2026-10-26" },
        summary: "Reminder: Content planning · 2026-10-26",
      },
    ]);
    expect(seriesProposal(s, ev("ev-mkx-planning-2026-10-19"), NOW)).toBeNull();
    for (const a of due.attendees) a.response = "declined";
    expect(seriesProposal(s, due, NOW)).toBeNull();
    expect(seriesProposal({ ...s, enabled: false }, ev(PLANNING_DUE), NOW)).toBeNull();
    expect(seriesProposal({ ...s, leadDays: 2 }, ev(PLANNING_DUE), NOW)).toBeNull();
    // «Ricordamelo» con «Agisci da solo»: non c'è niente da fare da soli, nessuna proposta.
    expect(seriesProposal({ ...s, auto: true }, ev(PLANNING_DUE), NOW)).toBeNull();
  });

  it("il promemoria si conferma senza permessi e non crea nulla", async () => {
    const id = proposalOf("ev-aud-review-2026-10-29")!.id;
    expect(proposalOf("ev-aud-review-2026-10-29")!.actions.map((a) => a.fn)).toEqual([
      "acknowledgeReminder",
    ]);
    // Marco: partecipante e membro di AUD, con un ruolo che non crea nulla.
    as("p-marco");
    grantProjectRole("p-marco", AUD, "viewer");
    expect(await mail.getMailProposal(id)).toMatchObject({ canConfirm: true, canHand: false });
    const before = {
      tasks: state.tasks.length,
      requests: state.requests.length,
      milestones: state.milestones.length,
      decisions: state.decisionLog.length,
    };
    expect(await mail.confirmMailProposal(id)).toEqual({ status: "confirmed", resultCodes: [] });
    expect({
      tasks: state.tasks.length,
      requests: state.requests.length,
      milestones: state.milestones.length,
      decisions: state.decisionLog.length,
    }).toEqual(before);
    expect(proposalOf("ev-aud-review-2026-10-29")).toMatchObject({
      status: "confirmed",
      decidedById: "p-marco",
    });
    as("p-elena"); // membro di AUD, non partecipante
    await expect(mail.getMailProposal(id)).rejects.toThrow("not_found");
  });

  it("«Ricordamelo» con «Agisci da solo»: niente in automatico, nessuna proposta", async () => {
    await calendar.configureSeries(SERIES_IDS.stwStandup, {
      projectId: STW,
      enabled: true,
      action: "remind",
      leadDays: 3,
      auto: true,
    });
    expect(seriesOf(SERIES_IDS.stwStandup).some((e) => proposalOf(e.id))).toBe(false);
  });

  it("accenderla propone le date già in anticipo, nessuna all'indietro", async () => {
    await calendar.configureSeries(SERIES_IDS.stwStandup, {
      projectId: STW,
      enabled: true,
      leadDays: 3,
    });
    const fromStandup = seriesOf(SERIES_IDS.stwStandup).filter((e) => proposalOf(e.id));
    // Oggi alle 9 è passato; lunedì 26 è a 3 giorni, martedì 27 a 4.
    expect(fromStandup.map((e) => e.id)).toEqual(["ev-stw-standup-2026-10-26"]);
    expect(proposalOf("ev-stw-standup-2026-10-26")).toMatchObject({ status: "open" });
  });

  it("«Agisci da solo» senza il permesso dell'azione: la proposta resta fallita, nulla creato", async () => {
    // Giulia in STW non ha `tickets.edit`: il traguardo non nasce.
    expect(can(viewerFor("p-giulia"), "tickets.edit", STW)).toBe(false);
    const milestones = state.milestones.length;
    await calendar.configureSeries(SERIES_IDS.stwStandup, {
      projectId: STW,
      enabled: true,
      action: "milestone",
      leadDays: 3,
      auto: true,
    });
    expect(proposalOf("ev-stw-standup-2026-10-26")).toMatchObject({
      status: "failed",
      error: "forbidden",
      decidedById: null,
    });
    expect(state.milestones).toHaveLength(milestones);
  });

  it("«Agisci da solo»: nasce confermata da Stubwise, crea il traguardo, nessun lavoro di Claude", async () => {
    grantProjectRole("p-giulia", STW, "project_lead");
    const conversations = state.conversations.length;
    await calendar.configureSeries(SERIES_IDS.stwStandup, {
      projectId: STW,
      enabled: true,
      action: "milestone",
      leadDays: 3,
      auto: true,
    });
    const p = proposalOf("ev-stw-standup-2026-10-26")!;
    expect(p).toMatchObject({
      status: "confirmed",
      decidedById: null,
      decidedAt: "2026-10-23T12:00:00Z",
    });
    expect(p.actions.map((a) => a.fn)).toEqual(["createMilestone"]);
    expect(
      state.milestones.filter((m) => m.projectId === STW && m.name === "Standup · 2026-10-26"),
    ).toHaveLength(1);
    expect(state.conversations).toHaveLength(conversations);
    // Già decisa: non torna fra quelle «Da decidere».
    expect((await mail.listMailDecisions()).map((v) => v.proposal.id)).not.toContain(p.id);
  });

  it("l'allineamento propone una data che entra nei giorni di anticipo", async () => {
    series(SERIES_IDS.mkxPlanning).leadDays = 10;
    await calendar.syncCalendar();
    await calendar.whenCalendarIdle();
    expect(proposalOf("ev-mkx-planning-2026-11-02")).toMatchObject({ status: "open" });
  });
});

describe("Calendario: correzioni di revisione", () => {
  it("una scadenza «tutto il giorno» di oggi propone ancora", async () => {
    const at = "2026-10-23T12:00:00Z";
    expect(isUpcoming({ startsAt: "2026-10-23T00:00:00Z", allDay: true }, at)).toBe(true);
    expect(isUpcoming({ startsAt: "2026-10-23T11:00:00Z", allDay: false }, at)).toBe(false);
    const view = await calendar.createEvent({
      title: "Deadline: AUD signed plan",
      startsAt: "2026-10-23T00:00:00Z",
      endsAt: "2026-10-24T00:00:00Z",
      allDay: true,
      projectId: AUD,
    });
    await calendar.syncCalendar();
    await calendar.whenCalendarIdle();
    expect(proposalOf(view.id)).toMatchObject({
      actions: [{ fn: "createMilestone", args: { dueDate: "2026-10-23" } }],
    });
  });

  it("libero/occupato: solo dentro la finestra; un intervallo non valido è invalid", async () => {
    // La revisione del budget del 15 gennaio è nel calendario di Giulia, ma fuori finestra.
    const [giulia] = await calendar.freeBusy(
      ["p-giulia"],
      "2027-01-01T00:00:00Z",
      "2027-02-01T00:00:00Z",
    );
    expect(giulia!.busy).toEqual([]);
    await expect(calendar.freeBusy(["p-giulia"], "nope", "2027-01-01T00:00:00Z")).rejects.toThrow(
      "invalid: range",
    );
    await expect(calendar.findFirstFreeSlot(["p-giulia"], 30, "nope")).rejects.toThrow(
      "invalid: range",
    );
  });

  it("una serie spostata che fallisce: «Annulla la modifica» le rimette tutte", async () => {
    as("p-matteo");
    const before = seriesOf(SERIES_IDS.audReview).map((e) => [e.id, e.startsAt, e.endsAt]);
    failNext("calendar.advanceSave");
    await calendar.moveEvent(
      "ev-aud-review-2026-10-29",
      "2026-10-29T16:30:00Z",
      "2026-10-29T17:30:00Z",
      "series",
    );
    await calendar.whenCalendarIdle();
    expect(seriesOf(SERIES_IDS.audReview).every((e) => e.save?.state === "failed")).toBe(true);
    await calendar.revertEvent("ev-aud-review-2026-11-05");
    expect(seriesOf(SERIES_IDS.audReview).map((e) => [e.id, e.startsAt, e.endsAt])).toEqual(before);
    expect(seriesOf(SERIES_IDS.audReview).every((e) => e.save === undefined)).toBe(true);
  });

  it("«Riprova» riparte con tutto il gruppo", async () => {
    as("p-matteo");
    failNext("calendar.advanceSave");
    await calendar.moveEvent(
      "ev-aud-review-2026-10-29",
      "2026-10-29T16:30:00Z",
      "2026-10-29T17:30:00Z",
      "series",
    );
    await calendar.whenCalendarIdle();
    await calendar.retrySave(EV_AUD_REVIEW_YESTERDAY);
    await calendar.whenCalendarIdle();
    expect(seriesOf(SERIES_IDS.audReview).every((e) => e.save?.state === "saved")).toBe(true);
  });

  it("senza una versione di Google nota «Annulla la modifica» non toglie nulla", async () => {
    ev(C.goLive).save = { state: "failed", error: "rejected" };
    await expect(calendar.revertEvent(C.goLive)).rejects.toThrow("invalid: no version");
    expect(ev(C.goLive)).toBeDefined();
  });

  it("eliminare un evento toglie le sue proposte aperte", async () => {
    as("p-matteo"); // organizza la scadenza e la pianificazione di MKX
    await calendar.deleteEvent(C.deadline);
    expect(proposalOf(C.deadline)).toBeUndefined();
    await calendar.deleteEvent("ev-mkx-planning-2026-10-26", "series");
    expect(proposalOf("ev-mkx-planning-2026-10-26")).toBeUndefined();
    // Resta solo il promemoria di AUD: un'altra serie.
    expect(calendarProposalIds()).toEqual(["mp-ser-ev-aud-review-2026-10-29"]);
  });

  it("un progetto che non vedo non lo tolgo né lo cambio", async () => {
    as("p-matteo"); // non è in OLV
    ev(C.invite).calendarPersonIds.push("p-matteo");
    await expect(calendar.setEventProject(C.invite, null)).rejects.toThrow("forbidden");
    await expect(calendar.setEventProject(C.invite, MKX)).rejects.toThrow("forbidden");
    expect(ev(C.invite)).toMatchObject({ projectId: "prj-olv", projectBy: "model" });
  });
});
