import { describe, expect, it } from "vitest";
import {
  addWeeks,
  compareWeeks,
  currentIsoWeek,
  isIsoWeek,
  isoWeekToMonday,
  mondayToIsoWeek,
  slipOf,
  isoWeekDays,
  weeksBetween,
} from "./weeks.js";

describe("settimane ISO", () => {
  it("lunedì ↔ settimana, anche a cavallo d'anno (W53 → W01)", () => {
    expect(isoWeekToMonday("2026-W46")).toBe("2026-11-09");
    expect(mondayToIsoWeek("2026-11-09")).toBe("2026-W46");
    expect(mondayToIsoWeek("2026-12-28")).toBe("2026-W53");
    expect(isoWeekToMonday("2027-W01")).toBe("2027-01-04");
    expect(addWeeks("2026-W53", 1)).toBe("2027-W01");
    expect(addWeeks("2027-W01", -1)).toBe("2026-W53");
    expect(weeksBetween("2026-W52", "2027-W01")).toBe(2);
  });

  it("compareWeeks ordina per anno e numero; isoWeekDays è lunedì–venerdì", () => {
    expect(compareWeeks("2026-W53", "2027-W01")).toBeLessThan(0);
    expect(compareWeeks("2026-W46", "2026-W46")).toBe(0);
    expect(isoWeekDays("2026-W46")).toEqual(["2026-11-09", "2026-11-10", "2026-11-11", "2026-11-12", "2026-11-13"]);
  });

  it("una settimana che non esiste non è valida (2027 non ha la W53)", () => {
    expect(isIsoWeek("2026-W53")).toBe(true);
    expect(isIsoWeek("2027-W53")).toBe(false);
    expect(isIsoWeek("2026-W00")).toBe(false);
    expect(isIsoWeek("2026-46")).toBe(false);
  });

  it("la settimana corrente si legge nel fuso Europe/Rome", () => {
    // Domenica 8 nov 2026 alle 23:30 UTC è già lunedì 9 a Roma.
    expect(currentIsoWeek(new Date("2026-11-08T23:30:00Z"))).toBe("2026-W46");
    expect(currentIsoWeek(new Date("2026-11-08T21:00:00Z"))).toBe("2026-W45");
    // Il 31 dicembre 2026 è nella W53, il 4 gennaio 2027 nella W01.
    expect(currentIsoWeek(new Date("2026-12-31T12:00:00Z"))).toBe("2026-W53");
    expect(currentIsoWeek(new Date("2027-01-04T12:00:00Z"))).toBe("2027-W01");
  });
});

describe("slipOf (slittamento derivato)", () => {
  const current = "2026-W46";
  it("una task aperta della settimana scorsa è nella corrente con slipCount 1; due settimane fa → 2", () => {
    expect(slipOf({ plannedWeek: "2026-W45", slipCount: 0, closed: false }, current)).toEqual({
      plannedWeek: current,
      slipCount: 1,
    });
    expect(slipOf({ plannedWeek: "2026-W44", slipCount: 0, closed: false }, current)).toEqual({
      plannedWeek: current,
      slipCount: 2,
    });
  });

  it("chiusa: mai slittata; senza settimana o nel futuro: invariata", () => {
    expect(slipOf({ plannedWeek: "2026-W40", slipCount: 1, closed: true }, current)).toEqual({
      plannedWeek: "2026-W40",
      slipCount: 1,
    });
    expect(slipOf({ plannedWeek: null, slipCount: 0, closed: false }, current)).toEqual({ plannedWeek: null, slipCount: 0 });
    expect(slipOf({ plannedWeek: "2026-W47", slipCount: 2, closed: false }, current)).toEqual({
      plannedWeek: "2026-W47",
      slipCount: 2,
    });
  });

  it("a cavallo d'anno: W52 del 2026 vista dalla W01 del 2027 è slittata di 2", () => {
    expect(slipOf({ plannedWeek: "2026-W52", slipCount: 0, closed: false }, "2027-W01")).toEqual({
      plannedWeek: "2027-W01",
      slipCount: 2,
    });
  });
});
