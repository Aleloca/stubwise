import { describe, expect, it } from "vitest";

import { localDate, scheduleDue } from "./schedule.js";

// Area 7, F2 (R6): quando cade un inizio a orario. La regola del prototipo
// (giornaliera, settimanale), più la MENSILE (Q13 = a: un giorno che il mese
// non ha cade all'ultimo) e il fuso: il worker usa Europe/Rome, il prototipo
// UTC. Il giorno e l'ora sono quelli del fuso, non del processo.

describe("scheduleDue", () => {
  it("giornaliera e settimanale: il giorno della regola, ora raggiunta", () => {
    expect(scheduleDue("FREQ=DAILY;BYHOUR=9", "2026-11-13T09:00:00.000Z", "UTC")).toBe(true);
    expect(scheduleDue("FREQ=DAILY;BYHOUR=9", "2026-11-13T08:59:00.000Z", "UTC")).toBe(false);
    // Il 13 novembre 2026 è un venerdì.
    expect(scheduleDue("FREQ=WEEKLY;BYDAY=MO,FR;BYHOUR=9", "2026-11-13T10:00:00.000Z", "UTC")).toBe(true);
    expect(scheduleDue("FREQ=WEEKLY;BYDAY=MO;BYHOUR=9", "2026-11-13T10:00:00.000Z", "UTC")).toBe(false);
  });

  it("mensile: il giorno del mese; uno che il mese non ha cade all'ultimo", () => {
    expect(scheduleDue("FREQ=MONTHLY;BYMONTHDAY=13;BYHOUR=9", "2026-11-13T09:00:00.000Z", "UTC")).toBe(true);
    expect(scheduleDue("FREQ=MONTHLY;BYMONTHDAY=12;BYHOUR=9", "2026-11-13T09:00:00.000Z", "UTC")).toBe(false);
    // Il 31 in un mese di 30 giorni cade il 30, e non anche il 1° dopo.
    expect(scheduleDue("FREQ=MONTHLY;BYMONTHDAY=31;BYHOUR=9", "2026-11-30T09:00:00.000Z", "UTC")).toBe(true);
    expect(scheduleDue("FREQ=MONTHLY;BYMONTHDAY=31;BYHOUR=9", "2026-12-01T09:00:00.000Z", "UTC")).toBe(false);
    // Febbraio: il 28 (2026) e il 29 (2028, bisestile).
    expect(scheduleDue("FREQ=MONTHLY;BYMONTHDAY=30;BYHOUR=0", "2026-02-28T00:00:00.000Z", "UTC")).toBe(true);
    expect(scheduleDue("FREQ=MONTHLY;BYMONTHDAY=30;BYHOUR=0", "2028-02-28T00:00:00.000Z", "UTC")).toBe(false);
    expect(scheduleDue("FREQ=MONTHLY;BYMONTHDAY=30;BYHOUR=0", "2028-02-29T00:00:00.000Z", "UTC")).toBe(true);
  });

  it("nel fuso di Roma: le 9 sono le 8 UTC d'inverno e le 7 d'estate", () => {
    const nine = "FREQ=DAILY;BYHOUR=9";
    expect(scheduleDue(nine, "2026-01-15T08:00:00.000Z", "Europe/Rome")).toBe(true);
    expect(scheduleDue(nine, "2026-01-15T07:59:00.000Z", "Europe/Rome")).toBe(false);
    expect(scheduleDue(nine, "2026-07-15T07:00:00.000Z", "Europe/Rome")).toBe(true);
    expect(scheduleDue(nine, "2026-07-15T06:59:00.000Z", "Europe/Rome")).toBe(false);
  });

  it("il giorno del cambio dell'ora (29 marzo 2026): le 9 di Roma sono le 7 UTC", () => {
    expect(scheduleDue("FREQ=DAILY;BYHOUR=9", "2026-03-29T07:00:00.000Z", "Europe/Rome")).toBe(true);
    expect(scheduleDue("FREQ=DAILY;BYHOUR=9", "2026-03-29T06:30:00.000Z", "Europe/Rome")).toBe(false);
  });

  it("su un fuso negativo il giorno è quello del fuso: a New York il 1° marzo alle 3 UTC è ancora il 28 febbraio", () => {
    const at = "2026-03-01T03:00:00.000Z";
    expect(scheduleDue("FREQ=MONTHLY;BYMONTHDAY=31;BYHOUR=21", at, "America/New_York")).toBe(true);
    expect(scheduleDue("FREQ=MONTHLY;BYMONTHDAY=1;BYHOUR=0", at, "America/New_York")).toBe(false);
    expect(scheduleDue("FREQ=MONTHLY;BYMONTHDAY=1;BYHOUR=0", at, "UTC")).toBe(true);
  });

  it("una regola che non conosce non cade mai", () => {
    expect(scheduleDue("FREQ=YEARLY;BYHOUR=9", "2026-11-13T10:00:00.000Z", "UTC")).toBe(false);
    expect(scheduleDue("FREQ=DAILY;BYHOUR=x", "2026-11-13T10:00:00.000Z", "UTC")).toBe(false);
  });
});

describe("localDate", () => {
  it("il giorno nel fuso, per la chiave «una volta al giorno»", () => {
    expect(localDate("2026-03-01T03:00:00.000Z", "America/New_York")).toBe("2026-02-28");
    expect(localDate("2026-03-01T03:00:00.000Z", "UTC")).toBe("2026-03-01");
    expect(localDate("2026-06-30T22:30:00.000Z", "Europe/Rome")).toBe("2026-07-01");
  });
});
