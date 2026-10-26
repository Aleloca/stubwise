import { timedEventsForDay } from "@stubwise/shared";
import { describe, expect, it } from "vitest";
import { MAX_LANES, layoutLanes, mailboxMarks } from "./gridLayout";

// Le corsie della griglia oraria (shape calendar.md §5, [A 2]): al massimo 3
// in Week e 5 in Day; oltre, l'ultima diventa «+N more» con l'elenco della
// fascia. Review Focus 5: 12 eventi sovrapposti restano leggibili.

const DAY = new Date(2026, 9, 28);
const at = (h: number, m: number) => new Date(2026, 9, 28, h, m).toISOString();

/** Come il seme: 12 eventi da un'ora, ogni 10 minuti dalle 10. */
const TWELVE = Array.from({ length: 12 }, (_, i) => ({
  id: `ev-${i + 1}`,
  startsAt: at(10, i * 10),
  endsAt: at(11, i * 10),
  allDay: false,
}));

describe("corsie della griglia oraria", () => {
  it("eventi che non si toccano stanno su una corsia sola, a tutta larghezza", () => {
    const placed = layoutLanes(
      timedEventsForDay(
        [
          { id: "a", startsAt: at(9, 0), endsAt: at(10, 0), allDay: false },
          { id: "b", startsAt: at(10, 0), endsAt: at(11, 0), allDay: false },
        ],
        DAY,
      ),
      MAX_LANES.week,
    );
    expect(placed.map((p) => [p.kind, p.lane, p.lanes])).toEqual([
      ["event", 0, 1],
      ["event", 0, 1],
    ]);
  });

  it("12 sovrapposti in Week: 2 corsie di eventi più «+N more», nessun blocco più stretto di un terzo", () => {
    const placed = layoutLanes(timedEventsForDay(TWELVE, DAY), MAX_LANES.week);
    const events = placed.filter((p) => p.kind === "event");
    const more = placed.filter((p) => p.kind === "more");
    expect(Math.max(...placed.map((p) => p.lane))).toBe(2);
    for (const p of placed) expect(p.lanes).toBe(3);
    expect(more).toHaveLength(1);
    const m = more[0]!;
    if (m.kind !== "more") throw new Error();
    // Ogni evento è o visibile o contato nel «+N more»; la fascia li elenca tutti.
    expect(events.length + m.hidden.length).toBe(12);
    expect(m.band.map((e) => e.id)).toEqual(TWELVE.map((e) => e.id));
    expect(m.lane).toBe(2);
    // L'ultima corsia è solo del «+N more»: nessun blocco ci finisce sotto.
    for (const e of events) expect(e.lane).toBeLessThan(2);
  });

  it("in Day le corsie arrivano a 5", () => {
    const placed = layoutLanes(timedEventsForDay(TWELVE, DAY), MAX_LANES.day);
    expect(Math.max(...placed.map((p) => p.lanes))).toBe(5);
    const more = placed.find((p) => p.kind === "more");
    expect(more?.lane).toBe(4);
  });
});

describe("segno per casella [A 1]", () => {
  it("con una sola casella nessun segno; con due o più, uno fisso per casella nell'ordine", () => {
    expect(mailboxMarks(["giulia@example.com"])).toBeNull();
    const marks = mailboxMarks(["a@example.com", "b@example.com"])!;
    expect(marks.get("a@example.com")).not.toBe(marks.get("b@example.com"));
    expect(marks.size).toBe(2);
  });
});
