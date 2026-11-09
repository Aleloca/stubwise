import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import { taskDayArrangements, tickets } from "./schema.js";

/**
 * Fix della review della fetta 2 (drift Drizzle ↔ 0113/0120): ciò che le
 * migrazioni creano per la settimana pianificata è dichiarato anche in
 * `schema.ts`, così un `drizzle-kit generate` non propone di toglierlo.
 */
describe("schema: settimana pianificata e sistemazioni per giorno", () => {
  it("tickets dichiara i CHECK della 0113 e l'indice della 0120", () => {
    const cfg = getTableConfig(tickets);
    expect(cfg.checks.map((c) => c.name)).toEqual(
      expect.arrayContaining(["tickets_planned_week_monday_chk", "tickets_slip_count_chk"]),
    );
    const idx = cfg.indexes.find((i) => i.config.name === "tickets_assignee_planned_week_idx");
    expect(idx?.config.columns.map((c) => (c as { name: string }).name)).toEqual(["assignee_id", "planned_week"]);
  });

  it("task_day_arrangements: day smallint, i CHECK della 0113", () => {
    const cfg = getTableConfig(taskDayArrangements);
    expect(cfg.columns.find((c) => c.name === "day")?.getSQLType()).toBe("smallint");
    expect(cfg.checks.map((c) => c.name).sort()).toEqual([
      "task_day_arrangements_day_chk",
      "task_day_arrangements_week_monday_chk",
    ]);
  });
});
