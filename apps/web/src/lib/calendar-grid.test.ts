import type { CalendarEventItem } from "@stubwise/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  addDays,
  allDayEventsForDay,
  eventDayKey,
  eventsForDay,
  localDayKey,
  monthGridDays,
  rangeForView,
  startOfWeek,
  stepAnchor,
  timedEventsForDay,
  weekDays,
} from "./calendar-grid";

/**
 * Funzioni pure della griglia (fase 9, Task 6) — la parte più facile da
 * sbagliare: i fusi orari (vedi il docblock di `calendar-grid.ts`). Fissa
 * `TZ` a un fuso NEGATIVO (New York, UTC-4/-5) apposta: è il caso che
 * scoprirebbe l'errore descritto nel piano — un evento "tutto il giorno"
 * letto con i getter locali scivolerebbe sul giorno prima.
 */
const ORIGINAL_TZ = process.env.TZ;

beforeAll(() => {
  process.env.TZ = "America/New_York";
});

afterAll(() => {
  process.env.TZ = ORIGINAL_TZ;
});

function event(overrides: Partial<CalendarEventItem> & Pick<CalendarEventItem, "id" | "startsAt">): CalendarEventItem {
  return {
    accountId: "acc-1",
    accountEmail: "mailbox@acme.test",
    recurringEventId: null,
    projectId: null,
    projectName: null,
    title: "Evento",
    organizer: null,
    attendees: [],
    endsAt: null,
    allDay: false,
    status: "new",
    outcome: null,
    error: null,
    url: null,
    eventUrl: null,
    reproposable: false,
    ...overrides,
  };
}

describe("eventDayKey — l'errore che il piano chiede di evitare", () => {
  it("un evento TUTTO IL GIORNO (mezzanotte UTC) resta sul SUO giorno, non su quello prima, in un fuso negativo", () => {
    // Mezzanotte UTC del 12 settembre: in America/New_York (UTC-4 d'estate)
    // sono le 20:00 dell'11. Letto con getter LOCALI cadrebbe sull'11.
    const allDay = event({ id: "e1", startsAt: "2026-09-12T00:00:00.000Z", allDay: true });
    expect(eventDayKey(allDay)).toBe("2026-09-12");
  });

  it("un evento CON ORARIO usa invece il giorno locale (diverso dal giorno UTC vicino alla mezzanotte)", () => {
    // 02:00 UTC del 12 = 22:00 dell'11 a New York: qui l'11 è quello giusto.
    const timed = event({ id: "e2", startsAt: "2026-09-12T02:00:00.000Z", allDay: false });
    expect(eventDayKey(timed)).toBe("2026-09-11");
  });
});

describe("localDayKey / startOfWeek / addDays / stepAnchor", () => {
  it("startOfWeek torna il lunedì (settimana lavorativa), anche partendo da domenica", () => {
    const sunday = new Date(2026, 8, 13); // domenica 13 settembre 2026 (locale)
    expect(localDayKey(startOfWeek(sunday))).toBe("2026-09-07");
  });

  it("weekDays produce 7 giorni consecutivi a partire dal lunedì", () => {
    const days = weekDays(new Date(2026, 8, 10));
    expect(days.map(localDayKey)).toEqual([
      "2026-09-07",
      "2026-09-08",
      "2026-09-09",
      "2026-09-10",
      "2026-09-11",
      "2026-09-12",
      "2026-09-13",
    ]);
  });

  it("stepAnchor su 'day' avanza di un giorno, su 'week' di sette, su 'month' di un mese", () => {
    const anchor = new Date(2026, 8, 10);
    expect(localDayKey(stepAnchor("day", anchor, 1))).toBe("2026-09-11");
    expect(localDayKey(stepAnchor("week", anchor, 1))).toBe("2026-09-17");
    expect(stepAnchor("month", anchor, 1).getMonth()).toBe(9); // ottobre
    expect(localDayKey(stepAnchor("day", anchor, -1))).toBe("2026-09-09");
  });

  it("monthGridDays include le settimane di contorno (giorni del mese prima/dopo)", () => {
    const days = monthGridDays(new Date(2026, 8, 15)); // settembre 2026: 1 è martedì
    expect(localDayKey(days[0]!)).toBe("2026-08-31"); // lunedì prima dell'1 settembre
    expect(days.length % 7).toBe(0);
    expect(days.some((d) => localDayKey(d) === "2026-09-01")).toBe(true);
    expect(days.some((d) => localDayKey(d) === "2026-09-30")).toBe(true);
  });

  it("rangeForView('day') copre esattamente [oggi, domani)", () => {
    const anchor = new Date(2026, 8, 10, 15, 30);
    const { from, to } = rangeForView("day", anchor);
    expect(localDayKey(from)).toBe("2026-09-10");
    expect(localDayKey(to)).toBe("2026-09-11");
    expect(to.getTime() - from.getTime()).toBe(24 * 60 * 60 * 1000);
  });
});

describe("timedEventsForDay — un evento a cavallo di mezzanotte (il caso richiesto dal piano)", () => {
  it("compare in ENTRAMBI i giorni che tocca, troncato ai confini di ciascuno", () => {
    // 23:00 dell'11 → 01:00 del 12, ora locale (New York).
    const spanning = event({
      id: "e3",
      startsAt: "2026-09-12T03:00:00.000Z", // 23:00 dell'11 a NY
      endsAt: "2026-09-12T05:00:00.000Z", // 01:00 del 12 a NY
    });

    const day11 = timedEventsForDay([spanning], new Date(2026, 8, 11));
    const day12 = timedEventsForDay([spanning], new Date(2026, 8, 12));

    expect(day11).toHaveLength(1);
    // Clippato a fine giornata: 23:00 di 24h → 23/24 = 95.8...%.
    expect(day11[0]!.topPct).toBeCloseTo((23 * 60 / 1440) * 100, 1);
    expect(day11[0]!.topPct + day11[0]!.heightPct).toBeCloseTo(100, 1);

    expect(day12).toHaveLength(1);
    // Clippato a inizio giornata: da 00:00 a 01:00 → 1/24 = ~4.2%.
    expect(day12[0]!.topPct).toBeCloseTo(0, 5);
    expect(day12[0]!.heightPct).toBeCloseTo((60 / 1440) * 100, 1);
  });

  it("un giorno che l'evento non tocca affatto: nessuna riga", () => {
    const e = event({ id: "e4", startsAt: "2026-09-12T14:00:00.000Z", endsAt: "2026-09-12T15:00:00.000Z" });
    expect(timedEventsForDay([e], new Date(2026, 8, 20))).toHaveLength(0);
  });

  it("un evento senza endsAt ottiene una durata minima visibile (30 minuti), non un'altezza nulla", () => {
    const e = event({ id: "e5", startsAt: "2026-09-12T14:00:00.000Z", endsAt: null });
    const [positioned] = timedEventsForDay([e], new Date(2026, 8, 12));
    expect(positioned!.heightPct).toBeGreaterThan(0);
  });

  it("gli eventi tutto il giorno NON compaiono qui: sono affare di allDayEventsForDay", () => {
    const allDay = event({ id: "e6", startsAt: "2026-09-12T00:00:00.000Z", allDay: true });
    expect(timedEventsForDay([allDay], new Date(2026, 8, 12))).toHaveLength(0);
  });
});

describe("allDayEventsForDay / eventsForDay", () => {
  it("un evento tutto il giorno compare SOLO sul suo giorno (chiave UTC)", () => {
    const allDay = event({ id: "e7", startsAt: "2026-09-12T00:00:00.000Z", allDay: true });
    expect(allDayEventsForDay([allDay], new Date(2026, 8, 12))).toHaveLength(1);
    expect(allDayEventsForDay([allDay], new Date(2026, 8, 11))).toHaveLength(0);
  });

  it("eventsForDay (vista mese) include sia gli eventi con orario sia quelli tutto il giorno dello stesso giorno", () => {
    const timed = event({ id: "e8", startsAt: "2026-09-12T14:00:00.000Z" });
    const allDay = event({ id: "e9", startsAt: "2026-09-12T00:00:00.000Z", allDay: true });
    const other = event({ id: "e10", startsAt: "2026-09-20T14:00:00.000Z" });
    const result = eventsForDay([timed, allDay, other], new Date(2026, 8, 12));
    expect(result.map((e) => e.id).sort()).toEqual(["e8", "e9"]);
  });
});

describe("addDays", () => {
  it("non muta la data passata (ritorna una nuova istanza)", () => {
    const original = new Date(2026, 8, 10);
    const copy = original.getTime();
    addDays(original, 5);
    expect(original.getTime()).toBe(copy);
  });
});
