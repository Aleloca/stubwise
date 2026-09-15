import { describe, expect, it } from "vitest";
import { formatRecurrence, parseRecurrence, type RecurrenceRule } from "./calendar-recurrence.js";

/**
 * La ricorrenza a parole (15 set 2026, §2, Task 7).
 *
 * Il caso che questo file presidia più degli altri non è una regola letta
 * bene: è una regola letta MALE che non deve produrre una frase. Una frase
 * sbagliata su quando si ripete un appuntamento è peggio di nessuna frase —
 * chi la legge non ha modo di accorgersene.
 */

describe("parseRecurrence — quello che sappiamo leggere", () => {
  it("la settimanale semplice", () => {
    expect(parseRecurrence(["RRULE:FREQ=WEEKLY"])).toEqual({
      freq: "weekly",
      interval: 1,
      byWeekday: [],
      count: null,
      until: null,
    });
  });

  it("intervallo, giorni, e i giorni riordinati da lunedì a domenica", () => {
    // Google li manda nell'ordine in cui sono stati scelti: qui escono
    // sempre nell'ordine in cui si leggono.
    expect(parseRecurrence(["RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=FR,MO,WE"])).toMatchObject({
      freq: "weekly",
      interval: 2,
      byWeekday: ["mon", "wed", "fri"],
    });
  });

  it("UNTIL, nelle due forme che Google usa", () => {
    expect(parseRecurrence(["RRULE:FREQ=DAILY;UNTIL=20261231"])?.until).toBe("2026-12-31");
    expect(parseRecurrence(["RRULE:FREQ=DAILY;UNTIL=20261231T235959Z"])?.until).toBe("2026-12-31");
  });

  it("COUNT", () => {
    expect(parseRecurrence(["RRULE:FREQ=MONTHLY;COUNT=12"])?.count).toBe(12);
  });

  it("ignora le righe che non sono RRULE, e trova la RRULE dovunque sia", () => {
    const lines = ["EXDATE;TZID=Europe/Rome:20261012T090000", "RRULE:FREQ=YEARLY"];
    expect(parseRecurrence(lines)?.freq).toBe("yearly");
  });

  it("tollera minuscole e spazi", () => {
    expect(parseRecurrence([" rrule:freq=weekly;interval=3 "])).toMatchObject({
      freq: "weekly",
      interval: 3,
    });
  });
});

describe("parseRecurrence — quando NON sappiamo, tace", () => {
  it("nessuna RRULE: null", () => {
    expect(parseRecurrence([])).toBeNull();
    expect(parseRecurrence(null)).toBeNull();
    expect(parseRecurrence(undefined)).toBeNull();
    expect(parseRecurrence(["EXDATE;TZID=Europe/Rome:20261012T090000"])).toBeNull();
  });

  it("una frequenza che non sappiamo dire a parole: null, mai un ripiego", () => {
    for (const freq of ["HOURLY", "MINUTELY", "SECONDLY", "FORTNIGHTLY"]) {
      expect(parseRecurrence([`RRULE:FREQ=${freq}`])).toBeNull();
    }
    expect(parseRecurrence(["RRULE:INTERVAL=2"])).toBeNull();
  });

  it("un INTERVAL malformato: null, non 1", () => {
    // Interpretare «INTERVAL=abc» come «ogni settimana» sarebbe inventare.
    expect(parseRecurrence(["RRULE:FREQ=WEEKLY;INTERVAL=abc"])).toBeNull();
    expect(parseRecurrence(["RRULE:FREQ=WEEKLY;INTERVAL=0"])).toBeNull();
    expect(parseRecurrence(["RRULE:FREQ=WEEKLY;INTERVAL=-2"])).toBeNull();
  });

  it("⚠️ «il secondo lunedì» NON diventa «ogni lunedì»", () => {
    // Il caso che costerebbe caro: `2MO` è un BYDAY con prefisso numerico.
    // Tradurlo come `MO` direbbe una cosa falsa sotto una riunione mensile.
    // Restano frequenza e intervallo, che sono veri comunque.
    const rule = parseRecurrence(["RRULE:FREQ=MONTHLY;BYDAY=2MO"]);
    expect(rule).toMatchObject({ freq: "monthly", interval: 1 });
    expect(rule?.byWeekday).toEqual([]);
  });

  it("un UNTIL malformato non diventa una data inventata", () => {
    expect(parseRecurrence(["RRULE:FREQ=DAILY;UNTIL=domani"])?.until).toBeNull();
    expect(parseRecurrence(["RRULE:FREQ=DAILY;UNTIL=20261340"])?.until).toBeNull();
  });

  it("un COUNT malformato non diventa un numero inventato", () => {
    expect(parseRecurrence(["RRULE:FREQ=DAILY;COUNT=molte"])?.count).toBeNull();
    expect(parseRecurrence(["RRULE:FREQ=DAILY;COUNT=0"])?.count).toBeNull();
  });
});

describe("formatRecurrence — la composizione, non le parole", () => {
  /** Un dizionario finto: quello che conta qui è l'ORDINE dei pezzi. */
  const t = (key: string, params?: Record<string, unknown>): string => {
    if (key.startsWith("weekday.")) return key.slice("weekday.".length).toUpperCase();
    if (key.startsWith("freq.")) return `[${key.slice("freq.".length)} x${String(params?.count)}]`;
    if (key === "withDays") return `${String(params?.frequency)} il ${String(params?.days)}`;
    if (key === "withUntil") return `${String(params?.recurrence)} fino al ${String(params?.date)}`;
    if (key === "withCount") return `${String(params?.recurrence)} per ${String(params?.count)} volte`;
    return key;
  };

  const base: RecurrenceRule = { freq: "weekly", interval: 1, byWeekday: [], count: null, until: null };

  it("solo la frequenza quando non c'è altro", () => {
    expect(formatRecurrence(base, t)).toBe("[weekly x1]");
  });

  it("i giorni si attaccano alla frequenza, nell'ordine in cui si leggono", () => {
    expect(formatRecurrence({ ...base, byWeekday: ["mon", "wed"] }, t)).toBe("[weekly x1] il MON, WED");
  });

  it("UNTIL vince su COUNT — una data è più utile di un conteggio", () => {
    const both = { ...base, until: "2026-12-31", count: 5 };
    expect(formatRecurrence(both, t)).toBe("[weekly x1] fino al 2026-12-31");
  });

  it("COUNT da solo", () => {
    expect(formatRecurrence({ ...base, count: 5 }, t)).toBe("[weekly x1] per 5 volte");
  });

  it("l'intervallo arriva alla traduzione come `count`, per il plurale", () => {
    expect(formatRecurrence({ ...base, interval: 3 }, t)).toBe("[weekly x3]");
  });
});
