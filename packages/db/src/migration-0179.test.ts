import { asc, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agentRuns, backlogItems, projects, users, widgetConversations, widgetMessages, widgets } from "./schema.js";
import { expectSqlState, seedRepository, startTestDb, type TestDb } from "./testing.js";

/**
 * Migrazione 0179 (14 nov 2026, area 8, fetta 3): Support. Il codice delle
 * conversazioni (`<PRJ>-S<n>`, un contatore per progetto dato dal trigger,
 * mai riusato), il canale, il giudizio sul triage, la successiva di una
 * chiusa, i siti ammessi del widget, la richiesta nata da una conversazione,
 * l'operazione AI. La premessa (maintainer, 14 nov 2026): niente bozza di
 * Claude, niente «Segui», niente `support.customer_replied`.
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
    expect(c).toMatchObject({ channel: "widget", triageOutcome: null, continuedInId: null });
    await expectSqlState(t.db.update(widgetConversations).set({ channel: "slack" as never }).where(eq(widgetConversations.id, c.id)), "23514");
    await expectSqlState(t.db.update(widgetConversations).set({ triageOutcome: "forse" as never }).where(eq(widgetConversations.id, c.id)), "23514");
    await t.db.update(widgetConversations).set({ channel: "mcp", triageOutcome: "not_concluded" }).where(eq(widgetConversations.id, c.id));
  });

  it("la successiva di una chiusa: via la successiva, la chiusa resta senza", async () => {
    const { projectId } = await seedRepository(t.db);
    const closed = await conversation(projectId);
    const next = await conversation(projectId);
    await t.db.update(widgetConversations).set({ continuedInId: next.id }).where(eq(widgetConversations.id, closed.id));
    await t.db.delete(widgetConversations).where(eq(widgetConversations.id, next.id));
    const [after] = await t.db.select().from(widgetConversations).where(eq(widgetConversations.id, closed.id));
    expect(after!.continuedInId).toBeNull();
  });

  it("i siti ammessi del widget: vuoti di default", async () => {
    const { projectId } = await seedRepository(t.db);
    const [w] = await t.db.insert(widgets).values({ projectId, name: "W", key: `k-${Math.random()}` }).returning();
    expect(w!.allowedOrigins).toEqual([]);
    const [set] = await t.db.update(widgets).set({ allowedOrigins: ["https://a.com"] }).where(eq(widgets.id, w!.id)).returning();
    expect(set!.allowedOrigins).toEqual(["https://a.com"]);
  });

  it("la richiesta nata e il messaggio del team con l'autore", async () => {
    const { projectId } = await seedRepository(t.db);
    const c = await conversation(projectId);
    const [u] = await t.db.insert(users).values({ email: `f-${Math.random()}@x.it`, passwordHash: "x", role: "member" }).returning();
    const [msg] = await t.db.insert(widgetMessages).values({ conversationId: c.id, role: "team", content: "Ciao", authorId: u!.id }).returning();
    expect(msg!.authorId).toBe(u!.id);
    const [item] = await t.db.insert(backlogItems).values({ projectId, title: "R", source: "manual", supportConversationId: c.id }).returning();
    await t.db.delete(widgetConversations).where(eq(widgetConversations.id, c.id));
    const [after] = await t.db.select().from(backlogItems).where(eq(backlogItems.id, item!.id));
    expect(after!.supportConversationId).toBeNull();
  });

  it("l'operazione AI di Support passa il CHECK di agent_runs; quella della bozza no", async () => {
    await t.db.insert(agentRuns).values({ operation: "support_triage_check", model: "haiku" } as typeof agentRuns.$inferInsert);
    const rows = await t.db.select({ op: agentRuns.operation }).from(agentRuns).orderBy(asc(agentRuns.createdAt));
    expect(rows.map((r) => r.op)).toContain("support_triage_check");
    await expectSqlState(t.db.insert(agentRuns).values({ operation: "support_reply_draft", model: "haiku" } as never), "23514");
  });

  it("nessuna traccia di ciò che la premessa corretta ha tolto", async () => {
    const cols = await t.db.execute<{ column_name: string }>(
      sql`select column_name from information_schema.columns where table_name = 'widget_conversations' and column_name like '%draft%'`,
    );
    expect(cols).toHaveLength(0);
    const tables = await t.db.execute(sql`select 1 from information_schema.tables where table_name = 'support_followers'`);
    expect(tables).toHaveLength(0);
    const kinds = await t.db.execute(sql`select 1 from pg_enum where enumlabel = 'support.customer_replied'`);
    expect(kinds).toHaveLength(0);
  });
});
