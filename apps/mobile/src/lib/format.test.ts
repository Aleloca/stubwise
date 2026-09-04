import { elapsedMinutes, relativeTimeCompact } from "./format";

const NOW = new Date("2026-09-02T10:00:00.000Z").getTime();

test("meno di un minuto: 'now'", () => {
  const iso = new Date("2026-09-02T09:59:45.000Z").toISOString();
  expect(relativeTimeCompact(iso, NOW)).toEqual({ kind: "now" });
});

test("12 minuti: 'minutes' con count=12", () => {
  const iso = new Date("2026-09-02T09:48:00.000Z").toISOString();
  expect(relativeTimeCompact(iso, NOW)).toEqual({ kind: "minutes", count: 12 });
});

test("1 ora e mezza: 'hours' con count=1 (troncato, non arrotondato)", () => {
  const iso = new Date("2026-09-02T08:29:00.000Z").toISOString();
  expect(relativeTimeCompact(iso, NOW)).toEqual({ kind: "hours", count: 1 });
});

test("25 ore: 'days' con count=1", () => {
  const iso = new Date("2026-09-01T09:00:00.000Z").toISOString();
  expect(relativeTimeCompact(iso, NOW)).toEqual({ kind: "days", count: 1 });
});

// Mutazione da rompere apposta: se il calcolo usasse i millisecondi grezzi
// invece di dividerli per 60_000, "12 minuti" diventerebbe un numero enorme.
test("il conteggio è in minuti, non in millisecondi grezzi", () => {
  const iso = new Date("2026-09-02T09:58:00.000Z").toISOString();
  const result = relativeTimeCompact(iso, NOW);
  expect(result).toEqual({ kind: "minutes", count: 2 });
});

test("un timestamp futuro (clock skew) non va mai sotto zero", () => {
  const iso = new Date("2026-09-02T10:05:00.000Z").toISOString();
  expect(relativeTimeCompact(iso, NOW)).toEqual({ kind: "now" });
});

describe("elapsedMinutes", () => {
  test("18 minuti: conteggio continuo, non bucket", () => {
    const iso = new Date("2026-09-02T09:42:00.000Z").toISOString();
    expect(elapsedMinutes(iso, NOW)).toBe(18);
  });

  test("oltre un'ora (78 min): NON collassa a 'ore', a differenza di relativeTimeCompact", () => {
    const iso = new Date("2026-09-02T08:42:00.000Z").toISOString();
    expect(elapsedMinutes(iso, NOW)).toBe(78);
  });

  test("un timestamp futuro (clock skew) non va mai sotto zero", () => {
    const iso = new Date("2026-09-02T10:05:00.000Z").toISOString();
    expect(elapsedMinutes(iso, NOW)).toBe(0);
  });
});
