import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { alertSubscriptions, users } from "./schema.js";
import { seedRepository, startTestDb, type TestDb } from "./testing.js";

/**
 * Migrazione 0212 (21 nov 2026, area 11, F5): il CHECK del tipo di
 * un'iscrizione ammette il trattino basso nel PRIMO segmento. Prima
 * (`^[a-z]+(\.[a-z_]+)+$`, 0177) un'iscrizione `product_doc.*` non si poteva
 * scrivere: le Preferenze non potevano accendere né spegnere la riga della
 * doc di prodotto.
 */

let t: TestDb;
beforeAll(async () => {
  t = await startTestDb();
}, 120_000);
afterAll(async () => {
  await t?.stop();
});

describe("0212: il tipo di un'iscrizione", () => {
  it("`product_doc.updated` e `product_doc.question` si scrivono; un tipo malformato no", async () => {
    const { projectId } = await seedRepository(t.db);
    const [u] = await t.db.insert(users).values({ email: "sub-0212@x.test", passwordHash: "x", role: "member" }).returning({ id: users.id });
    for (const alertType of ["product_doc.updated", "product_doc.question", "pr.opened"]) {
      await t.db.insert(alertSubscriptions).values({ userId: u!.id, projectId, alertType, app: true, phone: false });
    }
    for (const bad of ["Product.updated", "_x.y", "product_doc", "product_doc.", "a..b"]) {
      await expect(t.db.execute(sql`insert into alert_subscriptions (user_id, project_id, alert_type, app, phone) values (${u!.id}, ${projectId}, ${bad}, true, false)`), bad).rejects.toThrow();
    }
  });
});
