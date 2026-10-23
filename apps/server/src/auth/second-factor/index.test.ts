import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generateSync } from "otplib";
import { eq } from "drizzle-orm";
import { users, type Db } from "@stubwise/db";
import { startTestDb, type TestDb } from "@stubwise/db/testing";
import { regenerateBackupCodes } from "./backup-codes.js";
import { attemptSecondFactor, verifySecondFactorCode } from "./index.js";
import { listSecurityEvents } from "./security-events.js";
import { confirmTotp, startTotpEnrollment } from "./totp.js";

let testDb: TestDb;
let db: Db;
const key = randomBytes(32);

beforeAll(async () => {
  testDb = await startTestDb();
  db = testDb.db;
}, 120_000);

afterAll(async () => {
  await testDb.stop();
});

describe("verifySecondFactorCode", () => {
  it("6 cifre = TOTP; altro = codice di riserva, che lascia traccia", async () => {
    const email = `v-${randomBytes(4).toString("hex")}@example.com`;
    const [row] = await db
      .insert(users)
      .values({ email, passwordHash: "x", role: "member" })
      .returning({ id: users.id });
    const user = { id: row!.id, email };
    const { secret } = await startTotpEnrollment(db, key, user);
    // Conferma nel passato: il passo corrente resta libero per il login.
    const past = Date.now() - 5 * 60_000;
    expect(
      await confirmTotp(
        db,
        key,
        user.id,
        generateSync({ secret, epoch: Math.floor(past / 1000) }),
        past,
      ),
    ).toBe(true);
    const [backup] = await regenerateBackupCodes(db, key, user.id);

    expect(await verifySecondFactorCode(db, key, user.id, generateSync({ secret }))).toBe("totp");
    expect(await verifySecondFactorCode(db, key, user.id, "000000")).toBeNull();
    expect(await verifySecondFactorCode(db, key, user.id, backup!)).toBe("backup");
    expect(await verifySecondFactorCode(db, key, user.id, backup!)).toBeNull();
    expect((await listSecurityEvents(db, user.id)).map((e) => e.kind)).toEqual([
      "backup_code_used",
    ]);
  });

  it.each([
    ["spazio", (c: string) => ` ${c.slice(0, 3)} ${c.slice(3)} `],
    ["trattino", (c: string) => `${c.slice(0, 3)}-${c.slice(3)}`],
  ])("un TOTP incollato con %s resta un TOTP", async (_label, paste) => {
    const email = `p-${randomBytes(4).toString("hex")}@example.com`;
    const [row] = await db
      .insert(users)
      .values({ email, passwordHash: "x", role: "member" })
      .returning({ id: users.id });
    const user = { id: row!.id, email };
    const { secret } = await startTotpEnrollment(db, key, user);
    const past = Date.now() - 5 * 60_000;
    await confirmTotp(db, key, user.id, generateSync({ secret, epoch: Math.floor(past / 1000) }), past);
    expect(await verifySecondFactorCode(db, key, user.id, paste(generateSync({ secret })))).toBe(
      "totp",
    );
    // Non è passato per i codici di riserva.
    expect(await listSecurityEvents(db, user.id)).toEqual([]);
  });
});

describe("attemptSecondFactor", () => {
  it("se verify lancia, risale QUELL'errore e il tentativo conta come sbagliato", async () => {
    const email = `t-${randomBytes(4).toString("hex")}@example.com`;
    const [row] = await db
      .insert(users)
      .values({ email, passwordHash: "x", role: "member" })
      .returning({ id: users.id });
    const user = { id: row!.id, email };
    const boom = new Error("verify esploso");
    await expect(attemptSecondFactor(db, user, () => Promise.reject(boom))).rejects.toBe(boom);
    const [after] = await db
      .select({ n: users.secondFactorFailures })
      .from(users)
      .where(eq(users.id, user.id));
    expect(after?.n).toBe(1);
  });
});
