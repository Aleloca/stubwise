import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "./client.js";
import {
  securityEvents,
  sessions,
  userBackupCodes,
  userPasskeys,
  userTotp,
  users,
} from "./schema.js";
import { expectSqlState, startTestDb, type TestDb } from "./testing.js";

/**
 * Verifica che la migrazione del secondo fattore (0100) sia applicabile su un
 * Postgres reale: lo stadio della sessione coi suoi default e il CHECK, il
 * contatore dei tentativi sull'utente, le tabelle di TOTP, codici di riserva,
 * passkey e registro di sicurezza con le loro FK (utente in cascata per le
 * credenziali, a NULL per il registro, che deve sopravvivere all'utente).
 */
describe("schema: secondo fattore", () => {
  let testDb: TestDb;
  let db: Db;

  beforeAll(async () => {
    testDb = await startTestDb();
    db = testDb.db;
  });

  afterAll(async () => {
    await testDb.stop();
  });

  async function seedUser(): Promise<string> {
    const [user] = await db
      .insert(users)
      .values({ email: `sf-${randomUUID()}@example.com`, passwordHash: "x", role: "member" })
      .returning();
    if (!user) throw new Error("insert dell'utente non ha restituito la riga");
    return user.id;
  }

  it("users: contatore dei tentativi a 0 e nessun blocco di default", async () => {
    const userId = await seedUser();
    const [user] = await db.select().from(users).where(eq(users.id, userId));
    expect(user?.secondFactorFailures).toBe(0);
    expect(user?.secondFactorLockedUntil).toBeNull();
    // 0102: nessuna prenotazione di tentativo all'inizio.
    expect(user?.secondFactorReservedAt).toBeNull();
  });

  it("sessions: una riga senza colonne nuove è `full`, senza secondo fattore né challenge", async () => {
    const userId = await seedUser();
    const id = randomUUID();
    await db.insert(sessions).values({ id, userId, expiresAt: new Date(Date.now() + 60_000) });
    const [row] = await db.select().from(sessions).where(eq(sessions.id, id));
    expect(row?.stage).toBe("full");
    expect(row?.secondFactorAt).toBeNull();
    expect(row?.webauthnChallenge).toBeNull();
    expect(row?.createdAt).toBeInstanceOf(Date);
  });

  it("sessions: uno stadio fuori elenco viola il CHECK", async () => {
    const userId = await seedUser();
    await expectSqlState(
      db.insert(sessions).values({
        id: randomUUID(),
        userId,
        expiresAt: new Date(Date.now() + 60_000),
        stage: "half" as "full",
      }),
      "23514",
    );
  });

  it("user_totp: segreto confermato e in attesa entrambi nullable; cascata sull'utente", async () => {
    const userId = await seedUser();
    await db.insert(userTotp).values({ userId, pendingSecretEncrypted: "pending" });
    const [row] = await db.select().from(userTotp).where(eq(userTotp.userId, userId));
    expect(row?.secretEncrypted).toBeNull();
    expect(row?.pendingSecretEncrypted).toBe("pending");
    expect(row?.confirmedAt).toBeNull();
    expect(row?.lastUsedStep).toBeNull();
    await db.delete(users).where(eq(users.id, userId));
    expect(await db.select().from(userTotp).where(eq(userTotp.userId, userId))).toEqual([]);
  });

  it("user_backup_codes: l'hash è unico", async () => {
    const userId = await seedUser();
    const codeHash = `h-${randomUUID()}`;
    await db.insert(userBackupCodes).values({ userId, codeHash });
    await expectSqlState(db.insert(userBackupCodes).values({ userId, codeHash }), "23505");
  });

  it("user_passkeys: default di counter e transports, credential id unico", async () => {
    const userId = await seedUser();
    const credentialId = `cred-${randomUUID()}`;
    const [row] = await db
      .insert(userPasskeys)
      .values({ userId, credentialId, publicKey: "pk", name: "MacBook" })
      .returning();
    expect(row?.counter).toBe(0);
    expect(row?.transports).toEqual([]);
    expect(row?.lastUsedAt).toBeNull();
    await expectSqlState(
      db.insert(userPasskeys).values({ userId, credentialId, publicKey: "pk", name: "x" }),
      "23505",
    );
  });

  it("security_events: la riga sopravvive all'utente, con l'email in testo", async () => {
    const userId = await seedUser();
    const actorId = await seedUser();
    const [event] = await db
      .insert(securityEvents)
      .values({
        userId,
        userEmail: "vittima@example.com",
        actorUserId: actorId,
        actorEmail: "admin@example.com",
        kind: "login",
      })
      .returning();
    await db.delete(users).where(eq(users.id, userId));
    await db.delete(users).where(eq(users.id, actorId));
    const [row] = await db.select().from(securityEvents).where(eq(securityEvents.id, event!.id));
    expect(row?.userId).toBeNull();
    expect(row?.actorUserId).toBeNull();
    expect(row?.userEmail).toBe("vittima@example.com");
    expect(row?.actorEmail).toBe("admin@example.com");
  });
});
