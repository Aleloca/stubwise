import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agentSessionEvents, agentSessions } from "./schema.js";
import { startTestDb, type TestDb } from "./testing.js";

/** Migrazione 0199 (20 nov 2026, area 10, F3): l'evento `aside`. */
let t: TestDb;
beforeAll(async () => {
  t = await startTestDb();
}, 120_000);
afterAll(async () => {
  await t?.stop();
});

describe("migrazione 0199", () => {
  it("l'evento `aside` si scrive, `question` resta, un tipo inventato no", async () => {
    const [s] = await t.db.insert(agentSessions).values({ ownerKey: `free:${randomUUID()}`, kind: "free", title: "t" }).returning();
    await t.db.insert(agentSessionEvents).values({ sessionId: s!.id, segmentId: "s", type: "aside", data: { rows: [] } });
    await t.db.insert(agentSessionEvents).values({ sessionId: s!.id, segmentId: "s", type: "question", data: { questionId: randomUUID() } });
    await expect(t.db.insert(agentSessionEvents).values({ sessionId: s!.id, segmentId: "s", type: "inventato" as never, data: {} })).rejects.toThrow();
  });

  it("il journal: 0198 e 0199 in fila, `when` crescente", () => {
    const journal = JSON.parse(readFileSync(new URL("../drizzle/meta/_journal.json", import.meta.url), "utf8")) as { entries: { tag: string; when: number }[] };
    const tags = journal.entries.map((e) => e.tag);
    const i = tags.indexOf("0198_area10_questions");
    expect(tags.slice(i, i + 2)).toEqual(["0198_area10_questions", "0199_session_event_aside"]);
    const whens = journal.entries.map((e) => e.when);
    expect(whens.every((w, k) => k === 0 || w > whens[k - 1]!)).toBe(true);
  });
});
