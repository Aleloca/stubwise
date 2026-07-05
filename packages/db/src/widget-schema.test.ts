import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { startTestDb, seedRepository, type TestDb } from "./testing.js";
import { tickets, widgetConversations, widgetMessages, widgetSettings } from "./schema.js";

describe("widget tables", () => {
  let testDb: TestDb;
  let projectId: string;
  beforeAll(async () => {
    testDb = await startTestDb();
    ({ projectId } = await seedRepository(testDb.db));
  }, 120_000);
  afterAll(() => testDb.stop());

  it("settings, conversazioni, messaggi", async () => {
    await testDb.db.insert(widgetSettings).values({ projectId, enabled: true });
    const [conv] = await testDb.db
      .insert(widgetConversations)
      .values({
        projectId,
        externalUserId: "u_1",
        externalUserEmail: "a@b.it",
        externalUserName: "Mario",
      })
      .returning();
    await testDb.db
      .insert(widgetMessages)
      .values({ conversationId: conv!.id, role: "user", content: "ciao" });
    const msgs = await testDb.db
      .select()
      .from(widgetMessages)
      .where(eq(widgetMessages.conversationId, conv!.id));
    expect(msgs).toHaveLength(1);
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
