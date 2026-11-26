import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { alertSubscriptions, notificationKind, users } from "./schema.js";
import { expectSqlState, seedRepository, startTestDb, type TestDb } from "./testing.js";

/**
 * Migrazione 0177 (14 nov 2026, area 8, fetta 2): le iscrizioni agli avvisi
 * (lo stato di adesso, una riga per persona, progetto e tipo) e i
 * `notification_kind` del catalogo.
 */

let t: TestDb;
beforeAll(async () => {
  t = await startTestDb();
}, 120_000);
afterAll(async () => {
  await t?.stop();
});

async function person(): Promise<string> {
  const [u] = await t.db.insert(users).values({ email: `a-${randomUUID()}@x.it`, passwordHash: "x", role: "member" }).returning();
  return u!.id;
}

describe("migrazione 0177", () => {
  it("i kind del catalogo esistono nell'enum del DB, e l'enum di drizzle li dichiara", async () => {
    const rows = await t.db.execute<{ v: string }>(sql`select unnest(enum_range(null::notification_kind))::text as v`);
    const values = rows.map((r) => r.v);
    for (const k of ["release.merged", "release.succeeded", "pr.opened", "pr.analysis_issues", "pr.corrected", "docs.release_note"]) {
      expect(values).toContain(k);
      expect(notificationKind.enumValues).toContain(k);
    }
  });

  it("una riga per persona, progetto e tipo: il secondo insert viola la chiave, l'upsert aggiorna", async () => {
    const { projectId } = await seedRepository(t.db);
    const userId = await person();
    await t.db.insert(alertSubscriptions).values({ userId, projectId, alertType: "release.failed", app: true, phone: false });
    await expectSqlState(t.db.insert(alertSubscriptions).values({ userId, projectId, alertType: "release.failed", app: false, phone: false }), "23505");
    await t.db
      .insert(alertSubscriptions)
      .values({ userId, projectId, alertType: "release.failed", app: false, phone: true })
      .onConflictDoUpdate({ target: [alertSubscriptions.userId, alertSubscriptions.projectId, alertSubscriptions.alertType], set: { app: false, phone: true } });
    const [row] = await t.db.select().from(alertSubscriptions).where(sql`${alertSubscriptions.userId} = ${userId}`);
    expect(row).toMatchObject({ app: false, phone: true });
  });

  it("il tipo ha la forma di un kind (`famiglia.nome`): un testo libero no", async () => {
    const { projectId } = await seedRepository(t.db);
    const userId = await person();
    await expectSqlState(t.db.insert(alertSubscriptions).values({ userId, projectId, alertType: "Release Failed", app: true, phone: true }), "23514");
    await t.db.insert(alertSubscriptions).values({ userId, projectId, alertType: "pr.analysis_issues", app: true, phone: true });
  });
});
