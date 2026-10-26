import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isAppRoute } from "../../data/routes";
import {
  calendarSearch,
  canStep,
  clampDay,
  isCalendarSearchValue,
  outsideWindow,
  parseDayKey,
  resolveCalendar,
  windowDays,
} from "./calendarParams";

// I parametri del Calendario (`#/calendar?view&date&event&series`) e i bordi
// della finestra letta (shape calendar.md §5, [A 3]): 23 settembre – 22
// dicembre, a giorni interi.

const WINDOW = { from: "2026-09-23T00:00:00Z", to: "2026-12-23T00:00:00Z" };
const W = windowDays(WINDOW);

describe("parametri del Calendario nell'indirizzo", () => {
  it("valida view, date, event e series solo su #/calendar", () => {
    expect(isAppRoute("#/calendar?view=day&date=2026-10-28&event=ev-overlap-01")).toBe(true);
    expect(isAppRoute("#/calendar?view=month")).toBe(true);
    expect(isAppRoute("#/calendar?series=ser-aud-weekly-review")).toBe(true);
    expect(isAppRoute("#/calendar?view=year")).toBe(false);
    expect(isAppRoute("#/calendar?date=2026-13-40")).toBe(false);
    expect(isAppRoute("#/calendar?event=bad id")).toBe(false);
    expect(isAppRoute("#/mail?event=ev-1")).toBe(false);
    expect(isCalendarSearchValue("view", "week")).toBe(true);
    expect(isCalendarSearchValue("date", "2026-02-30")).toBe(false);
  });

  it("la finestra è 23 settembre – 22 dicembre, compresi", () => {
    expect(W).toEqual({ first: "2026-09-23", last: "2026-12-22" });
  });

  it("senza parametri: Week di oggi; una data fuori finestra torna al bordo più vicino", () => {
    expect(resolveCalendar({}, "2026-10-23", W)).toMatchObject({
      view: "week",
      date: "2026-10-23",
    });
    expect(resolveCalendar({ view: "day", date: "2027-03-01" }, "2026-10-23", W)).toMatchObject({
      view: "day",
      date: "2026-12-22",
    });
    expect(clampDay("2026-01-01", W)).toBe("2026-09-23");
    expect(clampDay("2026-11-11", W)).toBe("2026-11-11");
  });

  it("calendarSearch omette i valori di default", () => {
    expect(calendarSearch({ view: "week", date: "2026-10-23" }, "2026-10-23")).toEqual({
      view: undefined,
      date: undefined,
    });
    expect(calendarSearch({ view: "day", date: "2026-10-28" }, "2026-10-23")).toEqual({
      view: "day",
      date: "2026-10-28",
    });
  });
});

describe("⌘K «New meeting»: `?newMeeting=1`", () => {
  it("vale solo `1`, e solo sul Calendario", () => {
    expect(isCalendarSearchValue("newMeeting", "1")).toBe(true);
    expect(isCalendarSearchValue("newMeeting", "2")).toBe(false);
    expect(isCalendarSearchValue("newMeeting", "")).toBe(false);
    expect(isAppRoute("#/calendar?newMeeting=1")).toBe(true);
    expect(isAppRoute("#/calendar?newMeeting=2")).toBe(false);
    expect(isAppRoute("#/mail?newMeeting=1")).toBe(false);
  });
});

describe("bordi della finestra (Review Focus 3)", () => {
  it("‹ e › si fermano solo quando l'intervallo intero è fuori", () => {
    // La settimana del 21 settembre tocca il 23: si arriva; quella prima no.
    expect(canStep("week", parseDayKey("2026-09-28"), -1, W)).toBe(true);
    expect(canStep("week", parseDayKey("2026-09-21"), -1, W)).toBe(false);
    // Day: il 23 settembre è il primo giorno.
    expect(canStep("day", parseDayKey("2026-09-23"), -1, W)).toBe(false);
    expect(canStep("day", parseDayKey("2026-09-24"), -1, W)).toBe(true);
    expect(canStep("day", parseDayKey("2026-12-22"), 1, W)).toBe(false);
    // Month: settembre tocca la finestra, agosto no; dicembre è l'ultimo.
    expect(canStep("month", parseDayKey("2026-09-01"), -1, W)).toBe(false);
    expect(canStep("month", parseDayKey("2026-10-01"), -1, W)).toBe(true);
    expect(canStep("month", parseDayKey("2026-12-01"), 1, W)).toBe(false);
    expect(canStep("month", parseDayKey("2026-11-01"), 1, W)).toBe(true);
  });

  it("i giorni fuori finestra sono segnati", () => {
    expect(outsideWindow(parseDayKey("2026-09-22"), W)).toBe(true);
    expect(outsideWindow(parseDayKey("2026-09-23"), W)).toBe(false);
    expect(outsideWindow(parseDayKey("2026-12-22"), W)).toBe(false);
    expect(outsideWindow(parseDayKey("2026-12-23"), W)).toBe(true);
  });

  describe("con TZ=America/Los_Angeles", () => {
    const ORIGINAL = process.env.TZ;
    beforeAll(() => {
      process.env.TZ = "America/Los_Angeles";
    });
    afterAll(() => {
      process.env.TZ = ORIGINAL;
    });

    it("i giorni della finestra restano le stesse date, non scivolano al giorno prima", () => {
      expect(new Date("2026-10-23T00:00:00Z").getTimezoneOffset()).toBe(420);
      expect(windowDays(WINDOW)).toEqual({ first: "2026-09-23", last: "2026-12-22" });
      expect(outsideWindow(parseDayKey("2026-09-23"), W)).toBe(false);
      expect(outsideWindow(parseDayKey("2026-12-23"), W)).toBe(true);
      expect(canStep("day", parseDayKey("2026-09-23"), -1, W)).toBe(false);
    });
  });
});
