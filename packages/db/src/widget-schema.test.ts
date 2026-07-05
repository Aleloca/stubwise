import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { startTestDb, seedRepository, type TestDb } from "./testing.js";
import { tickets, widgetConversations, widgetMessages, widgets } from "./schema.js";

describe("widget tables", () => {
  let testDb: TestDb;
  let projectId: string;
  beforeAll(async () => {
    testDb = await startTestDb();
    ({ projectId } = await seedRepository(testDb.db));
  }, 120_000);
  afterAll(() => testDb.stop());

  it("più widget nello stesso progetto, conversazione con widgetId", async () => {
    const [w1] = await testDb.db
      .insert(widgets)
      .values({ projectId, name: "Sito", key: "k_sito_" + crypto.randomUUID(), enabled: true })
      .returning();
    const [w2] = await testDb.db
      .insert(widgets)
      .values({ projectId, name: "App", key: "k_app_" + crypto.randomUUID() })
      .returning();
    expect(w1!.id).not.toBe(w2!.id);

    const [conv] = await testDb.db
      .insert(widgetConversations)
      .values({
        projectId,
        widgetId: w1!.id,
        externalUserId: "u_1",
        externalUserEmail: "a@b.it",
        externalUserName: "Mario",
      })
      .returning();
    expect(conv!.widgetId).toBe(w1!.id);

    await testDb.db
      .insert(widgetMessages)
      .values({ conversationId: conv!.id, role: "user", content: "ciao" });
    const msgs = await testDb.db
      .select()
      .from(widgetMessages)
      .where(eq(widgetMessages.conversationId, conv!.id));
    expect(msgs).toHaveLength(1);
  });

  it("key duplicata → throw (unique)", async () => {
    const key = "k_dup_" + crypto.randomUUID();
    await testDb.db.insert(widgets).values({ projectId, name: "Primo", key });
    await expect(
      testDb.db.insert(widgets).values({ projectId, name: "Secondo", key }),
    ).rejects.toThrow();
  });

  it("delete del widget → conversation.widget_id set null, messaggi intatti", async () => {
    const [w] = await testDb.db
      .insert(widgets)
      .values({ projectId, name: "Temp", key: "k_temp_" + crypto.randomUUID() })
      .returning();
    const [conv] = await testDb.db
      .insert(widgetConversations)
      .values({ projectId, widgetId: w!.id, externalUserId: "u_del" })
      .returning();
    const [msg] = await testDb.db
      .insert(widgetMessages)
      .values({ conversationId: conv!.id, role: "user", content: "storico" })
      .returning();

    // Eliminato il widget, la FK set-null azzera widget_id sulla conversazione
    // senza cancellarla; lo storico dei messaggi resta integro.
    await testDb.db.delete(widgets).where(eq(widgets.id, w!.id));
    const [afterConv] = await testDb.db
      .select()
      .from(widgetConversations)
      .where(eq(widgetConversations.id, conv!.id));
    expect(afterConv).toBeDefined();
    expect(afterConv!.widgetId).toBeNull();
    const [afterMsg] = await testDb.db
      .select()
      .from(widgetMessages)
      .where(eq(widgetMessages.id, msg!.id));
    expect(afterMsg).toBeDefined();
    expect(afterMsg!.content).toBe("storico");
  });

  it("ticket_source accetta widget", async () => {
    const [t] = await testDb.db
      .insert(tickets)
      .values({ projectId, number: 900, title: "t", type: "bug", priority: "medium", source: "widget" })
      .returning();
    expect(t!.source).toBe("widget");
  });

  it("delete del ticket → widget_messages.ticket_id set null (FK on delete set null)", async () => {
    const [conv] = await testDb.db
      .insert(widgetConversations)
      .values({ projectId, externalUserId: "u_2" })
      .returning();
    const [ticket] = await testDb.db
      .insert(tickets)
      .values({ projectId, number: 901, title: "t", type: "bug", priority: "medium", source: "widget" })
      .returning();
    const [msg] = await testDb.db
      .insert(widgetMessages)
      .values({ conversationId: conv!.id, role: "assistant", content: "risposta", ticketId: ticket!.id })
      .returning();
    expect(msg!.ticketId).toBe(ticket!.id);

    // Eliminato il ticket, la FK set-null azzera il riferimento senza cancellare
    // il messaggio (lo storico della conversazione resta integro).
    await testDb.db.delete(tickets).where(eq(tickets.id, ticket!.id));
    const [after] = await testDb.db
      .select()
      .from(widgetMessages)
      .where(eq(widgetMessages.id, msg!.id));
    expect(after).toBeDefined();
    expect(after!.ticketId).toBeNull();
  });
});
