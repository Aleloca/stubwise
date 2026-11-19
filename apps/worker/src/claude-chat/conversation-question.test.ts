import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { agentSessionEvents, agentSessions, claudeConversationQuestions, claudeConversations, users } from "@stubwise/db";
import { startTestDb, type TestDb } from "@stubwise/db/testing";
import { askConversationQuestion } from "./conversation-question.js";

/**
 * Area 10, F2, Task 3: `ask_question` nella conversazione libera. UNA domanda
 * per turno, l'evento `question` con il solo id, mai in un turno di @Claude
 * (la sua domanda sta sul messaggio del canale) né in una conversazione chiusa.
 */
let t: TestDb;
let ownerId: string;
beforeAll(async () => {
  t = await startTestDb();
  const [u] = await t.db.insert(users).values({ email: `cq-${randomUUID().slice(0, 6)}@x.test`, passwordHash: "x", role: "member" }).returning();
  ownerId = u!.id;
}, 120_000);
afterAll(async () => {
  await t?.stop();
});

async function conversation(kind: "free" | "chat_mention" = "free"): Promise<string> {
  const [s] = await t.db.insert(agentSessions).values({ ownerKey: `${kind}:${randomUUID()}`, kind, title: "t" }).returning();
  await t.db.insert(claudeConversations).values({ sessionId: s!.id, ownerId, title: "t" });
  return s!.id;
}
const question = { question: "Quale reparto avviso?", options: [{ label: "Vendite" }, { label: "Supporto", description: "Il team del supporto" }] };

describe("ask_question nella conversazione libera", () => {
  it("scrive la domanda e l'evento `question` col solo id; la domanda punta al suo evento", async () => {
    const sid = await conversation();
    const res = await askConversationQuestion(t.db, sid, randomUUID(), question);
    expect(res.ok).toBe(true);
    expect(res.text).toMatch(/End your turn/);
    const [q] = await t.db.select().from(claudeConversationQuestions).where(eq(claudeConversationQuestions.sessionId, sid));
    expect(q).toMatchObject({ text: "Quale reparto avviso?", options: question.options, answeredAt: null });
    const [e] = await t.db.select().from(agentSessionEvents).where(and(eq(agentSessionEvents.sessionId, sid), eq(agentSessionEvents.type, "question")));
    expect(e!.data).toEqual({ questionId: q!.id });
    expect(q!.eventId).toBe(e!.id);
  });

  it("UNA per turno: la seconda nello stesso turno è rifiutata e non scrive niente; il turno dopo ne fa un'altra", async () => {
    const sid = await conversation();
    const input = randomUUID();
    expect((await askConversationQuestion(t.db, sid, input, question)).ok).toBe(true);
    const again = await askConversationQuestion(t.db, sid, input, { ...question, question: "E l'urgenza?" });
    expect(again).toMatchObject({ ok: false });
    expect(again.text).toMatch(/already asked/);
    expect(await t.db.select().from(agentSessionEvents).where(and(eq(agentSessionEvents.sessionId, sid), eq(agentSessionEvents.type, "question")))).toHaveLength(1);
    expect((await askConversationQuestion(t.db, sid, randomUUID(), question)).ok).toBe(true);
  });

  it("testo e opzioni con la regola della Chat: meno di due opzioni, o un'opzione senza etichetta, rifiutata", async () => {
    const sid = await conversation();
    expect(await askConversationQuestion(t.db, sid, randomUUID(), { question: "x", options: [{ label: "solo" }] })).toMatchObject({ ok: false });
    expect(await askConversationQuestion(t.db, sid, randomUUID(), { question: "x", options: [{ label: "a" }, { description: "b" }] })).toMatchObject({ ok: false });
    expect(await t.db.select().from(claudeConversationQuestions).where(eq(claudeConversationQuestions.sessionId, sid))).toEqual([]);
  });

  it("mai in un turno di @Claude nella Chat, né in una conversazione archiviata", async () => {
    const mention = await conversation("chat_mention");
    expect(await askConversationQuestion(t.db, mention, randomUUID(), question)).toMatchObject({ ok: false });
    const archived = await conversation();
    await t.db.update(claudeConversations).set({ archivedAt: new Date() }).where(eq(claudeConversations.sessionId, archived));
    expect(await askConversationQuestion(t.db, archived, randomUUID(), question)).toMatchObject({ ok: false });
    expect(await t.db.select().from(claudeConversationQuestions).where(eq(claudeConversationQuestions.sessionId, mention))).toEqual([]);
  });
});
