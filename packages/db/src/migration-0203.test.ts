import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { notifications, users } from "./schema.js";
import { startTestDb, type TestDb } from "./testing.js";

/** Migrazione 0203 (20 nov 2026, area 11, F2): i tre kind della doc di prodotto. */
let t: TestDb;
beforeAll(async () => {
  t = await startTestDb();
}, 120_000);
afterAll(async () => {
  await t?.stop();
});

const KINDS = ["product_doc.mention", "product_doc.updated", "product_doc.question"] as const;

describe("migrazione 0203", () => {
  it("una notifica di ognuno dei tre kind si scrive", async () => {
    const [u] = await t.db.insert(users).values({ email: `p-${randomUUID().slice(0, 6)}@x.test`, passwordHash: "x", role: "member" }).returning();
    for (const kind of KINDS) {
      const [n] = await t.db.insert(notifications).values({ userId: u!.id, kind, event: { kind }, status: "open" }).returning();
      expect(n!.kind).toBe(kind);
    }
  });

  it("il journal: 0202 e 0203 in fila, `when` crescente; la 0203 è fatta dei soli tre ADD VALUE, uno per statement", () => {
    const journal = JSON.parse(readFileSync(new URL("../drizzle/meta/_journal.json", import.meta.url), "utf8")) as { entries: { tag: string; when: number }[] };
    const tags = journal.entries.map((e) => e.tag);
    const i = tags.indexOf("0202_product_docs");
    expect(tags.slice(i, i + 2)).toEqual(["0202_product_docs", "0203_product_doc_notifications"]);
    const whens = journal.entries.map((e) => e.when);
    expect(whens.every((w, k) => k === 0 || w > whens[k - 1]!)).toBe(true);
    const statements = readFileSync(new URL("../drizzle/0203_product_doc_notifications.sql", import.meta.url), "utf8")
      .replace(/^--(?!>).*$/gm, "")
      .split("--> statement-breakpoint")
      .map((s) => s.trim());
    expect(statements).toEqual(KINDS.map((k) => `ALTER TYPE "notification_kind" ADD VALUE IF NOT EXISTS '${k}';`));
  });
});
