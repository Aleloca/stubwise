import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agentSessions, claudeConversations, users } from "./schema.js";
import { startTestDb, type TestDb } from "./testing.js";

/**
 * Migrazione 0197 (19 nov 2026, area 10, F1, review I2): il segno del contenuto
 * PERSONALE letto da una conversazione con Claude (`private_read_at`).
 */
let t: TestDb;
beforeAll(async () => {
  t = await startTestDb();
}, 120_000);
afterAll(async () => {
  await t?.stop();
});

describe("migrazione 0197", () => {
  it("una conversazione nasce senza segno; il segno resta col primo istante", async () => {
    const [u] = await t.db.insert(users).values({ email: `p-${randomUUID().slice(0, 6)}@x.test`, passwordHash: "x", role: "member" }).returning();
    const [s] = await t.db.insert(agentSessions).values({ ownerKey: `free:${randomUUID()}`, kind: "free", title: "t" }).returning();
    await t.db.insert(claudeConversations).values({ sessionId: s!.id, ownerId: u!.id, title: "t" });
    const at = async () => (await t.db.select({ at: claudeConversations.privateReadAt }).from(claudeConversations).where(eq(claudeConversations.sessionId, s!.id)))[0]!.at;
    expect(await at()).toBeNull();
    const mark = () => t.db.update(claudeConversations).set({ privateReadAt: sql`coalesce(${claudeConversations.privateReadAt}, now())` }).where(eq(claudeConversations.sessionId, s!.id));
    await mark();
    const first = await at();
    expect(first).not.toBeNull();
    await mark();
    expect(await at()).toEqual(first);
  });

  it("il journal: 0196 e 0197 in fila, `when` crescente", () => {
    const journal = JSON.parse(readFileSync(new URL("../drizzle/meta/_journal.json", import.meta.url), "utf8")) as { entries: { tag: string; when: number }[] };
    const tags = journal.entries.map((e) => e.tag);
    const i = tags.indexOf("0196_department_project_permissions");
    expect(tags.slice(i, i + 2)).toEqual(["0196_department_project_permissions", "0197_claude_private_reads"]);
    const whens = journal.entries.map((e) => e.when);
    expect(whens.every((w, k) => k === 0 || w > whens[k - 1]!)).toBe(true);
  });
});
