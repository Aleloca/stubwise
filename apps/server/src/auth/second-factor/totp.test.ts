import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generateSync } from "otplib";
import { eq } from "drizzle-orm";
import { userTotp, users, type Db } from "@stubwise/db";
import { startTestDb, type TestDb } from "@stubwise/db/testing";
import { confirmTotp, hasConfirmedTotp, startTotpEnrollment, verifyTotp } from "./totp.js";

let testDb: TestDb;
let db: Db;
const key = randomBytes(32);
const NOW = 1_800_000_000_000; // fisso: i test pilotano il tempo passando `nowMs`

function code(secret: string, offsetSteps = 0): string {
  return generateSync({ secret, epoch: Math.floor(NOW / 1000 / 30) * 30 + offsetSteps * 30 });
}

async function newUser(): Promise<{ id: string; email: string }> {
  const email = `u-${randomBytes(4).toString("hex")}@example.com`;
  const [row] = await db
    .insert(users)
    .values({ email, passwordHash: "x", role: "member" })
    .returning({ id: users.id });
  return { id: row!.id, email };
}

/** Utente con TOTP confermato al tempo NOW; ritorna il segreto. */
async function enrolled(): Promise<{ user: { id: string; email: string }; secret: string }> {
  const user = await newUser();
  const { secret } = await startTotpEnrollment(db, key, user);
  expect(await confirmTotp(db, key, user.id, code(secret), NOW)).toBe(true);
  return { user, secret };
}

beforeAll(async () => {
  testDb = await startTestDb();
  db = testDb.db;
}, 120_000);

afterAll(async () => {
  await testDb.stop();
});

describe("totp", () => {
  it("un codice valido passa una volta sola: lo stesso codice subito dopo è rifiutato", async () => {
    const { user, secret } = await enrolled();
    // Il passo della conferma è già consumato: serve un passo nuovo.
    const c = code(secret, 1);
    expect(await verifyTotp(db, key, user.id, c, NOW)).toBe(true);
    expect(await verifyTotp(db, key, user.id, c, NOW)).toBe(false);
  });

  it("il codice usato per confermare non vale subito dopo al login", async () => {
    const user = await newUser();
    const { secret } = await startTotpEnrollment(db, key, user);
    expect(await confirmTotp(db, key, user.id, code(secret), NOW)).toBe(true);
    expect(await verifyTotp(db, key, user.id, code(secret), NOW)).toBe(false);
  });

  it("un codice del passo precedente passa, di due passi fa no", async () => {
    const { user, secret } = await enrolled();
    // Il passo corrente della conferma è consumato; avanziamo il tempo di 3 passi.
    const later = NOW + 3 * 30_000;
    expect(await verifyTotp(db, key, user.id, code(secret, 0), later)).toBe(false); // 3 passi fa
    expect(await verifyTotp(db, key, user.id, code(secret, 1), later)).toBe(false); // 2 passi fa
    expect(await verifyTotp(db, key, user.id, code(secret, 2), later)).toBe(true); // passo precedente
  });

  it("un codice sbagliato è rifiutato e non consuma il passo", async () => {
    const { user, secret } = await enrolled();
    const good = code(secret, 1);
    const bad = good === "000000" ? "000001" : "000000";
    expect(await verifyTotp(db, key, user.id, bad, NOW)).toBe(false);
    expect(await verifyTotp(db, key, user.id, good, NOW)).toBe(true);
  });

  it("una riga non confermata non verifica nulla", async () => {
    const user = await newUser();
    const { secret } = await startTotpEnrollment(db, key, user);
    expect(await verifyTotp(db, key, user.id, code(secret), NOW)).toBe(false);
    expect(await hasConfirmedTotp(db, user.id)).toBe(false);
    // Senza riga affatto.
    expect(await verifyTotp(db, key, (await newUser()).id, "123456", NOW)).toBe(false);
  });

  it("confermare con un codice sbagliato non conferma", async () => {
    const user = await newUser();
    const { secret } = await startTotpEnrollment(db, key, user);
    const good = code(secret);
    expect(await confirmTotp(db, key, user.id, good === "000000" ? "000001" : "000000", NOW)).toBe(
      false,
    );
    expect(await hasConfirmedTotp(db, user.id)).toBe(false);
  });

  it("con un TOTP confermato, una nuova enrollment non invalida il vecchio finché non è confermata, e dopo la conferma vale solo il nuovo", async () => {
    const { user, secret: oldSecret } = await enrolled();
    const { secret: newSecret } = await startTotpEnrollment(db, key, user);
    expect(newSecret).not.toBe(oldSecret);
    expect(await hasConfirmedTotp(db, user.id)).toBe(true);
    // Il vecchio vale ancora, il nuovo non ancora.
    expect(await verifyTotp(db, key, user.id, code(newSecret, 1), NOW)).toBe(false);
    expect(await verifyTotp(db, key, user.id, code(oldSecret, 1), NOW)).toBe(true);
    // Si conferma il nuovo (un passo più avanti del vecchio consumato).
    expect(await confirmTotp(db, key, user.id, code(newSecret, 2), NOW + 60_000)).toBe(true);
    // Ora vale solo il nuovo.
    expect(await verifyTotp(db, key, user.id, code(oldSecret, 3), NOW + 3 * 30_000)).toBe(false);
    expect(await verifyTotp(db, key, user.id, code(newSecret, 3), NOW + 3 * 30_000)).toBe(true);
  });

  it("il DB non contiene il segreto in chiaro", async () => {
    const user = await newUser();
    const { secret, otpauthUrl } = await startTotpEnrollment(db, key, user);
    const [row] = await db.select().from(userTotp).where(eq(userTotp.userId, user.id));
    expect(row!.pendingSecretEncrypted).not.toContain(secret);
    expect(row!.pendingSecretEncrypted).toBeTruthy();
    expect(otpauthUrl).toMatch(/^otpauth:\/\/totp\/Stubwise:/);
    expect(otpauthUrl).toContain("issuer=Stubwise");
    await confirmTotp(db, key, user.id, code(secret), NOW);
    const [after] = await db.select().from(userTotp).where(eq(userTotp.userId, user.id));
    expect(after!.secretEncrypted).not.toContain(secret);
    expect(after!.pendingSecretEncrypted).toBeNull();
  });
});
