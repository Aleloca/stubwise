import { createHash, randomBytes } from "node:crypto";
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
const key = randomBytes(32);

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
    const codes = await regenerateBackupCodes(db, key, userId);
    expect(codes).toHaveLength(BACKUP_CODE_COUNT);
    expect(new Set(codes).size).toBe(BACKUP_CODE_COUNT);
    for (const c of codes) expect(c).toMatch(/^[a-z2-9]{5}-[a-z2-9]{5}$/);
    expect(await remainingBackupCodes(db, userId)).toBe(10);
    for (const [i, c] of codes.entries()) {
      expect(await consumeBackupCode(db, key, userId, c)).toBe(true);
      expect(await consumeBackupCode(db, key, userId, c)).toBe(false);
      expect(await remainingBackupCodes(db, userId)).toBe(10 - i - 1);
    }
  });

  it("rigenerare invalida i vecchi", async () => {
    const userId = await newUserId();
    const old = await regenerateBackupCodes(db, key, userId);
    const fresh = await regenerateBackupCodes(db, key, userId);
    expect(await consumeBackupCode(db, key, userId, old[0]!)).toBe(false);
    expect(await consumeBackupCode(db, key, userId, fresh[0]!)).toBe(true);
    expect(await remainingBackupCodes(db, userId)).toBe(9);
  });

  it("maiuscole e trattino non contano: XXXXX-xxxxx e xxxxxxxxxx sono lo stesso codice", async () => {
    const userId = await newUserId();
    const [a, b] = await regenerateBackupCodes(db, key, userId);
    expect(await consumeBackupCode(db, key, userId, a!.toUpperCase())).toBe(true);
    expect(await consumeBackupCode(db, key, userId, a!)).toBe(false);
    expect(await consumeBackupCode(db, key, userId, b!.replace("-", ""))).toBe(true);
  });

  it("un codice di un altro utente o inventato non passa", async () => {
    const u1 = await newUserId();
    const u2 = await newUserId();
    const [c] = await regenerateBackupCodes(db, key, u1);
    expect(await consumeBackupCode(db, key, u2, c!)).toBe(false);
    expect(await consumeBackupCode(db, key, u1, "aaaaa-aaaaa")).toBe(false);
  });

  it("il DB non contiene i codici in chiaro", async () => {
    const userId = await newUserId();
    const codes = await regenerateBackupCodes(db, key, userId);
    const rows = await db.select().from(userBackupCodes).where(eq(userBackupCodes.userId, userId));
    expect(rows).toHaveLength(10);
    const plain = new Set(codes.flatMap((c) => [c, c.replace("-", "")]));
    for (const r of rows) expect(plain.has(r.codeHash)).toBe(false);
  });

  it("l'hash è legato alla chiave dell'istanza: non lo sha256 del codice, e con un'altra chiave non vale", async () => {
    const userId = await newUserId();
    const codes = await regenerateBackupCodes(db, key, userId);
    const rows = await db.select().from(userBackupCodes).where(eq(userBackupCodes.userId, userId));
    // Un dump del DB senza la chiave non basta a provare i codici offline.
    const sha = new Set(
      codes.flatMap((c) =>
        [c, c.replace("-", "")].map((v) => createHash("sha256").update(v).digest("hex")),
      ),
    );
    for (const r of rows) expect(sha.has(r.codeHash)).toBe(false);
    expect(await consumeBackupCode(db, randomBytes(32), userId, codes[0]!)).toBe(false);
    expect(await remainingBackupCodes(db, userId)).toBe(10);
    expect(await consumeBackupCode(db, key, userId, codes[0]!)).toBe(true);
  });
});
