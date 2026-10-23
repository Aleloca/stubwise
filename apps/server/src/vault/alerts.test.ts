import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { notificationDeliveries, users, type Db } from "@stubwise/db";
import { startTestDb, type TestDb } from "@stubwise/db/testing";
import { listInbox } from "../services/inbox.js";
import { publishVaultKeyCreated, publishVaultRecoveryUsed } from "./alerts.js";

let testDb: TestDb;
let db: Db;

async function newUser(role: "admin" | "member") {
  const email = `v-${randomBytes(4).toString("hex")}@example.com`;
  const [row] = await db
    .insert(users)
    .values({ email, passwordHash: "x", role, notifySlackDm: false })
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
beforeEach(async () => {
  await db.delete(users);
  await db.delete(notificationDeliveries);
});

describe("avvisi della cassaforte", () => {
  it("vault_recovery_used arriva a ogni altro full admin e non a chi l'ha usato né ai member", async () => {
    const actor = await newUser("admin");
    const other1 = await newUser("admin");
    const other2 = await newUser("admin");
    const member = await newUser("member");

    await publishVaultRecoveryUsed(db, actor);

    for (const other of [other1, other2]) {
      const inbox = await listInbox(db, { userId: other.id, lang: "it" });
      expect(inbox.items).toHaveLength(1);
      expect(inbox.items[0]).toMatchObject({ kind: "security.alert" });
      expect(inbox.items[0]!.text).toContain(actor.email);
    }
    expect((await listInbox(db, { userId: actor.id, lang: "it" })).items).toHaveLength(0);
    expect((await listInbox(db, { userId: member.id, lang: "it" })).items).toHaveLength(0);
  });

  it("vault_key_created arriva alla sola persona", async () => {
    const me = await newUser("admin");
    const other = await newUser("admin");
    await publishVaultKeyCreated(db, me.id);
    const mine = await listInbox(db, { userId: me.id, lang: "en" });
    expect(mine.items).toHaveLength(1);
    expect(mine.items[0]!.text).toMatch(/vault/i);
    expect((await listInbox(db, { userId: other.id, lang: "en" })).items).toHaveLength(0);
  });
});
