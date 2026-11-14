import { asc, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agentRuns, backlogItems, projects, supportFollowers, users, widgetConversations, widgetMessages } from "./schema.js";
import { expectSqlState, seedRepository, startTestDb, type TestDb } from "./testing.js";

/**
 * Migrazione 0179 (14 nov 2026, area 8, fetta 3): Support. Il codice delle
 * conversazioni (`<PRJ>-S<n>`, un contatore per progetto dato dal trigger,
 * mai riusato), il canale, il giudizio sul triage, la bozza di Claude, chi
 * segue, la richiesta nata da una conversazione, le due operazioni AI.
 */

let t: TestDb;
beforeAll(async () => {
  t = await startTestDb();
}, 120_000);
afterAll(async () => {
  await t?.stop();
});

async function conversation(projectId: string, over: Partial<typeof widgetConversations.$inferInsert> = {}) {
  const [row] = await t.db
    .insert(widgetConversations)
    .values({ projectId, externalUserId: `u-${Math.random()}`, ...over })
    .returning();
  return row!;
}

describe("0179 il codice delle conversazioni", () => {
  it("ogni conversazione nuova prende il numero dopo, per progetto; mai riusato; un numero passato è ignorato", async () => {
    const { projectId } = await seedRepository(t.db);
    const { projectId: other } = await seedRepository(t.db);
    const a = await conversation(projectId);
    const b = await conversation(projectId);
    const x = await conversation(other);
    expect([a.number, b.number, x.number]).toEqual([1, 2, 1]);
    await t.db.delete(widgetConversations).where(eq(widgetConversations.id, b.id));
    const c = await conversation(projectId, { number: 1 });
    expect(c.number).toBe(3);
    const [p] = await t.db.select({ next: projects.nextSupportNumber }).from(projects).where(eq(projects.id, projectId));
    expect(p!.next).toBe(4);
  });

  it("un numero è unico nel progetto", async () => {
    const { projectId } = await seedRepository(t.db);
    const a = await conversation(projectId);
    const b = await conversation(projectId);
    await expectSqlState(t.db.update(widgetConversations).set({ number: a.number }).where(eq(widgetConversations.id, b.id)), "23505");
  });
});

describe("0179 le colonne nuove", () => {
  it("canale `widget` di default; solo widget o mcp; il giudizio solo concluded / not_concluded", async () => {
    const { projectId } = await seedRepository(t.db);
    const c = await conversation(projectId);
    expect(c).toMatchObject({ channel: "widget", triageOutcome: null, claudeDraft: null, draftDueAt: null });
    await expectSqlState(t.db.update(widgetConversations).set({ channel: "slack" as never }).where(eq(widgetConversations.id, c.id)), "23514");
    await expectSqlState(t.db.update(widgetConversations).set({ triageOutcome: "forse" as never }).where(eq(widgetConversations.id, c.id)), "23514");
    await t.db.update(widgetConversations).set({ channel: "mcp", triageOutcome: "not_concluded" }).where(eq(widgetConversations.id, c.id));
  });

  it("chi segue (una riga per persona, via con la conversazione); la richiesta nata e il messaggio del team con l'autore", async () => {
    const { projectId } = await seedRepository(t.db);
    const c = await conversation(projectId);
    const [u] = await t.db.insert(users).values({ email: `f-${Math.random()}@x.it`, passwordHash: "x", role: "member" }).returning();
    await t.db.insert(supportFollowers).values({ conversationId: c.id, userId: u!.id });
    await expectSqlState(t.db.insert(supportFollowers).values({ conversationId: c.id, userId: u!.id }), "23505");
    const [msg] = await t.db.insert(widgetMessages).values({ conversationId: c.id, role: "team", content: "Ciao", authorId: u!.id }).returning();
    expect(msg!.authorId).toBe(u!.id);
    const [item] = await t.db.insert(backlogItems).values({ projectId, title: "R", source: "manual", supportConversationId: c.id }).returning();
    await t.db.delete(widgetConversations).where(eq(widgetConversations.id, c.id));
    expect(await t.db.select().from(supportFollowers).where(eq(supportFollowers.conversationId, c.id))).toEqual([]);
    const [after] = await t.db.select().from(backlogItems).where(eq(backlogItems.id, item!.id));
    expect(after!.supportConversationId).toBeNull();
  });

  it("le due operazioni AI di Support passano il CHECK di agent_runs", async () => {
    for (const operation of ["support_triage_check", "support_reply_draft"] as const) {
      await t.db.insert(agentRuns).values({ operation, model: "haiku" } as typeof agentRuns.$inferInsert);
    }
    const rows = await t.db.select({ op: agentRuns.operation }).from(agentRuns).orderBy(asc(agentRuns.createdAt));
    expect(rows.map((r) => r.op)).toEqual(expect.arrayContaining(["support_triage_check", "support_reply_draft"]));
    await expectSqlState(t.db.insert(agentRuns).values({ operation: "support_nulla", model: "haiku" } as never), "23514");
  });
});
