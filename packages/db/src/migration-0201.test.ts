import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agentSessionEvents, agentSessions, claudeSuggestionDismissals, users } from "./schema.js";
import { startTestDb, type TestDb } from "./testing.js";

/** Migrazione 0201 (20 nov 2026, area 10, F7): l'evento `capabilities` e i «Not now». */
let t: TestDb;
beforeAll(async () => {
  t = await startTestDb();
}, 120_000);
afterAll(async () => {
  await t?.stop();
});

describe("migrazione 0201", () => {
  it("l'evento `capabilities` si scrive, `aside` resta, un tipo inventato no", async () => {
    const [s] = await t.db.insert(agentSessions).values({ ownerKey: `free:${randomUUID()}`, kind: "free", title: "t" }).returning();
    await t.db.insert(agentSessionEvents).values({ sessionId: s!.id, segmentId: "s", type: "capabilities", data: { items: ["stalled"] } });
    await t.db.insert(agentSessionEvents).values({ sessionId: s!.id, segmentId: "s", type: "aside", data: { rows: [] } });
    await expect(t.db.insert(agentSessionEvents).values({ sessionId: s!.id, segmentId: "s", type: "inventato" as never, data: {} })).rejects.toThrow();
  });

  it("un «Not now» per persona, tipo e oggetto (lo stesso due volte no); togliere la persona toglie le sue righe", async () => {
    const [u] = await t.db.insert(users).values({ email: `nn-${randomUUID()}@example.com`, passwordHash: "x", role: "member" }).returning({ id: users.id });
    await t.db.insert(claudeSuggestionDismissals).values({ userId: u!.id, kind: "whyStalled", objectId: "p1" });
    await t.db.insert(claudeSuggestionDismissals).values({ userId: u!.id, kind: "whyStalled", objectId: "p2" });
    await t.db.insert(claudeSuggestionDismissals).values({ userId: u!.id, kind: "monthSpend" });
    await expect(t.db.insert(claudeSuggestionDismissals).values({ userId: u!.id, kind: "whyStalled", objectId: "p1" })).rejects.toThrow();
    expect(await t.db.select().from(claudeSuggestionDismissals).where(eq(claudeSuggestionDismissals.userId, u!.id))).toHaveLength(3);
    await t.db.delete(users).where(eq(users.id, u!.id));
    expect(await t.db.select().from(claudeSuggestionDismissals).where(eq(claudeSuggestionDismissals.userId, u!.id))).toEqual([]);
  });

  it("il journal: 0200 e 0201 in fila, `when` crescente", () => {
    const journal = JSON.parse(readFileSync(new URL("../drizzle/meta/_journal.json", import.meta.url), "utf8")) as { entries: { tag: string; when: number }[] };
    const tags = journal.entries.map((e) => e.tag);
    const i = tags.indexOf("0200_member_added");
    expect(tags.slice(i, i + 2)).toEqual(["0200_member_added", "0201_claude_capabilities_suggestions"]);
    const whens = journal.entries.map((e) => e.when);
    expect(whens.every((w, k) => k === 0 || w > whens[k - 1]!)).toBe(true);
  });
});
