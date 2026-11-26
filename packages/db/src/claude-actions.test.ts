import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { seedTicket, startTestDb, type TestDb } from "./testing.js";
import { agentSessions, claudeActionGroups, claudeActions, comments, ticketEvents, users, VIA_CLAUDE_SETTING } from "./schema.js";

// Il segno «via Claude» (chat, fetta 3): è il DEFAULT delle colonne, letto da
// una variabile di TRANSAZIONE che solo l'esecutore delle azioni imposta.
// Nessun writer lo passa; fuori da quella transazione vale null.

let t: TestDb;
let userId: string;
let ticketId: string;
beforeAll(async () => {
  t = await startTestDb();
  ({ ticketId } = await seedTicket(t.db));
  const [u] = await t.db.insert(users).values({ email: "via@x.test", passwordHash: "x", role: "member" }).returning();
  userId = u!.id;
}, 120_000);
afterAll(async () => {
  await t.stop();
});

async function action(): Promise<string> {
  const [g] = await t.db.insert(claudeActionGroups).values({ requesterId: userId }).returning();
  const [a] = await t.db.insert(claudeActions).values({ groupId: g!.id, seq: 0, fn: "updateTask", args: {}, cls: "A" }).returning();
  return a!.id;
}

describe("il segno «via Claude»", () => {
  it("dentro la transazione dell'esecutore le scritture lo portano da sole; fuori no, e non sopravvive al commit", async () => {
    const actionId = await action();
    await t.db.transaction(async (tx) => {
      await tx.execute(sql`select set_config(${VIA_CLAUDE_SETTING}, ${actionId}, true)`);
      await tx.insert(ticketEvents).values({ ticketId, actorId: userId, kind: "title_changed", payload: { via: true } });
      // Anche dentro un savepoint (un servizio che apre la sua transazione).
      await tx.transaction(async (inner) => {
        await inner.insert(comments).values({ ticketId, authorType: "user", authorId: userId, body: "via" });
      });
    });
    await t.db.insert(ticketEvents).values({ ticketId, actorId: userId, kind: "title_changed", payload: { via: false } });
    const events = await t.db.select().from(ticketEvents).where(eq(ticketEvents.ticketId, ticketId));
    expect(events.find((e) => (e.payload as { via: boolean }).via === true)!.viaClaudeActionId).toBe(actionId);
    expect(events.find((e) => (e.payload as { via: boolean }).via === false)!.viaClaudeActionId).toBeNull();
    const [comment] = await t.db.select().from(comments).where(eq(comments.body, "via"));
    expect(comment!.viaClaudeActionId).toBe(actionId);
  });

  it("le azioni restano quando la sessione si pota (session_id SET NULL), il segno resta", async () => {
    const [session] = await t.db
      .insert(agentSessions)
      .values({ ownerKey: `free:${crypto.randomUUID()}`, kind: "free", title: "t" })
      .returning();
    const [g] = await t.db.insert(claudeActionGroups).values({ requesterId: userId, sessionId: session!.id }).returning();
    const [a] = await t.db.insert(claudeActions).values({ groupId: g!.id, seq: 0, fn: "updateTask", args: {}, cls: "A" }).returning();
    await t.db.delete(agentSessions).where(eq(agentSessions.id, session!.id));
    const [group] = await t.db.select().from(claudeActionGroups).where(eq(claudeActionGroups.id, g!.id));
    expect(group).toMatchObject({ sessionId: null });
    expect(await t.db.select().from(claudeActions).where(eq(claudeActions.id, a!.id))).toHaveLength(1);
  });
});
