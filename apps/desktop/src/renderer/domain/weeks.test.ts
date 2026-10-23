import { describe, expect, it } from "vitest";
import { addWeeks, compareWeeks, currentWeek, weekDays, weekLabel } from "./weeks";

describe("weeks", () => {
  it("la settimana corrente deriva da TODAY", () => {
    expect(currentWeek()).toBe("2026-W43");
  });

  it("addWeeks attraversa il cambio d'anno ISO (2026 ha 53 settimane)", () => {
    expect(addWeeks("2026-W43", 1)).toBe("2026-W44");
    expect(addWeeks("2026-W53", 1)).toBe("2027-W01");
    expect(addWeeks("2027-W01", -1)).toBe("2026-W53");
    expect(addWeeks("2026-W43", 0)).toBe("2026-W43");
  });

  it("compareWeeks ordina per anno e poi per numero", () => {
    expect(compareWeeks("2026-W53", "2027-W01")).toBeLessThan(0);
    expect(compareWeeks("2027-W01", "2026-W53")).toBeGreaterThan(0);
    expect(compareWeeks("2026-W10", "2026-W10")).toBe(0);
    expect(["2027-W01", "2026-W09", "2026-W10"].sort(compareWeeks)).toEqual([
      "2026-W09",
      "2026-W10",
      "2027-W01",
    ]);
  });

  it("weekDays dà lunedì–venerdì", () => {
    expect(weekDays("2026-W43")).toEqual([
      "2026-10-19",
      "2026-10-20",
      "2026-10-21",
      "2026-10-22",
      "2026-10-23",
    ]);
    expect(weekDays("2027-W01")[0]).toBe("2027-01-04");
  });

  it("weekLabel mostra lunedì – venerdì nella lingua richiesta", () => {
    expect(weekLabel("2026-W44", "it")).toBe("26 ott – 30 ott");
    expect(weekLabel("2026-W44", "en")).toBe("Oct 26 – Oct 30");
  });
});
