import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { userBackupCodes, users, type Db } from "@stubwise/db";
import { startTestDb, type TestDb } from "@stubwise/db/testing";
import {
  BACKUP_CODE_COUNT,
  consumeBackupCode,
  regenerateBackupCodes,
  remainingBackupCodes,
} from "./backup-codes.js";

let testDb: TestDb;
let db: Db;

async function newUserId(): Promise<string> {
  const [row] = await db
    .insert(users)
    .values({ email: `b-${randomBytes(4).toString("hex")}@example.com`, passwordHash: "x", role: "member" })
    .returning({ id: users.id });
  return row!.id;
}

beforeAll(async () => {
  testDb = await startTestDb();
  db = testDb.db;
}, 120_000);

afterAll(async () => {
  await testDb.stop();
});

describe("codici di riserva", () => {
  it("10 codici nel formato xxxxx-xxxxx, ognuno usabile una volta", async () => {
    const userId = await newUserId();
    const codes = await regenerateBackupCodes(db, userId);
    expect(codes).toHaveLength(BACKUP_CODE_COUNT);
    expect(new Set(codes).size).toBe(BACKUP_CODE_COUNT);
    for (const c of codes) expect(c).toMatch(/^[a-z2-9]{5}-[a-z2-9]{5}$/);
    expect(await remainingBackupCodes(db, userId)).toBe(10);
    for (const [i, c] of codes.entries()) {
      expect(await consumeBackupCode(db, userId, c)).toBe(true);
      expect(await consumeBackupCode(db, userId, c)).toBe(false);
      expect(await remainingBackupCodes(db, userId)).toBe(10 - i - 1);
    }
  });

  it("rigenerare invalida i vecchi", async () => {
    const userId = await newUserId();
    const old = await regenerateBackupCodes(db, userId);
    const fresh = await regenerateBackupCodes(db, userId);
    expect(await consumeBackupCode(db, userId, old[0]!)).toBe(false);
    expect(await consumeBackupCode(db, userId, fresh[0]!)).toBe(true);
    expect(await remainingBackupCodes(db, userId)).toBe(9);
  });

  it("maiuscole e trattino non contano: XXXXX-xxxxx e xxxxxxxxxx sono lo stesso codice", async () => {
    const userId = await newUserId();
    const [a, b] = await regenerateBackupCodes(db, userId);
    expect(await consumeBackupCode(db, userId, a!.toUpperCase())).toBe(true);
    expect(await consumeBackupCode(db, userId, a!)).toBe(false);
    expect(await consumeBackupCode(db, userId, b!.replace("-", ""))).toBe(true);
  });

  it("un codice di un altro utente o inventato non passa", async () => {
    const u1 = await newUserId();
    const u2 = await newUserId();
    const [c] = await regenerateBackupCodes(db, u1);
    expect(await consumeBackupCode(db, u2, c!)).toBe(false);
    expect(await consumeBackupCode(db, u1, "aaaaa-aaaaa")).toBe(false);
  });

  it("il DB non contiene i codici in chiaro", async () => {
    const userId = await newUserId();
    const codes = await regenerateBackupCodes(db, userId);
    const rows = await db.select().from(userBackupCodes).where(eq(userBackupCodes.userId, userId));
    expect(rows).toHaveLength(10);
    const plain = new Set(codes.flatMap((c) => [c, c.replace("-", "")]));
    for (const r of rows) expect(plain.has(r.codeHash)).toBe(false);
  });
});
