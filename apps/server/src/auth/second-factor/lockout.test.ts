import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { users, type Db } from "@stubwise/db";
import { startTestDb, type TestDb } from "@stubwise/db/testing";
import {
  lockedUntil,
  recordFailure,
  recordSuccess,
  SECOND_FACTOR_LOCK_MS,
  SECOND_FACTOR_MAX_FAILURES,
} from "./lockout.js";

let testDb: TestDb;
let db: Db;

async function newUserId(): Promise<string> {
  const [row] = await db
    .insert(users)
    .values({ email: `l-${randomBytes(4).toString("hex")}@example.com`, passwordHash: "x", role: "member" })
    .returning({ id: users.id });
  return row!.id;
}

async function failures(userId: string): Promise<number> {
  const [r] = await db.select({ n: users.secondFactorFailures }).from(users).where(eq(users.id, userId));
  return r!.n;
}

beforeAll(async () => {
  testDb = await startTestDb();
  db = testDb.db;
}, 120_000);

afterAll(async () => {
  await testDb.stop();
});

describe("tetto per account", () => {
  it("5 fallimenti: blocco a ≈ now+15′ e contatore a 0", async () => {
    const userId = await newUserId();
    for (let i = 1; i < SECOND_FACTOR_MAX_FAILURES; i++) {
      expect(await recordFailure(db, userId)).toEqual({ locked: false });
      expect(await lockedUntil(db, userId)).toBeNull();
    }
    const before = Date.now();
    expect(await recordFailure(db, userId)).toEqual({ locked: true });
    const until = await lockedUntil(db, userId);
    expect(until).not.toBeNull();
    expect(Math.abs(until!.getTime() - (before + SECOND_FACTOR_LOCK_MS))).toBeLessThan(10_000);
    expect(await failures(userId)).toBe(0);
  });

  it("un successo azzera il contatore", async () => {
    const userId = await newUserId();
    await recordFailure(db, userId);
    await recordFailure(db, userId);
    expect(await failures(userId)).toBe(2);
    await recordSuccess(db, userId);
    expect(await failures(userId)).toBe(0);
    // Servono di nuovo 5 fallimenti per bloccare.
    for (let i = 0; i < 4; i++) await recordFailure(db, userId);
    expect(await lockedUntil(db, userId)).toBeNull();
  });

  it("un blocco scaduto non è più un blocco", async () => {
    const userId = await newUserId();
    await db
      .update(users)
      .set({ secondFactorLockedUntil: new Date(Date.now() - 1000) })
      .where(eq(users.id, userId));
    expect(await lockedUntil(db, userId)).toBeNull();
  });

  it("i fallimenti in corsa non sorpassano il tetto", async () => {
    const userId = await newUserId();
    const results = await Promise.all(
      Array.from({ length: SECOND_FACTOR_MAX_FAILURES }, () => recordFailure(db, userId)),
    );
    expect(results.filter((r) => r.locked)).toHaveLength(1);
    expect(await lockedUntil(db, userId)).not.toBeNull();
  });
});
