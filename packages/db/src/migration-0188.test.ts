import { readFileSync } from "node:fs";
import { join } from "node:path";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { notificationDeliveries, notificationSettings, outgoingWebhooks } from "./schema.js";
import { startTestDb, type TestDb } from "./testing.js";

/**
 * Migrazione 0188 (area 9, F3): i webhook in uscita. Il passaggio dei dati da
 * `notification_settings` si prova rieseguendo la sua INSERT sullo stato
 * voluto (la migrazione è già girata all'avvio del DB di test, a tabella vuota).
 */

let t: TestDb;
const migrationInsert = () => {
  const sqlText = readFileSync(join(import.meta.dirname, "../drizzle/0188_outgoing_webhooks.sql"), "utf8");
  return sqlText.slice(sqlText.indexOf('INSERT INTO "outgoing_webhooks"')).trim();
};

beforeAll(async () => {
  t = await startTestDb();
}, 120_000);
afterAll(async () => {
  await t?.stop();
});

describe("0188: i webhook in uscita", () => {
  it("il webhook di oggi diventa il primo, coi soli eventi accesi e senza segreto; una seconda volta non fa niente", async () => {
    await t.db.delete(outgoingWebhooks);
    await t.db
      .insert(notificationSettings)
      .values({ id: 1, webhookUrl: "https://hooks.example.com/x", format: "discord", enabled: true, notifyTicketCreated: true, notifyPrOpened: false, notifyMonitor: true })
      .onConflictDoUpdate({ target: notificationSettings.id, set: { webhookUrl: "https://hooks.example.com/x", format: "discord", enabled: true, notifyTicketCreated: true, notifyPrOpened: false, notifyMonitor: true } });
    await t.db.update(notificationSettings).set({
      notifyJobHeld: false, notifyJobFailed: false, notifyPrClosed: false, notifyPlanReview: false, notifyBudgetHeld: false,
      notifyReviewCompleted: false, notifyDocsLimitPaused: false, notifyAwaitingInput: false, notifyPulse: false, notifyBrief: false,
    });
    await t.db.execute(sql.raw(migrationInsert()));
    const rows = await t.db.select().from(outgoingWebhooks);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ name: "Webhook", url: "https://hooks.example.com/x", format: "discord", enabled: true, secretEncrypted: null });
    expect(rows[0]!.events.sort()).toEqual(["monitor", "ticket.created"]);
    await t.db.execute(sql.raw(migrationInsert()));
    expect(await t.db.select().from(outgoingWebhooks)).toHaveLength(1);
  });

  it("senza URL non nasce niente", async () => {
    await t.db.delete(outgoingWebhooks);
    await t.db.update(notificationSettings).set({ webhookUrl: null });
    await t.db.execute(sql.raw(migrationInsert()));
    expect(await t.db.select().from(outgoingWebhooks)).toHaveLength(0);
  });

  it("un evento fuori catalogo è rifiutato; eliminare un webhook porta via le sue consegne", async () => {
    await expect(t.db.insert(outgoingWebhooks).values({ name: "x", url: "https://e.example.com", events: ["chat.mention"] })).rejects.toThrow();
    const [w] = await t.db.insert(outgoingWebhooks).values({ name: "y", url: "https://e.example.com", events: ["job.failed"] }).returning();
    await t.db.insert(notificationDeliveries).values({ channel: "webhook", event: { kind: "job.failed" }, webhookId: w!.id });
    await t.db.delete(outgoingWebhooks).where(eq(outgoingWebhooks.id, w!.id));
    expect(await t.db.select().from(notificationDeliveries).where(eq(notificationDeliveries.webhookId, w!.id))).toHaveLength(0);
  });
});
