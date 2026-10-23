import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { users, type Db } from "@stubwise/db";
import { startTestDb, type TestDb } from "@stubwise/db/testing";
import {
  lockedUntil,
  recordFailure,
  recordSuccess,
  RESERVATION_STALE_MS,
  reserveAttempt,
  settleFailure,
  settleSuccess,
  SECOND_FACTOR_LOCK_MS,
  SECOND_FACTOR_MAX_FAILURES,
} from "./lockout.js";

let testDb: TestDb;
let db: Db;

async function newUserId(): Promise<string> {
  const [row] = await db
    .insert(users)
    .values({
      email: `l-${randomBytes(4).toString("hex")}@example.com`,
      passwordHash: "x",
      role: "member",
    })
    .returning({ id: users.id });
  return row!.id;
}

async function failures(userId: string): Promise<number> {
  const [r] = await db
    .select({ n: users.secondFactorFailures })
    .from(users)
    .where(eq(users.id, userId));
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

describe("prenotazione dei tentativi (richieste in parallelo)", () => {
  it("10 prenotazioni in parallelo: ne passano esattamente 5", async () => {
    const userId = await newUserId();
    const reserved = await Promise.all(
      Array.from({ length: 10 }, () => reserveAttempt(db, userId)),
    );
    expect(reserved.filter(Boolean)).toHaveLength(SECOND_FACTOR_MAX_FAILURES);
    expect(await failures(userId)).toBe(SECOND_FACTOR_MAX_FAILURES);
  });

  it("5 fallimenti chiusi in parallelo: il blocco scatta per UNO solo", async () => {
    const userId = await newUserId();
    for (let i = 0; i < SECOND_FACTOR_MAX_FAILURES; i++)
      expect(await reserveAttempt(db, userId)).toBe(true);
    const settled = await Promise.all(
      Array.from({ length: SECOND_FACTOR_MAX_FAILURES }, () => settleFailure(db, userId)),
    );
    expect(settled.filter((s) => s.locked)).toHaveLength(1);
    expect(await lockedUntil(db, userId)).not.toBeNull();
    expect(await failures(userId)).toBe(0);
    // Bloccato: niente prenotazioni, e un codice giusto non chiude in successo.
    expect(await reserveAttempt(db, userId)).toBe(false);
    expect(await settleSuccess(db, userId)).toBe(false);
  });

  it("un successo prenotato azzera il contatore e libera i posti", async () => {
    const userId = await newUserId();
    await reserveAttempt(db, userId);
    await settleFailure(db, userId);
    await reserveAttempt(db, userId);
    expect(await settleSuccess(db, userId)).toBe(true);
    expect(await failures(userId)).toBe(0);
  });
});

describe("prenotazione persa (chiusura mai arrivata)", () => {
  async function leaveFullCounter(userId: string, reservedAt: Date | null) {
    await db
      .update(users)
      .set({ secondFactorFailures: SECOND_FACTOR_MAX_FAILURES, secondFactorReservedAt: reservedAt })
      .where(eq(users.id, userId));
  }

  it("contatore pieno, nessun blocco, prenotazione vecchia: il contatore riparte da questa prenotazione", async () => {
    const userId = await newUserId();
    await leaveFullCounter(userId, new Date(Date.now() - RESERVATION_STALE_MS - 5_000));
    expect(await reserveAttempt(db, userId)).toBe(true);
    expect(await failures(userId)).toBe(1);
    expect(await lockedUntil(db, userId)).toBeNull();
  });

  it("contatore pieno senza data di prenotazione: trattato come vecchio", async () => {
    const userId = await newUserId();
    await leaveFullCounter(userId, null);
    expect(await reserveAttempt(db, userId)).toBe(true);
    expect(await failures(userId)).toBe(1);
  });

  it("contatore pieno con prenotazione recente: ancora occupato", async () => {
    const userId = await newUserId();
    await leaveFullCounter(userId, new Date());
    expect(await reserveAttempt(db, userId)).toBe(false);
    expect(await failures(userId)).toBe(SECOND_FACTOR_MAX_FAILURES);
  });

  it("bloccato: nemmeno una prenotazione vecchia riapre il passo", async () => {
    const userId = await newUserId();
    await leaveFullCounter(userId, new Date(Date.now() - RESERVATION_STALE_MS - 5_000));
    await db
      .update(users)
      .set({ secondFactorLockedUntil: new Date(Date.now() + 60_000) })
      .where(eq(users.id, userId));
    expect(await reserveAttempt(db, userId)).toBe(false);
  });
});
