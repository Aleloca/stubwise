import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { securityEvents, users, type Db } from "@stubwise/db";
import { startTestDb, type TestDb } from "@stubwise/db/testing";
import { listSecurityEvents, recordSecurityEvent } from "./security-events.js";

let testDb: TestDb;
let db: Db;

async function newUser(): Promise<{ id: string; email: string }> {
  const email = `s-${randomBytes(4).toString("hex")}@example.com`;
  const [row] = await db
    .insert(users)
    .values({ email, passwordHash: "x", role: "member" })
    .returning({ id: users.id });
  return { id: row!.id, email };
}

beforeAll(async () => {
  testDb = await startTestDb();
  db = testDb.db;
}, 120_000);

afterAll(async () => {
  await testDb.stop();
});

describe("registro di sicurezza", () => {
  it("scrive chi subisce e chi agisce, e lo elenca dal più recente", async () => {
    const user = await newUser();
    const actor = await newUser();
    await recordSecurityEvent(db, { kind: "login", user });
    await recordSecurityEvent(db, { kind: "second_factor_reset", user, actor });
    const events = await listSecurityEvents(db, user.id);
    expect(events.map((e) => e.kind)).toEqual(["second_factor_reset", "login"]);
    expect(events[0]).toMatchObject({ actorUserId: actor.id, actorEmail: actor.email, userEmail: user.email });
    expect(events[1]!.actorEmail).toBeNull();
  });

  it("un evento resta leggibile dopo l'eliminazione dell'utente (email in testo)", async () => {
    const user = await newUser();
    const actor = await newUser();
    await recordSecurityEvent(db, { kind: "second_factor_reset", user, actor });
    await db.delete(users).where(eq(users.id, user.id));
    await db.delete(users).where(eq(users.id, actor.id));
    const rows = await db
      .select()
      .from(securityEvents)
      .where(eq(securityEvents.userEmail, user.email));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      userId: null,
      actorUserId: null,
      userEmail: user.email,
      actorEmail: actor.email,
    });
  });

  it("le righe più vecchie di un anno spariscono alla scrittura successiva", async () => {
    const user = await newUser();
    const old = new Date(Date.now() - 366 * 24 * 60 * 60 * 1000);
    const recent = new Date(Date.now() - 364 * 24 * 60 * 60 * 1000);
    await db.insert(securityEvents).values([
      { userId: user.id, userEmail: user.email, kind: "login", createdAt: old },
      { userId: user.id, userEmail: user.email, kind: "enrolled", createdAt: recent },
    ]);
    expect(await listSecurityEvents(db, user.id)).toHaveLength(2);
    await recordSecurityEvent(db, { kind: "login", user });
    const kinds = (await listSecurityEvents(db, user.id)).map((e) => e.kind).sort();
    expect(kinds).toEqual(["enrolled", "login"]);
  });
});
