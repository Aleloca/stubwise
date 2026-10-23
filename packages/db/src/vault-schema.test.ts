import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "./client.js";
import {
  credentialAccessLog,
  credentialKeyCopies,
  credentialReaders,
  credentials,
  roles,
  userPasskeys,
  users,
  vaultPersonKeySeals,
  vaultPersonKeys,
  vaultSettings,
} from "./schema.js";
import { expectSqlState, seedRepository, startTestDb, type TestDb } from "./testing.js";

/**
 * Migrazione della cassaforte (0104) su un Postgres reale: i vincoli che il
 * codice dà per garantiti stanno nel DB — una sola chiave viva per utente,
 * stati chiusi, un lettore è una persona O un ruolo, riga unica delle
 * impostazioni, e le FK (cascata sulle copie, NULL sul registro).
 */
describe("schema: cassaforte delle credenziali", () => {
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
      .values({ email: `vault-${randomUUID()}@example.com`, passwordHash: "x", role: "member" })
      .returning({ id: users.id });
    return user!.id;
  }

  async function seedCredential(): Promise<{ id: string; projectId: string }> {
    const { projectId } = await seedRepository(db);
    const id = randomUUID();
    await db.insert(credentials).values({ id, projectId, service: "Hetzner", passwordCiphertext: "c" });
    return { id, projectId };
  }

  it("vault_settings: una sola riga (id = 1)", async () => {
    await db.insert(vaultSettings).values({ recoveryPublicKey: "pub" });
    await expectSqlState(db.insert(vaultSettings).values({ id: 2, recoveryPublicKey: "pub" }), "23514");
    await expectSqlState(db.insert(vaultSettings).values({ recoveryPublicKey: "pub" }), "23505");
  });

  it("vault_person_keys: nasce pending, stato fuori elenco viola il CHECK", async () => {
    const userId = await seedUser();
    const [key] = await db.insert(vaultPersonKeys).values({ userId, publicKey: "pk" }).returning();
    expect(key?.status).toBe("pending");
    await expectSqlState(
      db
        .insert(vaultPersonKeys)
        .values({ userId: await seedUser(), publicKey: "pk", status: "boh" as "pending" }),
      "23514",
    );
  });

  it("vault_person_keys: al più UNA chiave viva per utente, le superate non contano", async () => {
    const userId = await seedUser();
    const [first] = await db
      .insert(vaultPersonKeys)
      .values({ userId, publicKey: "a", status: "confirmed" })
      .returning();
    await expectSqlState(db.insert(vaultPersonKeys).values({ userId, publicKey: "b" }), "23505");
    await db.update(vaultPersonKeys).set({ status: "superseded" }).where(eq(vaultPersonKeys.id, first!.id));
    await db.insert(vaultPersonKeys).values({ userId, publicKey: "b", status: "rejected" });
    await db.insert(vaultPersonKeys).values({ userId, publicKey: "c" });
    const rows = await db.select().from(vaultPersonKeys).where(eq(vaultPersonKeys.userId, userId));
    expect(rows).toHaveLength(3);
  });

  it("vault_person_key_seals: cadono con la passkey", async () => {
    const userId = await seedUser();
    const [key] = await db.insert(vaultPersonKeys).values({ userId, publicKey: "pk" }).returning();
    const [passkey] = await db
      .insert(userPasskeys)
      .values({ userId, credentialId: randomUUID(), publicKey: "x", name: "Portatile" })
      .returning();
    await db
      .insert(vaultPersonKeySeals)
      .values({ personKeyId: key!.id, passkeyId: passkey!.id, sealedPrivateKey: "s" });
    await db.delete(userPasskeys).where(eq(userPasskeys.id, passkey!.id));
    const seals = await db
      .select()
      .from(vaultPersonKeySeals)
      .where(eq(vaultPersonKeySeals.personKeyId, key!.id));
    expect(seals).toHaveLength(0);
  });

  it("credential_readers: esattamente uno fra persona e ruolo, e niente doppioni", async () => {
    const { id: credentialId } = await seedCredential();
    const userId = await seedUser();
    const [role] = await db.select({ id: roles.id }).from(roles).where(eq(roles.presetKey, "developer"));
    await expectSqlState(db.insert(credentialReaders).values({ credentialId }), "23514");
    await expectSqlState(
      db.insert(credentialReaders).values({ credentialId, userId, roleId: role!.id }),
      "23514",
    );
    await db.insert(credentialReaders).values({ credentialId, userId });
    await db.insert(credentialReaders).values({ credentialId, roleId: role!.id });
    await expectSqlState(db.insert(credentialReaders).values({ credentialId, userId }), "23505");
    await expectSqlState(db.insert(credentialReaders).values({ credentialId, roleId: role!.id }), "23505");
  });

  it("eliminare la credenziale cancella lettori e copie, e lascia il registro con id NULL", async () => {
    const { id: credentialId, projectId } = await seedCredential();
    const userId = await seedUser();
    await db.insert(credentialReaders).values({ credentialId, userId });
    await db.insert(credentialKeyCopies).values({ credentialId, recipientId: "recovery", wrappedKey: "w" });
    const [log] = await db
      .insert(credentialAccessLog)
      .values({
        credentialId,
        projectId,
        credentialSnapshot: "Hetzner · principale · root",
        userId,
        userEmail: "x@example.com",
        action: "show",
      })
      .returning();
    await expectSqlState(
      db.insert(credentialAccessLog).values({
        projectId,
        credentialSnapshot: "s",
        userEmail: "x@example.com",
        action: "edit" as "show",
      }),
      "23514",
    );
    await db.delete(credentials).where(eq(credentials.id, credentialId));
    expect(
      await db.select().from(credentialReaders).where(eq(credentialReaders.credentialId, credentialId)),
    ).toHaveLength(0);
    expect(
      await db.select().from(credentialKeyCopies).where(eq(credentialKeyCopies.credentialId, credentialId)),
    ).toHaveLength(0);
    const [after] = await db.select().from(credentialAccessLog).where(eq(credentialAccessLog.id, log!.id));
    expect(after?.credentialId).toBeNull();
    expect(after?.credentialSnapshot).toBe("Hetzner · principale · root");
  });
});
