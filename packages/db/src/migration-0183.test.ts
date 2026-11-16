import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agentRuns, aiModelSettings, emailMessages } from "./schema.js";
import { seedEmailMessage, startTestDb, type TestDb } from "./testing.js";

/**
 * Migrazione 0183 (15 nov 2026, area 8, «Clienti in attesa»): il giudizio
 * «serve una MIA risposta?» sul messaggio e l'operazione AI nuova.
 */

let t: TestDb;
beforeAll(async () => {
  t = await startTestDb();
}, 120_000);
afterAll(async () => {
  await t?.stop();
});

describe("0183: il giudizio sulla risposta", () => {
  it("un messaggio nasce senza giudizio e con zero tentativi; il giudizio si scrive", async () => {
    const { messageId } = await seedEmailMessage(t.db);
    const [m] = await t.db.select().from(emailMessages).where(eq(emailMessages.id, messageId));
    expect(m).toMatchObject({ replyJudgment: null, replyJudgmentAttempts: 0 });
    await t.db.update(emailMessages).set({ replyJudgment: { needsMyReply: true, reason: "chiede una data", at: new Date().toISOString() } }).where(eq(emailMessages.id, m!.id));
    const [after] = await t.db.select().from(emailMessages).where(eq(emailMessages.id, m!.id));
    expect(after!.replyJudgment).toMatchObject({ needsMyReply: true });
  });

  it("l'operazione mail_reply_judgment è ammessa nei CHECK", async () => {
    await t.db.insert(agentRuns).values({ operation: "mail_reply_judgment", model: "haiku" } as never);
    await t.db.insert(aiModelSettings).values({ operation: "mail_reply_judgment", model: "haiku" } as never);
  });
});
