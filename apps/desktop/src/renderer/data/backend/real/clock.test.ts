import { afterEach, describe, expect, it } from "vitest";
import { advanceClock, isoWeek, subscribeClock, today } from "./clock";

// L'orologio della build app (fix della fetta 2): «oggi» e la settimana
// corrente sono quelli di Europe/Rome, come la settimana effettiva del server,
// e avanzano mentre l'app resta aperta. I test girano con TZ=UTC: a Londra in
// novembre l'ora locale è quella UTC.

afterEach(() => advanceClock(new Date()));

describe("l'orologio della build app", () => {
  it("alle 23:30 di domenica a Londra è già la settimana nuova", () => {
    // Domenica 15 novembre 2026, 23:30 a Londra = lunedì 16, 00:30 a Roma.
    advanceClock(new Date("2026-11-15T23:30:00Z"));
    expect(today()).toBe("2026-11-16");
    expect(isoWeek(today())).toBe("2026-W47");
  });

  it("avvisa chi ascolta solo quando cambia il giorno", () => {
    advanceClock(new Date("2026-11-14T10:00:00Z"));
    let calls = 0;
    const stop = subscribeClock(() => calls++);
    advanceClock(new Date("2026-11-14T20:00:00Z"));
    expect(calls).toBe(0);
    advanceClock(new Date("2026-11-14T23:10:00Z"));
    expect(calls).toBe(1);
    expect(today()).toBe("2026-11-15");
    stop();
    advanceClock(new Date("2026-11-16T10:00:00Z"));
    expect(calls).toBe(1);
  });
});
