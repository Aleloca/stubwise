import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { notifications, users } from "./schema.js";
import { startTestDb, type TestDb } from "./testing.js";

/** Migrazione 0200 (20 nov 2026, area 10, F5): il kind `member.added`. */
let t: TestDb;
beforeAll(async () => {
  t = await startTestDb();
}, 120_000);
afterAll(async () => {
  await t?.stop();
});

describe("migrazione 0200", () => {
  it("una notifica `member.added` si scrive", async () => {
    const [u] = await t.db.insert(users).values({ email: `m-${randomUUID().slice(0, 6)}@x.test`, passwordHash: "x", role: "member" }).returning();
    const [n] = await t.db.insert(notifications).values({ userId: u!.id, kind: "member.added", event: { kind: "member.added" }, status: "open" }).returning();
    expect(n!.kind).toBe("member.added");
  });

  it("il journal: 0199 e 0200 in fila, `when` crescente; la 0200 è il solo ADD VALUE", () => {
    const journal = JSON.parse(readFileSync(new URL("../drizzle/meta/_journal.json", import.meta.url), "utf8")) as { entries: { tag: string; when: number }[] };
    const tags = journal.entries.map((e) => e.tag);
    const i = tags.indexOf("0199_session_event_aside");
    expect(tags.slice(i, i + 2)).toEqual(["0199_session_event_aside", "0200_member_added"]);
    const whens = journal.entries.map((e) => e.when);
    expect(whens.every((w, k) => k === 0 || w > whens[k - 1]!)).toBe(true);
    const sql = readFileSync(new URL("../drizzle/0200_member_added.sql", import.meta.url), "utf8").replace(/--.*$/gm, "").trim();
    expect(sql).toBe(`ALTER TYPE "notification_kind" ADD VALUE IF NOT EXISTS 'member.added';`);
  });
});
