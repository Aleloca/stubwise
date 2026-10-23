import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { notificationDeliveries, users, type Db } from "@stubwise/db";
import { startTestDb, type TestDb } from "@stubwise/db/testing";
import { listInbox } from "../../services/inbox.js";
import { publishSecurityAlert } from "./alerts.js";

let testDb: TestDb;
let db: Db;

async function newUser(role: "admin" | "member", prefs: { notifyPush?: boolean; slack?: boolean } = {}) {
  const email = `a-${randomBytes(4).toString("hex")}@example.com`;
  const [row] = await db
    .insert(users)
    .values({
      email,
      passwordHash: "x",
      role,
      notifyPush: prefs.notifyPush ?? true,
      notifySlackDm: false,
      slackUserId: prefs.slack ? `U${randomBytes(4).toString("hex")}` : null,
    })
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

describe("publishSecurityAlert", () => {
  it("la card compare nell'inbox del solo interessato, con la frase che nomina chi ha agito", async () => {
    const target = await newUser("member");
    const admin = await newUser("admin");

    await publishSecurityAlert(db, target.id, "second_factor_reset", admin.email);

    const mine = await listInbox(db, { userId: target.id, lang: "it" });
    expect(mine.items).toHaveLength(1);
    expect(mine.items[0]).toMatchObject({ kind: "security.alert", projectId: null });
    expect(mine.items[0]!.text).toContain(`azzerato da ${admin.email}`);
    // Nessun link: l'avviso si legge in inbox.
    expect(mine.items[0]!.url).toBeUndefined();

    // L'admin non la vede: l'avviso non va mai agli admin per ruolo.
    expect((await listInbox(db, { userId: admin.id, lang: "it" })).items).toHaveLength(0);
  });

  it("senza attore la frase non nomina nessuno", async () => {
    const target = await newUser("member");

    await publishSecurityAlert(db, target.id, "locked", null);

    const [item] = (await listInbox(db, { userId: target.id, lang: "en" })).items;
    expect(item?.text).toMatch(/locked for 15 minutes/);
    expect(item?.text).not.toMatch(/ by /);
  });

  it("ignora le preferenze: con Slack collegato e il DM spento, il DM nasce comunque", async () => {
    const target = await newUser("member", { notifyPush: false, slack: true });

    await publishSecurityAlert(db, target.id, "backup_codes_regenerated", null);

    // Nessun device: nessuna push (il recapito resta un requisito); identità
    // Slack presente col DM spento: il DM sì.
    const deliveries = await db.select().from(notificationDeliveries);
    expect(deliveries.map((d) => d.channel)).toEqual(["slack_dm"]);
  });
});
