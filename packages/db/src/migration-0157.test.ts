import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { calendarEvents, googleAccounts, googleWorkspaces, users } from "./schema.js";
import { startTestDb, type TestDb } from "./testing.js";

/**
 * Migrazione 0157 (12 nov 2026, area 6, F3b): il calendario con TUTTI gli
 * eventi. Evento visto ≠ candidato (`proposal_candidate`, default true: le
 * righe di prima erano tutte in perimetro), tipo e trasparenza, chi ha deciso
 * il progetto, e la linea di base per casella.
 */

let t: TestDb;
beforeAll(async () => {
  t = await startTestDb();
}, 120_000);
afterAll(async () => {
  await t?.stop();
});

describe("migrazione 0157", () => {
  it("le colonne nuove con i loro default; la linea di base nasce vuota", async () => {
    const [u] = await t.db.insert(users).values({ email: `u-${randomUUID()}@x.it`, passwordHash: "x", role: "member" }).returning();
    const [ws] = await t.db.insert(googleWorkspaces).values({ name: "A", domains: ["x.it"], clientId: "c", clientSecretEncrypted: "s" }).returning();
    const [box] = await t.db.insert(googleAccounts).values({ userId: u!.id, workspaceId: ws!.id, email: `b-${randomUUID()}@x.it`, googleSub: randomUUID(), refreshTokenEncrypted: "r" }).returning();
    expect(box!.calendarBaselineAt).toBeNull();
    const [row] = await t.db.insert(calendarEvents).values({ accountId: box!.id, googleEventId: "e1", startsAt: new Date(), fingerprint: "f" }).returning();
    expect(row).toMatchObject({ proposalCandidate: true, eventType: null, transparency: null, projectBy: null });
  });

  it("l'indice per casella e inizio (range e potatura) c'è", async () => {
    const rows = await t.db.execute<{ indexname: string }>(sql`select indexname from pg_indexes where tablename = 'calendar_events'`);
    expect(rows.map((r) => r.indexname)).toContain("calendar_events_account_starts_idx");
  });
});
